/**
 * `fund_vault` — launch step 2: lock the whole asset in escrow.
 *
 * Two things are under test. First, that the asset actually lands in a vault only Aegis can move
 * from. Second, and more importantly, the compliance gate: Aegis refuses to immobilise an
 * issuer's asset unless the configuration they built through Upside actually works — above all
 * unless the redemption path out of the vault is open.
 *
 * The gate matters because none of it is under our control. The issuer can pause transfers,
 * close the redemption rule, freeze the vault or repoint the hook at any moment. We cannot stop
 * that. What we can do is refuse to start.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  Env,
  TEST_UNIX_TIME,
  defaultRwaArgs,
  expectAnchorError,
  expectFailure,
  expectSuccess,
} from "./helpers";
import * as upside from "./upside";

const LAYOUT = upside.DEFAULT_LAYOUT;

function readVault(env: Env, vault: PublicKey) {
  const acc = env.svm.getAccount(vault)!;
  return unpackAccount(
    vault,
    { ...acc, data: Buffer.from(acc.data) } as any,
    TOKEN_2022_PROGRAM_ID
  );
}

describe("fund_vault", () => {
  describe("happy path", () => {
    let env: Env;
    let mint: Keypair;

    before(async () => {
      env = await Env.booted();
      mint = await env.fundedLaunch();
    });

    it("locks the entire supply in the vault", () => {
      const args = defaultRwaArgs();
      const vault = upside.ataFor(
        mint.publicKey,
        Env.aegisAuthorityPda(mint.publicKey)
      );
      const v = readVault(env, vault);

      assert.equal(v.amount.toString(), args.totalSupply.toString());
      assert.equal(v.mint.toBase58(), mint.publicKey.toBase58());
    });

    it("puts the vault under a PDA nobody can sign for", () => {
      const authority = Env.aegisAuthorityPda(mint.publicKey);
      const vault = upside.ataFor(mint.publicKey, authority);
      const v = readVault(env, vault);

      assert.equal(v.owner.toBase58(), authority.toBase58());
      // Not the issuer, not the admin, not a wallet at all — the asset can only leave through
      // a redeem instruction in our program.
      assert.notEqual(v.owner.toBase58(), env.issuer.publicKey.toBase58());
      assert.isNull(v.delegate, "a delegate could move the backing asset");
      assert.isFalse(v.isFrozen);
    });

    it("mints nothing beyond the launch supply", () => {
      const args = defaultRwaArgs();
      const acc = env.svm.getAccount(mint.publicKey)!;
      const supply = Buffer.from(acc.data).readBigUInt64LE(36);
      assert.equal(
        supply.toString(),
        args.totalSupply.toString(),
        "the vault holding the full supply is only meaningful if no tokens exist elsewhere"
      );
    });

    it("records the vault, the groups and the locked amount", () => {
      const launch = env.launch(mint.publicKey);
      const args = defaultRwaArgs();

      assert.equal(
        launch.escrowVault.toBase58(),
        upside
          .ataFor(mint.publicKey, Env.aegisAuthorityPda(mint.publicKey))
          .toBase58()
      );
      assert.equal(launch.realRwaLocked.toString(), args.totalSupply.toString());
      assert.equal(launch.vaultGroup.toString(), LAYOUT.vaultGroup.toString());
      assert.equal(
        launch.investorGroup.toString(),
        LAYOUT.investorGroup.toString()
      );
      assert.deepEqual(launch.stage, { funded: {} });
    });

    it("leaves the peg ledger unbalanced until the wrapper exists", () => {
      const launch = env.launch(mint.publicKey);
      // Between Funded and Live the vault is full while no cRWA exists, because Meteora does not
      // mint the wrapper until pool creation. The peg only becomes meaningful at Live.
      assert.notEqual(launch.realRwaLocked.toString(), "0");
      assert.equal(launch.crwaMinted.toString(), "0");
      assert.equal(launch.crwaMint.toBase58(), PublicKey.default.toBase58());
    });

    it("cannot be run twice", async () => {
      const ix = await env.fundVaultIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        investorGroup: LAYOUT.investorGroup,
        vaultGroup: LAYOUT.vaultGroup,
      });
      expectAnchorError(env.send([ix], [env.issuer]), "InvalidLaunchStage");
    });
  });

  describe("the compliance gate", () => {
    let env: Env;
    let mint: Keypair;

    // A launch that is set up correctly, so each test can break exactly one thing.
    beforeEach(async () => {
      env = await Env.booted();
      mint = await env.createRwa();
      await env.setupCompliance(mint.publicKey, LAYOUT);
    });

    const fund = async (over: Partial<Parameters<Env["fundVaultIx"]>[0]> = {}) => {
      const ix = await env.fundVaultIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        investorGroup: LAYOUT.investorGroup,
        vaultGroup: LAYOUT.vaultGroup,
        ...over,
      });
      return env.send([ix], [env.issuer]);
    };

    it("accepts a correctly configured launch", async () => {
      expectSuccess(await fund());
      assert.deepEqual(env.launch(mint.publicKey).stage, { funded: {} });
    });

    // The single most important check. If the vault -> investor rule is shut, every holder ends
    // up with a wrapper they can never unwrap, and the asset is stranded forever.
    it("refuses when the redemption path is closed", async () => {
      env.sendOk(
        [
          await upside.ix.setRule(
            mint.publicKey,
            env.issuer.publicKey,
            LAYOUT.vaultGroup,
            LAYOUT.investorGroup,
            0 // 0 means forbidden
          ),
        ],
        [env.issuer]
      );
      expectAnchorError(await fund(), "RedemptionPathClosed");
    });

    it("refuses when the redemption path is still time-locked", async () => {
      const farFuture = Number(TEST_UNIX_TIME) + 10 * 365 * 24 * 3600;
      env.sendOk(
        [
          await upside.ix.setRule(
            mint.publicKey,
            env.issuer.publicKey,
            LAYOUT.vaultGroup,
            LAYOUT.investorGroup,
            farFuture
          ),
        ],
        [env.issuer]
      );
      expectAnchorError(await fund(), "RedemptionPathLocked");
    });

    it("refuses when the issuer has paused all transfers", async () => {
      env.sendOk(
        [await upside.ix.pause(mint.publicKey, env.issuer.publicKey, true)],
        [env.issuer]
      );
      expectAnchorError(await fund(), "TransfersPaused");
    });

    it("refuses when the supply cap has been raised", async () => {
      // `set_max_total_supply` can only ever increase, so dilution headroom is always one
      // transaction away. It cannot be prevented — but it stops the launch instead of quietly
      // diluting everyone who buys later.
      const args = defaultRwaArgs();
      const ix = await upside.accessControlProgram.methods
        .setMaxTotalSupply(
          (() => {
            const BN = require("bn.js");
            return new BN((BigInt(args.totalSupply) * 2n).toString());
          })()
        )
        .accountsPartial({
          accessControlAccount: upside.pda.accessControl(mint.publicKey),
          mint: mint.publicKey,
          authorityWalletRole: upside.pda.walletRole(
            mint.publicKey,
            env.issuer.publicKey
          ),
          payer: env.issuer.publicKey,
        })
        .instruction();
      env.sendOk([ix], [env.issuer]);

      expectAnchorError(await fund(), "SupplyCapRaised");
    });

    it("refuses a rule that is not the vault-to-investor rule", async () => {
      // The deposit rule runs the other way, so it proves nothing about redemption. Both exist
      // on a correctly configured launch, which makes this a realistic mix-up rather than a
      // contrived one.
      const trd = upside.pda.transferRestrictionData(mint.publicKey);
      const res = await fund({
        redeemRule: upside.pda.rule(
          trd,
          LAYOUT.investorGroup,
          LAYOUT.vaultGroup
        ),
      });
      expectFailure(res);
    });

    // Caught by the account constraints before the handler runs: a rule from a group to itself
    // was never created, so the seed-derived `redeem_rule` address does not exist. The handler's
    // own explicit check is the backstop for the case where such a rule does exist.
    it("refuses when the vault and investor groups are the same", async () => {
      expectFailure(await fund({ investorGroup: LAYOUT.vaultGroup }));
    });

    it("refuses a vault that is not owned by the Aegis PDA", async () => {
      // An issuer-owned account is a plausible-looking substitution that would hand them the
      // asset outright.
      const rogue = upside.ataFor(mint.publicKey, env.issuer.publicKey);
      env.sendOk(
        [
          upside.ix.createAta(
            env.issuer.publicKey,
            mint.publicKey,
            env.issuer.publicKey
          ),
        ],
        [env.issuer]
      );
      expectFailure(await fund({ escrowVault: rogue }));
    });
  });

  describe("authorization", () => {
    let env: Env;
    let mint: Keypair;

    beforeEach(async () => {
      env = await Env.booted();
      mint = await env.createRwa();
      await env.setupCompliance(mint.publicKey, LAYOUT);
    });

    it("refuses anyone who is not the launch issuer", async () => {
      const ix = await env.fundVaultIx({
        issuer: env.outsider.publicKey,
        realRwaMint: mint.publicKey,
        investorGroup: LAYOUT.investorGroup,
        vaultGroup: LAYOUT.vaultGroup,
      });
      expectFailure(env.send([ix], [env.outsider]));
    });

    it("refuses once the issuer has given up ReserveAdmin", async () => {
      // The issuer keeps the legal right to renounce roles. If they drop the one that mints,
      // the launch simply cannot be funded — and says so.
      const ix = await upside.accessControlProgram.methods
        .revokeRole(2) // ReserveAdmin
        .accountsPartial({
          walletRole: upside.pda.walletRole(
            mint.publicKey,
            env.issuer.publicKey
          ),
          authorityWalletRole: upside.pda.walletRole(
            mint.publicKey,
            env.issuer.publicKey
          ),
          accessControl: upside.pda.accessControl(mint.publicKey),
          securityToken: mint.publicKey,
          userWallet: env.issuer.publicKey,
          payer: env.issuer.publicKey,
          systemProgram: PublicKey.default,
        })
        .instruction();
      env.sendOk([ix], [env.issuer]);

      const fundIx = await env.fundVaultIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        investorGroup: LAYOUT.investorGroup,
        vaultGroup: LAYOUT.vaultGroup,
      });
      expectAnchorError(
        env.send([fundIx], [env.issuer]),
        "UnauthorizedIssuer"
      );
    });
  });

  describe("ordering", () => {
    it("refuses before the issuer has set up compliance", async () => {
      const env = await Env.booted();
      const mint = await env.createRwa();
      // no setupCompliance — the rule book does not exist yet
      const ix = await env.fundVaultIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        investorGroup: LAYOUT.investorGroup,
        vaultGroup: LAYOUT.vaultGroup,
      });
      expectFailure(env.send([ix], [env.issuer]));
    });
  });
});
