/**
 * Regression tests for vulnerabilities found during the security review.
 *
 * Both findings below were the same mistake: asserting that Aegis's ledger *equalled* on-chain
 * state. Both sides of that ledger can be moved by people the protocol does not control, so any
 * unsolicited change made the assertion permanently false and halted the bridge for everyone.
 *
 * The rule these encode is that an unexpected *inflow* must never be treated as an error.
 * Treating one as an error is the same as handing an attacker a way to create one.
 */
import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createBurnInstruction } from "@solana/spl-token";
import { Env, expectAnchorError, expectFailure, expectSuccess } from "./helpers";
import { graduatedLaunch, registerHolder } from "./fixtures";
import * as upside from "./upside";

function balance(env: Env, account: any): bigint {
  const acc = env.svm.getAccount(account);
  if (!acc) return 0n;
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

describe("security regressions", () => {
  /**
   * Found in review. Severity: critical, permanent denial of service.
   *
   * The investor -> vault transfer rule exists so the bridge can accept deposits, which means
   * any approved holder can also send the asset straight into the escrow vault without touching
   * Aegis. That left the vault holding more than the ledger recorded, and the equality check
   * then failed on every subsequent deposit and redemption — forever. One millionth of a token
   * was enough to strand every holder.
   */
  describe("donating the asset into the escrow vault", () => {
    let env: Env;
    let l: Awaited<ReturnType<typeof graduatedLaunch>>;

    before(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);
      // redeem a little, so the attacker holds some of the asset to donate back
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 1_000_000n,
            }),
          ],
          [env.outsider]
        )
      );
    });

    it("is permitted by Upside — nothing stops the donation itself", () => {
      const vault = upside.ataFor(
        l.mint.publicKey,
        Env.aegisAuthorityPda(l.mint.publicKey)
      );
      const before = balance(env, vault);

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            upside.transferRealRwaIx({
              mint: l.mint.publicKey,
              source: upside.ataFor(l.mint.publicKey, env.outsider.publicKey),
              destination: vault,
              owner: env.outsider.publicKey,
              amount: 1n,
              decimals: 6,
              fromGroup: upside.DEFAULT_LAYOUT.investorGroup,
              toGroup: upside.DEFAULT_LAYOUT.vaultGroup,
            }),
          ],
          [env.outsider]
        )
      );

      assert.equal(balance(env, vault) - before, 1n);
    });

    it("leaves the bridge working", async () => {
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 1_000n,
            }),
          ],
          [env.outsider]
        )
      );
    });

    it("leaves the launch over-collateralised, which is safe", () => {
      const rec = env.launch(l.mint.publicKey);
      assert.isTrue(
        BigInt(rec.realRwaLocked.toString()) >
          BigInt(rec.crwaMinted.toString()),
        "the donated token should simply become excess backing"
      );
    });
  });

  /**
   * Found in review. Severity: critical, permanent denial of service, trivial to execute.
   *
   * Anyone may burn wrapper tokens they own — one instruction, no permission, no hook. That
   * lowered total supply below the recorded figure and halted the bridge for every holder.
   */
  describe("burning your own wrapper", () => {
    let env: Env;
    let l: Awaited<ReturnType<typeof graduatedLaunch>>;

    before(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            createBurnInstruction(
              l.buyerCrwa,
              l.crwaMint.publicKey,
              env.outsider.publicKey,
              1n,
              [],
              TOKEN_2022_PROGRAM_ID
            ),
          ],
          [env.outsider]
        )
      );
    });

    it("leaves the bridge working", async () => {
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 1_000n,
            }),
          ],
          [env.outsider]
        )
      );
    });

    it("leaves the launch over-collateralised, which is safe", () => {
      const rec = env.launch(l.mint.publicKey);
      assert.isTrue(
        BigInt(rec.realRwaLocked.toString()) >
          BigInt(rec.crwaMinted.toString()),
        "the burner forfeited their claim; everyone else is still fully backed"
      );
    });
  });

  /**
   * Found in review. Severity: low, repeatable denial of service.
   *
   * The cRWA mint address appears in the launch transaction, and the hook's companion account is
   * derived from it. A watcher could create that account first, which made the launch's own
   * creation of it fail and reverted the whole launch. Nothing was gained — the account is owned
   * by the hook program, so its contents are always the same empty list — but the issuer had to
   * retry with a fresh mint keypair, repeatedly.
   */
  describe("front-running the hook companion account", () => {
    it("does not stop the launch", async () => {
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
            args: (require("./helpers") as any).defaultConfigArgs(),
          }),
        ],
        [env.issuer, cfg]
      );

      const crwaMint = Keypair.generate();
      const attacker = Keypair.generate();
      env.svm.airdrop(attacker.publicKey, 10n * 1_000_000_000n);

      // The attacker saw the pending launch and claimed the address first.
      expectSuccess(
        env.send(
          [await env.initHookMetasIx(attacker.publicKey, crwaMint.publicKey)],
          [attacker]
        )
      );
      assert.isTrue(env.exists(Env.extraAccountMetaList(crwaMint.publicKey)));

      expectSuccess(
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
        )
      );
      assert.deepEqual(env.launch(mint.publicKey).stage, { live: {} });
    });
  });

  /**
   * Found in review. Severity: informational, admin footgun.
   *
   * A fee recipient owned by another program cannot receive a plain lamport transfer, so setting
   * one would have made `create_rwa` fail and halted every launch. The recipient is now supplied
   * as an account so its owner can be checked.
   */
  describe("setting an unpayable fee recipient", () => {
    it("is refused", async () => {
      const env = await Env.booted();
      // The launch PDA is owned by the Aegis program, so it cannot receive a bare transfer.
      const programOwned = Env.platformConfigPda();
      expectFailure(
        env.send(
          [await env.updatePlatformConfigIx({ newFeeRecipient: programOwned })],
          [env.admin]
        )
      );
    });

    it("accepts an ordinary wallet", async () => {
      const env = await Env.booted();
      const wallet = Keypair.generate();
      env.svm.airdrop(wallet.publicKey, 1_000_000_000n);
      expectSuccess(
        env.send(
          [await env.updatePlatformConfigIx({ newFeeRecipient: wallet.publicKey })],
          [env.admin]
        )
      );
      assert.equal(
        env.platformConfig().feeRecipient.toBase58(),
        wallet.publicKey.toBase58()
      );
    });
  });

  /**
   * Found in review. Severity: informational, silent product failure.
   *
   * The migration fee is the only channel that delivers raised capital to the issuer, because
   * Meteora turns the raise into pool liquidity and Aegis locks it permanently. A launch
   * configured at zero raised them nothing, silently. A protocol-set floor now makes that a
   * deliberate choice rather than an accident.
   */
  describe("a launch that would raise the issuer nothing", () => {
    it("is refused at the default floor", async () => {
      const env = await Env.booted();
      const { defaultConfigArgs } = require("./helpers");
      const quote = await env.makeSplMint(6);
      env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
      const mint = await env.fundedLaunch();
      const cfg = Keypair.generate();
      expectAnchorError(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: cfg.publicKey,
              args: defaultConfigArgs({ migrationFeePct: 0 }),
            }),
          ],
          [env.issuer, cfg]
        ),
        "MigrationFeeTooLow"
      );
    });

    it("is allowed once the admin lowers the floor", async () => {
      const env = await Env.booted();
      const { defaultConfigArgs } = require("./helpers");
      env.sendOk(
        [await env.updatePlatformConfigIx({ minMigrationFeePct: 0 })],
        [env.admin]
      );
      const quote = await env.makeSplMint(6);
      env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
      const mint = await env.fundedLaunch();
      const cfg = Keypair.generate();
      expectSuccess(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: cfg.publicKey,
              args: defaultConfigArgs({ migrationFeePct: 0 }),
            }),
          ],
          [env.issuer, cfg]
        )
      );
    });

  });

  /** Events exist so a frontend can follow a launch without polling every account. */
  describe("events", () => {
    it("are emitted across the lifecycle", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);
      const res = expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 1_000n,
            }),
          ],
          [env.outsider]
        )
      );
      // Anchor writes events into the program logs as base64 `Program data:` lines.
      const logs = res.logs().join("\n");
      assert.include(logs, "Program data:", "the redemption should emit an event");
    });
  });

  /**
   * The direction that *must* still fail. Over-collateralisation is harmless;
   * under-collateralisation means some holders could redeem and others could not, so the bridge
   * halts rather than serving the fastest.
   */
  describe("a shortfall in the vault", () => {
    /** Simulates the issuer exercising the seizure powers a securities issuer retains. */
    function setVaultBalance(env: Env, mint: any, amount: bigint) {
      const vault = upside.ataFor(mint, Env.aegisAuthorityPda(mint));
      const acc = env.svm.getAccount(vault)!;
      const data = Buffer.from(acc.data);
      data.writeBigUInt64LE(amount, 64);
      env.svm.setAccount(vault, { ...acc, data } as any);
    }

    function crwaSupply(env: Env, crwaMint: any): bigint {
      // `supply` sits at byte 36 of every SPL mint.
      return Buffer.from(env.svm.getAccount(crwaMint)!.data).readBigUInt64LE(36);
    }

    it("halts the bridge", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);

      // Below the wrapper supply, so holders' backing is short — not just the issuer's share.
      setVaultBalance(env, l.mint.publicKey, crwaSupply(env, l.crwaMint.publicKey) / 2n);

      expectFailure(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 1_000n,
            }),
          ],
          [env.outsider]
        )
      );
    });

    // Until the issuer claims it, their unsold stock sits in the vault on top of the backing.
    // A loss that share can absorb must come out of it, and leave every holder whole.
    it("comes out of the issuer's unsold stock first", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);

      // Take everything the issuer is owed, and nothing more.
      const supply = crwaSupply(env, l.crwaMint.publicKey);
      assert.isTrue(BigInt(env.launch(l.mint.publicKey).issuerUnsold.toString()) > 0n);
      setVaultBalance(env, l.mint.publicKey, supply);

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 1_000n,
            }),
          ],
          [env.outsider]
        )
      );
    });
  });
});
