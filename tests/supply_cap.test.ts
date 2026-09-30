/**
 * A raised supply cap must never trap holders.
 *
 * Issuing more shares is a lawful corporate action. In Upside it means `set_max_total_supply`,
 * which can only ever raise the cap. Aegis used to check "cap == launch supply" at every gate, so
 * that one action permanently blocked redemption, deposits, graduation and abort — with no way
 * back, because the cap can never be lowered.
 *
 * Dilution does not break the peg: every cRWA is still backed by one Real RWA in the vault. So
 * the check now runs only where a new buyer is about to enter (`fund_vault`, `launch_pool`), and
 * everyone already in can always leave.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import {
  Env,
  defaultConfigArgs,
  defaultRwaArgs,
  expectAnchorError,
  expectSuccess,
} from "./helpers";
import { graduatedLaunch, registerHolder } from "./fixtures";
import * as upside from "./upside";

const SUPPLY = BigInt(defaultRwaArgs().totalSupply);

function balance(env: Env, account: PublicKey): bigint {
  const acc = env.svm.getAccount(account);
  if (!acc) return 0n;
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

function supplyOf(env: Env, mint: PublicKey): bigint {
  const acc = env.svm.getAccount(mint)!;
  return unpackMint(mint, { ...acc, data: Buffer.from(acc.data) } as any, TOKEN_2022_PROGRAM_ID)
    .supply;
}

/** The issuer lawfully raises the cap to twice the launch supply. */
async function raiseCap(env: Env, mint: PublicKey) {
  env.sendOk(
    [await upside.ix.setMaxTotalSupply(mint, env.issuer.publicKey, SUPPLY * 2n)],
    [env.issuer]
  );
  const ac = env.accountData(upside.pda.accessControl(mint));
  // 8 discriminator + 32 mint + 32 authority, then max_total_supply.
  assert.equal(ac.readBigUInt64LE(72), SUPPLY * 2n, "the cap really was raised");
}

function vaultOf(mint: PublicKey) {
  return upside.ataFor(mint, Env.aegisAuthorityPda(mint));
}

describe("a raised supply cap", () => {
  describe("after graduation", () => {
    let env: Env;
    let l: Awaited<ReturnType<typeof graduatedLaunch>>;

    before(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, l.buyer, 2);
      await raiseCap(env, l.mint.publicKey);
    });

    it("still lets a holder redeem, one for one", async () => {
      const buyerReal = upside.ataFor(l.mint.publicKey, l.buyer.publicKey);
      const crwaBefore = balance(env, l.buyerCrwa);
      const amount = crwaBefore / 4n;

      expectSuccess(
        env.send(
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
        )
      );

      assert.equal(crwaBefore - balance(env, l.buyerCrwa), amount);
      assert.equal(balance(env, buyerReal), amount);
    });

    it("still lets a holder deposit", async () => {
      const buyerReal = upside.ataFor(l.mint.publicKey, l.buyer.publicKey);
      const realBefore = balance(env, buyerReal);
      const crwaBefore = balance(env, l.buyerCrwa);
      const amount = realBefore / 2n;

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeDepositIx({
              user: l.buyer.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount,
            }),
          ],
          [l.buyer]
        )
      );

      assert.equal(realBefore - balance(env, buyerReal), amount);
      assert.equal(balance(env, l.buyerCrwa) - crwaBefore, amount);
    });

    it("leaves the peg intact — dilution is not a shortfall", () => {
      assert.equal(
        balance(env, vaultOf(l.mint.publicKey)),
        supplyOf(env, l.crwaMint.publicKey),
        "escrowed asset must still equal wrapper supply"
      );
    });
  });

  describe("between migration and finalize_graduation", () => {
    it("still lets graduation finish, so the bridge opens", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env, { finalize: false });
      await raiseCap(env, l.mint.publicKey);

      expectSuccess(
        env.send(
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
        )
      );
      assert.deepEqual(env.launch(l.mint.publicKey).stage, { graduated: {} });
    });
  });

  describe("before the sale", () => {
    it("still lets the issuer abort and take the asset back", async () => {
      const env = await Env.booted();
      const mint = await env.fundedLaunch();
      await registerHolder(env, mint.publicKey, env.issuer, 1);
      await raiseCap(env, mint.publicKey);

      expectSuccess(
        env.send([Env.computeBudget(), await env.abortLaunchIx(mint.publicKey)], [env.issuer])
      );
      assert.equal(
        balance(env, upside.ataFor(mint.publicKey, env.issuer.publicKey)),
        SUPPLY,
        "the whole supply returned to the issuer"
      );
    });

    // The one place the check still belongs: nobody has bought yet, and the curve was priced for
    // a supply that no longer exists. (fund_vault's refusal is covered in fund_vault.test.ts.)
    it("still refuses to open the sale", async () => {
      const env = await Env.booted();
      const quote = await env.makeSplMint(6);
      env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
      const mint = await env.fundedLaunch();
      const cfg = Keypair.generate();
      env.sendOk(
        [
          await env.createRwaConfigIx({
            issuer: env.issuer.publicKey,
            realRwaMint: mint.publicKey,
            quoteMint: quote.publicKey,
            meteoraConfig: cfg.publicKey,
            args: defaultConfigArgs(),
          }),
        ],
        [env.issuer, cfg]
      );
      await raiseCap(env, mint.publicKey);

      const crwaMint = Keypair.generate();
      expectAnchorError(
        env.send(
          [
            Env.computeBudget(),
            await env.launchPoolIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: cfg.publicKey,
              crwaMint: crwaMint.publicKey,
            }),
          ],
          [env.issuer, crwaMint]
        ),
        "SupplyCapRaised"
      );
    });
  });
});
