/**
 * `create_rwa_config` — launch step 3: fix the sale terms with Meteora.
 *
 * Most of Meteora's configuration surface is a rug vector if left open, so Aegis chooses nearly
 * all of it and the issuer supplies only economic terms. These tests are mostly about proving
 * that: that an issuer cannot reach the dangerous fields, and that the curve Aegis builds is the
 * one it claims to build.
 *
 * Everything runs against the real Meteora binary dumped from mainnet, so the config either
 * satisfies Meteora's own validation or the test fails.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ARCHETYPE,
  Env,
  defaultConfigArgs,
  defaultRwaArgs,
  expectAnchorError,
  expectFailure,
  expectSuccess,
} from "./helpers";
import * as upside from "./upside";

/** A funded launch plus an approved USDC-like quote token — the state step 3 starts from. */
async function readyLaunch(env: Env, supply?: bigint | number) {
  const quote = await env.makeSplMint(6);
  env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
  const mint = await env.fundedLaunch(
    defaultRwaArgs(supply === undefined ? {} : { totalSupply: supply })
  );
  return { mint, quote };
}

describe("create_rwa_config", () => {
  describe("happy path", () => {
    let env: Env;
    let mint: Keypair;
    let quote: Keypair;
    let meteoraConfig: Keypair;

    before(async () => {
      env = await Env.booted();
      ({ mint, quote } = await readyLaunch(env));
      meteoraConfig = Keypair.generate();
      expectSuccess(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: meteoraConfig.publicKey,
              args: defaultConfigArgs(),
            }),
          ],
          [env.issuer, meteoraConfig]
        )
      );
    });

    it("creates a config owned by Meteora", () => {
      const acc = env.svm.getAccount(meteoraConfig.publicKey);
      assert.isNotNull(acc, "Meteora should have initialized the config account");
      assert.equal(
        new PublicKey(acc!.owner).toBase58(),
        env.meteoraDbcProgramId().toBase58(),
        "the config must be owned by Meteora, which only happens if its own validation passed"
      );
      assert.isAbove(acc!.data.length, 0);
    });

    it("records the config and moves to Configured", () => {
      const launch = env.launch(mint.publicKey);
      assert.equal(
        launch.meteoraConfig.toBase58(),
        meteoraConfig.publicKey.toBase58()
      );
      assert.equal(launch.quoteMint.toBase58(), quote.publicKey.toBase58());
      assert.deepEqual(launch.stage, { configured: {} });
      assert.deepEqual(launch.archetype, { bookBuilding: {} });
    });

    it("cannot be run twice for the same launch", async () => {
      const second = Keypair.generate();
      expectAnchorError(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: second.publicKey,
              args: defaultConfigArgs(),
            }),
          ],
          [env.issuer, second]
        ),
        "InvalidLaunchStage"
      );
    });
  });

  describe("the curve Aegis builds", () => {
    let env: Env;

    beforeEach(async () => {
      env = await Env.booted();
    });

    const configure = async (
      over: Partial<ReturnType<typeof defaultConfigArgs>> = {},
      supply?: bigint | number
    ) => {
      const { mint, quote } = await readyLaunch(env, supply);
      const cfg = Keypair.generate();
      const res = env.send(
        [
          await env.createRwaConfigIx({
            issuer: env.issuer.publicKey,
            realRwaMint: mint.publicKey,
            quoteMint: quote.publicKey,
            meteoraConfig: cfg.publicKey,
            args: defaultConfigArgs(over),
          }),
        ],
        [env.issuer, cfg]
      );
      return { res, mint, quote, cfg };
    };

    it("accepts each archetype at its ceiling", async () => {
      for (const [archetype, bps] of [
        [ARCHETYPE.fixedPar, 10_099],
        [ARCHETYPE.bookBuilding, 11_180],
        [ARCHETYPE.growthCapital, 12_247],
      ] as const) {
        const { res } = await configure({
          archetype,
          sqrtExpansionBps: bps,
        });
        expectSuccess(res);
      }
    });

    // The price-expansion firewall. Because the curve is one segment, bounding the endpoint
    // bounds every price anyone can pay during the sale.
    it("rejects each archetype one basis point above its ceiling", async () => {
      for (const [archetype, bps] of [
        [ARCHETYPE.fixedPar, 10_100],
        [ARCHETYPE.bookBuilding, 11_181],
        [ARCHETYPE.growthCapital, 12_248],
      ] as const) {
        const { res } = await configure({ archetype, sqrtExpansionBps: bps });
        expectAnchorError(res, "PriceExpansionExceedsRwaLimit");
      }
    });

    it("rejects a flat curve", async () => {
      const { res } = await configure({ sqrtExpansionBps: 10_000 });
      expectAnchorError(res, "PriceExpansionTooSmall");
    });

    it("rejects a falling curve", async () => {
      const { res } = await configure({ sqrtExpansionBps: 9_000 });
      expectAnchorError(res, "PriceExpansionTooSmall");
    });

    it("rejects a zero raise", async () => {
      const { res } = await configure({ targetRaise: 0 });
      expectAnchorError(res, "InvalidQuoteThreshold");
    });

    // cRWA supply is pinned to the escrowed asset and cannot be enlarged to fit an ambitious
    // raise, so the raise has to be refused rather than silently scaled.
    it("rejects a raise the fixed supply cannot cover", async () => {
      const { res } = await configure(
        { targetRaise: 1_000_000_000_000_000 },
        1_000_000
      );
      expectAnchorError(res, "SupplyTooSmallForCurve");
    });

    it("rejects a start price below Meteora's minimum", async () => {
      const { res } = await configure({ sqrtStartPrice: 1n });
      expectAnchorError(res, "InvalidStartPrice");
    });
  });

  describe("what the issuer cannot reach", () => {
    let env: Env;

    beforeEach(async () => {
      env = await Env.booted();
    });

    // Without this the event authority proves nothing: it is derived from whatever program is
    // passed, so a substituted program would validate against itself.
    it("rejects a substituted Meteora program", async () => {
      const { mint, quote } = await readyLaunch(env);
      const cfg = Keypair.generate();
      expectAnchorError(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: cfg.publicKey,
              args: defaultConfigArgs(),
              dbcProgram: env.outsider.publicKey,
            }),
          ],
          [env.issuer, cfg]
        ),
        "InvalidDbcProgram"
      );
    });

    it("rejects a substituted transfer hook program", async () => {
      const { mint, quote } = await readyLaunch(env);
      const cfg = Keypair.generate();
      expectAnchorError(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: cfg.publicKey,
              args: defaultConfigArgs(),
              hookProgram: TOKEN_PROGRAM_ID,
            }),
          ],
          [env.issuer, cfg]
        ),
        "InvalidHookProgram"
      );
    });

    // The migration fee is the only channel that delivers raised capital, so it is bounded
    // rather than left at Meteora's 99%.
    it("rejects a migration fee above the protocol ceiling", async () => {
      const { mint, quote } = await readyLaunch(env);
      const cfg = Keypair.generate();
      expectAnchorError(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: cfg.publicKey,
              args: defaultConfigArgs({ migrationFeePct: 99 }),
            }),
          ],
          [env.issuer, cfg]
        ),
        "MigrationFeeTooHigh"
      );
    });

    it("refuses anyone who is not the launch issuer", async () => {
      const { mint, quote } = await readyLaunch(env);
      const cfg = Keypair.generate();
      expectFailure(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.outsider.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: cfg.publicKey,
              args: defaultConfigArgs(),
            }),
          ],
          [env.outsider, cfg]
        )
      );
    });

    it("refuses while the protocol is paused", async () => {
      const { mint, quote } = await readyLaunch(env);
      await env.setPaused(true);
      const cfg = Keypair.generate();
      expectAnchorError(
        env.send(
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
        ),
        "ProtocolPaused"
      );
    });
  });

  describe("quote token gating", () => {
    let env: Env;

    beforeEach(async () => {
      env = await Env.booted();
    });

    it("refuses a quote token that was never approved", async () => {
      const quote = await env.makeSplMint(6);
      const mint = await env.fundedLaunch();
      const cfg = Keypair.generate();
      // no whitelist record exists, so the PDA cannot be loaded
      expectFailure(
        env.send(
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
        )
      );
    });

    it("refuses a quote token the admin deactivated", async () => {
      const { mint, quote } = await readyLaunch(env);
      env.sendOk(
        [await env.updateQuoteTokenIx(quote.publicKey, false)],
        [env.admin]
      );
      const cfg = Keypair.generate();
      expectAnchorError(
        env.send(
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
        ),
        "QuoteTokenInactive"
      );
    });

    // The whitelist record is keyed on the mint, so a record for a different token cannot be
    // passed off as approval for this one.
    it("refuses a whitelist record belonging to another mint", async () => {
      const { mint } = await readyLaunch(env);
      const other = await env.makeSplMint(6);
      env.sendOk([await env.whitelistQuoteTokenIx(other.publicKey)], [env.admin]);
      const unapproved = await env.makeSplMint(6);
      const cfg = Keypair.generate();
      expectFailure(
        env.send(
          [
            await env.createRwaConfigIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: unapproved.publicKey,
              meteoraConfig: cfg.publicKey,
              args: defaultConfigArgs(),
              quoteToken: Env.quoteTokenPda(other.publicKey),
            }),
          ],
          [env.issuer, cfg]
        )
      );
    });
  });

  /**
   * The issuer chooses their own liquidity split, vesting schedule and pool fee, but only
   * inside bounds the protocol admin sets. These tests walk that boundary from both sides:
   * a legitimate choice must go through, and a choice outside the bounds must not.
   */
  describe("the issuer's own terms", () => {
    let env: Env;

    before(async () => {
      env = await Env.booted();
    });

    /** Attempts a config with `args` merged over the defaults; returns the send result. */
    async function tryConfig(overrides: any) {
      const { mint, quote } = await readyLaunch(env);
      const cfg = Keypair.generate();
      return env.send(
        [
          await env.createRwaConfigIx({
            issuer: env.issuer.publicKey,
            realRwaMint: mint.publicKey,
            quoteMint: quote.publicKey,
            meteoraConfig: cfg.publicKey,
            args: defaultConfigArgs(overrides),
          }),
        ],
        [env.issuer, cfg]
      );
    }

    // The protocol keeps 10% of graduated liquidity, so the issuer's own share is 90. Whatever
    // they do with it, the two buckets have to add up to exactly that.
    it("accepts locking the issuer's whole share permanently", async () => {
      expectSuccess(
        await tryConfig({
          issuerPermanentLockPct: 90,
          issuerVestedPct: 0,
          vestingMonths: 0,
        })
      );
    });

    it("accepts vesting the issuer's whole share", async () => {
      expectSuccess(
        await tryConfig({
          issuerPermanentLockPct: 0,
          issuerVestedPct: 90,
          vestingMonths: 24,
        })
      );
    });

    it("rejects a split that leaves liquidity unaccounted for", async () => {
      expectAnchorError(
        await tryConfig({ issuerPermanentLockPct: 30, issuerVestedPct: 50 }),
        "InvalidLiquiditySplit"
      );
    });

    // The gap this closes: liquidity the issuer could simply withdraw the day after graduation.
    // Claiming more than their share is the way to ask for it, and it does not work.
    it("rejects a split that claims more than the issuer's share", async () => {
      expectAnchorError(
        await tryConfig({ issuerPermanentLockPct: 40, issuerVestedPct: 60 }),
        "InvalidLiquiditySplit"
      );
    });

    it("rejects vesting longer than the admin allows", async () => {
      expectAnchorError(
        await tryConfig({
          issuerPermanentLockPct: 0,
          issuerVestedPct: 90,
          vestingMonths: 25,
        }),
        "InvalidVestingMonths"
      );
    });

    it("rejects vesting shorter than the admin allows", async () => {
      expectAnchorError(
        await tryConfig({
          issuerPermanentLockPct: 0,
          issuerVestedPct: 90,
          vestingMonths: 1,
        }),
        "InvalidVestingMonths"
      );
    });

    // A schedule and an amount that disagree in either direction. Meteora would accept the
    // first silently — a vested share with no periods releases everything at once.
    it("rejects a vested share with no schedule", async () => {
      expectAnchorError(
        await tryConfig({
          issuerPermanentLockPct: 0,
          issuerVestedPct: 90,
          vestingMonths: 0,
        }),
        "InvalidVestingMonths"
      );
    });

    it("rejects a schedule with nothing to vest", async () => {
      expectAnchorError(
        await tryConfig({
          issuerPermanentLockPct: 90,
          issuerVestedPct: 0,
          vestingMonths: 12,
        }),
        "InvalidVestingMonths"
      );
    });

    it("rejects a pool fee above the admin's ceiling", async () => {
      expectAnchorError(await tryConfig({ poolFeeBps: 301 }), "InvalidFeeBps");
    });

    it("rejects a pool fee below the admin's floor", async () => {
      expectAnchorError(await tryConfig({ poolFeeBps: 9 }), "InvalidFeeBps");
    });

    it("accepts a pool fee at each end of the admin's range", async () => {
      expectSuccess(await tryConfig({ poolFeeBps: 10 }));
      expectSuccess(await tryConfig({ poolFeeBps: 300 }));
    });

    // The floor moves with the admin, not with the issuer.
    it("enforces a raised permanent-lock minimum", async () => {
      const fresh = await Env.booted();
      fresh.sendOk(
        [await fresh.updatePlatformConfigIx({ minIssuerPermanentPct: 50 })],
        [fresh.admin]
      );
      const { mint, quote } = await readyLaunch(fresh);
      const cfg = Keypair.generate();
      expectAnchorError(
        fresh.send(
          [
            await fresh.createRwaConfigIx({
              issuer: fresh.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: cfg.publicKey,
              args: defaultConfigArgs({
                issuerPermanentLockPct: 30,
                issuerVestedPct: 60,
                vestingMonths: 12,
              }),
            }),
          ],
          [fresh.issuer, cfg]
        ),
        "PermanentLockTooLow"
      );
    });
  });

  describe("the minimum raise", () => {
    it("refuses a raise below the quote token's floor", async () => {
      const env = await Env.booted();
      const quote = await env.makeSplMint(6);
      // 50,000 USDC at six decimals.
      env.sendOk(
        [
          await env.whitelistQuoteTokenIx(
            quote.publicKey,
            undefined,
            50_000_000_000
          ),
        ],
        [env.admin]
      );
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
              args: defaultConfigArgs({ targetRaise: 49_999_000_000 }),
            }),
          ],
          [env.issuer, cfg]
        ),
        "RaiseBelowMinimum"
      );
    });

    it("accepts a raise at the floor exactly", async () => {
      const env = await Env.booted();
      const quote = await env.makeSplMint(6);
      env.sendOk(
        [
          await env.whitelistQuoteTokenIx(
            quote.publicKey,
            undefined,
            50_000_000_000
          ),
        ],
        [env.admin]
      );
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
              args: defaultConfigArgs({ targetRaise: 50_000_000_000 }),
            }),
          ],
          [env.issuer, cfg]
        )
      );
    });

    // Floors move with the token's price, so an admin has to be able to change one after
    // approval without deactivating the token and losing every launch configured against it.
    it("can be changed after approval", async () => {
      const env = await Env.booted();
      const quote = await env.makeSplMint(6);
      env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
      env.sendOk(
        [await env.updateQuoteTokenIx(quote.publicKey, null, 50_000_000_000)],
        [env.admin]
      );
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
              args: defaultConfigArgs({ targetRaise: 1_000_000 }),
            }),
          ],
          [env.issuer, cfg]
        ),
        "RaiseBelowMinimum"
      );
    });
  });

  describe("ordering", () => {
    it("refuses before the vault is funded", async () => {
      const env = await Env.booted();
      const quote = await env.makeSplMint(6);
      env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
      // created but not funded
      const mint = await env.createRwa();
      await env.setupCompliance(mint.publicKey, upside.DEFAULT_LAYOUT);
      const cfg = Keypair.generate();
      expectAnchorError(
        env.send(
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
        ),
        "InvalidLaunchStage"
      );
    });
  });
});
