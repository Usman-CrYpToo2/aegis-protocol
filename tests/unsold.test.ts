/**
 * The issuer's unsold stock, and why the bridge never waits for it.
 *
 * `finalize_graduation` used to send the unsold Real RWA straight to the issuer, which needed the
 * issuer to be a registered holder. It is also the only instruction that opens the bridge. So an
 * issuer who removed their own registration — they hold WalletsAdmin — never registered, or lost
 * their wallet, kept the bridge shut forever, and no cRWA holder could ever redeem.
 *
 * Now settlement only records what the issuer is owed (`issuer_unsold`) and leaves the asset in
 * the vault. The issuer collects it with `claim_unsold` whenever they are registered. That claim
 * may only take what the vault holds above the cRWA supply, so holders are always covered first.
 */
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import { Env, expectAnchorError, expectFailure, expectSuccess } from "./helpers";
import { graduatedLaunch, registerHolder } from "./fixtures";
import * as upside from "./upside";

const INVESTOR_GROUP = upside.DEFAULT_LAYOUT.investorGroup;
/** The fixture registers the issuer as holder 1 and nobody else. */
const ISSUER_HOLDER_ID = 1;
const BUYER_HOLDER_ID = 2;

function balance(env: Env, account: PublicKey): bigint {
  const acc = env.svm.getAccount(account);
  if (!acc) return 0n;
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

/** `supply` sits at byte 36 of every SPL mint. */
function supplyOf(env: Env, mint: PublicKey): bigint {
  return Buffer.from(env.svm.getAccount(mint)!.data).readBigUInt64LE(36);
}

function vaultOf(mint: PublicKey) {
  return upside.ataFor(mint, Env.aegisAuthorityPda(mint));
}

/**
 * Sets the vault's balance directly. Stands in for the issuer's seizure powers (to drain it) and
 * for a holder's transfer (to donate to it), without building those Upside calls here.
 */
function setVaultBalance(env: Env, mint: PublicKey, amount: bigint) {
  const vault = vaultOf(mint);
  const acc = env.svm.getAccount(vault)!;
  const data = Buffer.from(acc.data);
  data.writeBigUInt64LE(amount, 64);
  env.svm.setAccount(vault, { ...acc, data } as any);
}

function owed(env: Env, mint: PublicKey): bigint {
  return BigInt(env.launch(mint).issuerUnsold.toString());
}

type L = Awaited<ReturnType<typeof graduatedLaunch>>;

async function finalize(env: Env, l: L) {
  return env.send(
    [
      Env.computeBudget(),
      await env.finalizeGraduationIx({
        cranker: env.admin.publicKey,
        realRwaMint: l.mint.publicKey,
        crwaMint: l.crwaMint.publicKey,
        quoteMint: l.quote.publicKey,
        meteoraConfig: l.meteoraConfig.publicKey,
      }),
    ],
    [env.admin]
  );
}

async function claim(env: Env, mint: PublicKey, signer = env.issuer) {
  return env.send(
    [
      Env.computeBudget(),
      await env.claimUnsoldIx(
        mint,
        signer === env.issuer ? undefined : signer.publicKey
      ),
    ],
    [signer]
  );
}

async function redeem(env: Env, l: L, amount: bigint) {
  return env.send(
    [
      Env.computeBudget(),
      await env.bridgeRedeemIx({
        user: l.buyer.publicKey,
        realRwaMint: l.mint.publicKey,
        crwaMint: l.crwaMint.publicKey,
        amount,
      }),
    ],
    [l.buyer]
  );
}

describe("the issuer's unsold stock", () => {
  // ---------------------------------------------------------------------------------------------
  // The finding itself, reproduced exactly as it was reported.
  // ---------------------------------------------------------------------------------------------
  describe("when the issuer removes their own registration before graduation", () => {
    let env: Env;
    let l: L;
    let issuerAta: PublicKey;

    before(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env, { finalize: false });
      issuerAta = upside.ataFor(l.mint.publicKey, env.issuer.publicKey);

      // The issuer was registered by the fixture. Now they remove themselves — Upside closes the
      // record outright.
      env.sendOk(
        [
          await upside.ix.revokeSaa(
            l.mint.publicKey,
            env.issuer.publicKey,
            env.issuer.publicKey,
            INVESTOR_GROUP,
            ISSUER_HOLDER_ID
          ),
        ],
        [env.issuer]
      );
      assert.isFalse(
        env.exists(upside.pda.securityAssociatedAccount(issuerAta)),
        "the issuer is no longer registered"
      );
    });

    it("graduation still finishes", async () => {
      expectSuccess(await finalize(env, l));
      assert.deepEqual(env.launch(l.mint.publicKey).stage, { graduated: {} });
      assert.isTrue(owed(env, l.mint.publicKey) > 0n, "the issuer is still owed their stock");
    });

    it("and every holder can redeem", async () => {
      await registerHolder(env, l.mint.publicKey, l.buyer, BUYER_HOLDER_ID);
      const buyerReal = upside.ataFor(l.mint.publicKey, l.buyer.publicKey);
      const amount = balance(env, l.buyerCrwa) / 4n;
      expectSuccess(await redeem(env, l, amount));
      assert.equal(balance(env, buyerReal), amount);
    });

    it("only the issuer's own claim waits for them", async () => {
      expectFailure(await claim(env, l.mint.publicKey));
      assert.equal(balance(env, issuerAta), 0n);
    });

    it("and it is collectable the moment they register again", async () => {
      env.sendOk(
        [
          await upside.ix.initSaa(
            l.mint.publicKey,
            env.issuer.publicKey,
            env.issuer.publicKey,
            INVESTOR_GROUP,
            ISSUER_HOLDER_ID
          ),
        ],
        [env.issuer]
      );
      const due = owed(env, l.mint.publicKey);
      expectSuccess(await claim(env, l.mint.publicKey));
      assert.equal(balance(env, issuerAta), due);
      assert.equal(owed(env, l.mint.publicKey), 0n);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // claim_unsold on the normal path.
  // ---------------------------------------------------------------------------------------------
  describe("claiming", () => {
    let env: Env;
    let l: L;
    let due: bigint;

    before(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env);
      due = owed(env, l.mint.publicKey);
    });

    it("leaves the unsold stock in the vault until claimed", () => {
      assert.isTrue(due > 0n);
      assert.equal(
        balance(env, vaultOf(l.mint.publicKey)),
        supplyOf(env, l.crwaMint.publicKey) + due
      );
    });

    it("refuses anyone but the issuer", async () => {
      await registerHolder(env, l.mint.publicKey, env.outsider, BUYER_HOLDER_ID);
      expectAnchorError(await claim(env, l.mint.publicKey, env.outsider), "NotLaunchIssuer");
    });

    it("respects the registry like any transfer out of the vault", async () => {
      env.sendOk(
        [await upside.ix.pause(l.mint.publicKey, env.issuer.publicKey, true)],
        [env.issuer]
      );
      expectAnchorError(await claim(env, l.mint.publicKey), "TransfersPaused");
      env.sendOk(
        [await upside.ix.pause(l.mint.publicKey, env.issuer.publicKey, false)],
        [env.issuer]
      );
    });

    it("pays the issuer exactly what they are owed", async () => {
      const issuerAta = upside.ataFor(l.mint.publicKey, env.issuer.publicKey);
      const before = balance(env, issuerAta);
      expectSuccess(await claim(env, l.mint.publicKey));
      assert.equal(balance(env, issuerAta) - before, due);
      assert.equal(owed(env, l.mint.publicKey), 0n);
    });

    it("leaves exactly the backing behind", () => {
      const vault = balance(env, vaultOf(l.mint.publicKey));
      assert.equal(vault, supplyOf(env, l.crwaMint.publicKey));
      const rec = env.launch(l.mint.publicKey);
      assert.equal(rec.realRwaLocked.toString(), vault.toString());
    });

    it("cannot be claimed twice", async () => {
      expectAnchorError(await claim(env, l.mint.publicKey), "NothingToClaim");
    });
  });

  describe("ordering", () => {
    it("cannot be claimed before graduation", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env, { finalize: false });
      expectAnchorError(await claim(env, l.mint.publicKey), "InvalidLaunchStage");
    });

    // Holders redeeming can never reach the issuer's share: each redemption burns exactly the
    // wrapper it is paid for, so the part above the supply is untouched.
    it("is unaffected by holders redeeming first", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, l.buyer, BUYER_HOLDER_ID);
      const due = owed(env, l.mint.publicKey);

      expectSuccess(await redeem(env, l, balance(env, l.buyerCrwa)));
      assert.equal(balance(env, l.buyerCrwa), 0n, "the buyer redeemed everything");

      const issuerAta = upside.ataFor(l.mint.publicKey, env.issuer.publicKey);
      expectSuccess(await claim(env, l.mint.publicKey));
      assert.equal(balance(env, issuerAta), due);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // When the vault does not hold what it should. The claim must never take holders' backing.
  // ---------------------------------------------------------------------------------------------
  describe("when the vault is short", () => {
    it("pays only the part above the backing, and keeps the rest owed", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, l.buyer, BUYER_HOLDER_ID);
      const supply = supplyOf(env, l.crwaMint.publicKey);
      const due = owed(env, l.mint.publicKey);
      const half = due / 2n;

      // Half of the issuer's share has gone.
      setVaultBalance(env, l.mint.publicKey, supply + half);

      const issuerAta = upside.ataFor(l.mint.publicKey, env.issuer.publicKey);
      expectSuccess(await claim(env, l.mint.publicKey));
      assert.equal(balance(env, issuerAta), half, "paid only what is there");
      assert.equal(owed(env, l.mint.publicKey), due - half, "the rest is still owed");
      assert.equal(
        balance(env, vaultOf(l.mint.publicKey)),
        supply,
        "every wrapper is still fully backed"
      );

      // Nothing above the backing now, so a second claim takes nothing from holders.
      expectAnchorError(await claim(env, l.mint.publicKey), "UnsoldNotInVault");

      // Holders are unaffected.
      expectSuccess(await redeem(env, l, 1_000n));

      // If the vault is made whole again, the remainder is claimable.
      const now = supplyOf(env, l.crwaMint.publicKey);
      setVaultBalance(env, l.mint.publicKey, now + (due - half));
      expectSuccess(await claim(env, l.mint.publicKey));
      assert.equal(balance(env, issuerAta), due);
      assert.equal(owed(env, l.mint.publicKey), 0n);
    });

    it("pays nothing when holders themselves are short", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env);
      setVaultBalance(env, l.mint.publicKey, supplyOf(env, l.crwaMint.publicKey) / 2n);
      expectAnchorError(await claim(env, l.mint.publicKey), "BackingShortfall");
    });
  });

  describe("when someone donates to the vault", () => {
    it("pays the issuer what they are owed and not a token more", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env);
      const supply = supplyOf(env, l.crwaMint.publicKey);
      const due = owed(env, l.mint.publicKey);
      const gift = 500_000n;
      setVaultBalance(env, l.mint.publicKey, supply + due + gift);

      const issuerAta = upside.ataFor(l.mint.publicKey, env.issuer.publicKey);
      expectSuccess(await claim(env, l.mint.publicKey));
      assert.equal(balance(env, issuerAta), due);
      assert.equal(
        balance(env, vaultOf(l.mint.publicKey)),
        supply + gift,
        "the donation stays in the vault, over-collateralising the wrapper"
      );
    });
  });
});
