/**
 * `update_platform_config` — the admin's half of the configuration model.
 *
 * Aegis splits configuration three ways. Structural fields are hardcoded and nobody can reach
 * them. Protocol revenue is a single value the admin sets. Everything else is the issuer's
 * choice, made inside bounds the admin sets here.
 *
 * These tests are about that third group: a bound is only worth having if it cannot be set to
 * something incoherent. A minimum above its maximum, a fee Meteora would reject, a protocol
 * liquidity share too small to satisfy Meteora's own still-locked floor — each of those would
 * surface later as an opaque failure inside someone else's program, after an issuer had already
 * escrowed their asset.
 */
import { assert } from "chai";
import { Env, expectAnchorError, expectSuccess } from "./helpers";

describe("update_platform_config", () => {
  let env: Env;

  before(async () => {
    env = await Env.booted();
  });

  describe("protocol revenue", () => {
    it("accepts a curve fee inside Meteora's range", async () => {
      expectSuccess(
        env.send(
          [await env.updatePlatformConfigIx({ curveFeeBps: 250 })],
          [env.admin]
        )
      );
    });

    // Meteora's own floor is 25 bps. Below it the config creation would fail inside Meteora,
    // long after the admin thought they had set a fee.
    it("rejects a curve fee below Meteora's floor", async () => {
      expectAnchorError(
        env.send(
          [await env.updatePlatformConfigIx({ curveFeeBps: 24 })],
          [env.admin]
        ),
        "InvalidFeeBps"
      );
    });

    // Meteora would allow up to 99%. A placement fee that size is not a fee.
    it("rejects a curve fee above the protocol's own ceiling", async () => {
      expectAnchorError(
        env.send(
          [await env.updatePlatformConfigIx({ curveFeeBps: 1_001 })],
          [env.admin]
        ),
        "InvalidFeeBps"
      );
    });

    it("rejects a fee share above 100 percent", async () => {
      expectAnchorError(
        env.send(
          [await env.updatePlatformConfigIx({ issuerCurveFeeSharePct: 101 })],
          [env.admin]
        ),
        "InvalidPercentage"
      );
      expectAnchorError(
        env.send(
          [await env.updatePlatformConfigIx({ aegisMigrationFeeSharePct: 101 })],
          [env.admin]
        ),
        "InvalidPercentage"
      );
    });

    // Meteora requires at least 10% of graduated liquidity to still be locked a day after
    // migration. Aegis's permanent share is what guarantees that, because an issuer is free to
    // vest every unit of theirs.
    it("rejects a protocol liquidity share below Meteora's locked floor", async () => {
      expectAnchorError(
        env.send(
          [await env.updatePlatformConfigIx({ aegisLpSharePct: 9 })],
          [env.admin]
        ),
        "InvalidPercentage"
      );
    });
  });

  describe("bounds on the issuer's choices", () => {
    it("rejects a minimum above its maximum", async () => {
      const fresh = await Env.booted();
      expectAnchorError(
        fresh.send(
          [await fresh.updatePlatformConfigIx({ minMigrationFeePct: 95 })],
          [fresh.admin]
        ),
        "InvalidPercentage"
      );
      expectAnchorError(
        fresh.send(
          [await fresh.updatePlatformConfigIx({ minVestingMonths: 30 })],
          [fresh.admin]
        ),
        "InvalidVestingMonths"
      );
      expectAnchorError(
        fresh.send(
          [await fresh.updatePlatformConfigIx({ minPoolFeeBps: 500 })],
          [fresh.admin]
        ),
        "InvalidFeeBps"
      );
    });

    // Both ends in one instruction, so a range can be moved wholesale without passing through
    // an invalid intermediate state.
    it("accepts both ends moved together", async () => {
      const fresh = await Env.booted();
      expectSuccess(
        fresh.send(
          [
            await fresh.updatePlatformConfigIx({
              minVestingMonths: 12,
              maxVestingMonths: 24,
              minPoolFeeBps: 100,
              maxPoolFeeBps: 500,
            }),
          ],
          [fresh.admin]
        )
      );
    });

    it("rejects vesting longer than Meteora's two-year lock", async () => {
      const fresh = await Env.booted();
      expectAnchorError(
        fresh.send(
          [await fresh.updatePlatformConfigIx({ maxVestingMonths: 25 })],
          [fresh.admin]
        ),
        "InvalidVestingMonths"
      );
    });

    it("rejects a pool fee range outside Meteora's own", async () => {
      const fresh = await Env.booted();
      expectAnchorError(
        fresh.send(
          [await fresh.updatePlatformConfigIx({ maxPoolFeeBps: 1_001 })],
          [fresh.admin]
        ),
        "InvalidFeeBps"
      );
    });

    // The issuer cannot be required to permanently lock more liquidity than they are given.
    it("rejects a permanent-lock minimum above the issuer's whole share", async () => {
      const fresh = await Env.booted();
      expectAnchorError(
        fresh.send(
          [await fresh.updatePlatformConfigIx({ minIssuerPermanentPct: 95 })],
          [fresh.admin]
        ),
        "InvalidPercentage"
      );
    });

    // The same value is fine once the protocol takes a smaller share, which is the point of
    // cross-checking the two rather than capping each on its own.
    it("accepts it once the protocol's share leaves room", async () => {
      const fresh = await Env.booted();
      expectSuccess(
        fresh.send(
          [
            await fresh.updatePlatformConfigIx({
              aegisLpSharePct: 10,
              minIssuerPermanentPct: 90,
            }),
          ],
          [fresh.admin]
        )
      );
    });
  });

  it("refuses anyone but the admin", async () => {
    const fresh = await Env.booted();
    const ix = await fresh.updatePlatformConfigIx({ curveFeeBps: 200 });
    // Re-point the signer at an outsider; the program's `has_one` is what must reject it.
    ix.keys = ix.keys.map((k) =>
      k.pubkey.equals(fresh.admin.publicKey)
        ? { ...k, pubkey: fresh.outsider.publicKey }
        : k
    );
    expectAnchorError(fresh.send([ix], [fresh.outsider]), "Unauthorized");
    assert.isTrue(true);
  });
});
