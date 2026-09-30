/**
 * Runs the real registry loader against a local validator seeded by scripts/localnet-launch.ts.
 * Skipped unless AEGIS_LOCALNET=1, so the normal unit run needs no node.
 *
 *   AEGIS_NAME="Aegis Tower B" AEGIS_SYMBOL=TWRB yarn localnet:launch
 *   AEGIS_NAME="Aegis Tower A" AEGIS_SYMBOL=TWRA AEGIS_STOP_AT=live AEGIS_BUY=6200 yarn localnet:launch
 *   AEGIS_NAME="Aegis Tower C" AEGIS_SYMBOL=TWRC AEGIS_STOP_AT=funded yarn localnet:launch
 */
import { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadRegistry } from "./registry";
import { loadAsset } from "./asset";
import { walkCurve } from "../lib/curve";

const USDC = 1_000_000n;

describe.runIf(process.env.AEGIS_LOCALNET === "1")("registry against a live node", () => {
  it("decodes every launch, its price, raise and backing", async () => {
    const registry = await loadRegistry(new Connection("http://127.0.0.1:8899", "confirmed"));
    const byName = new Map(registry.entries.map((e) => [e.label?.name, e]));
    expect(registry.unreadable).toBe(0);

    const a = byName.get("Aegis Tower A")!;
    expect(a.launch.stage).toBe("Live");
    expect(a.problems).toEqual([]);
    expect(a.label?.symbol).toBe("TWRA");
    expect(a.wrapperLabel?.symbol).toBe("cTWRA");
    expect(a.raise!.target).toBe(10_000n * USDC);
    // 6,200 USDC in, less the 1% curve fee, lands in the reserve.
    expect(a.raise!.raised).toBeGreaterThan(6_000n * USDC);
    expect(a.raise!.raised).toBeLessThanOrEqual(6_200n * USDC);
    // Default terms open at 1.00 and end at 1.21.
    expect(a.price!).toBeGreaterThan(1n * USDC);
    expect(a.price!).toBeLessThan(1_210_000n);
    expect(a.backing.kind).toBe("backed");

    const b = byName.get("Aegis Tower B")!;
    expect(b.launch.stage).toBe("Graduated");
    expect(b.problems).toEqual([]);
    expect(b.raise!.raised).toBe(10_000n * USDC);
    expect(b.price).toBeNull();
    expect(b.backing.kind).toBe("backed");

    const c = byName.get("Aegis Tower C")!;
    expect(c.launch.stage).toBe("Funded");
    expect(c.backing.kind).toBe("escrowed");
    expect(c.raise).toBeNull();

    // Sale terms, as scripts/localnet-launch.ts sets them (tests/helpers.ts defaultConfigArgs).
    const terms = a.detail.terms!;
    expect(terms.sqrtStartPrice).toBe(1n << 64n); // opens at exactly 1.00
    expect(terms.migrationFeePct).toBe(50);
    expect(terms.creatorMigrationFeePct).toBe(100); // Aegis takes no second cut of the raise
    expect(terms.curveFeeBps).toBe(100);
    expect(terms.creatorTradingFeePct).toBe(0);
    expect(terms.partnerPermanentPct).toBe(10);
    expect(terms.creatorPermanentPct).toBe(30);
    expect(terms.creatorVesting).toMatchObject({ percentage: 60, periods: 12, frequency: 2_592_000 });
    expect(terms.migratedPoolFeeBps).toBe(100);
    expect(terms.curve.length).toBeGreaterThan(0);

    // The curve maths reproduces what really happened on-chain.
    const toEnd = walkCurve(terms.sqrtStartPrice, terms.curve, terms.migrationSqrtPrice);
    expect(toEnd.quote).toBeGreaterThanOrEqual(terms.migrationQuoteThreshold - 10n);
    expect(toEnd.quote).toBeLessThanOrEqual(terms.migrationQuoteThreshold + 10n);
    const sold = walkCurve(terms.sqrtStartPrice, terms.curve, a.detail.pool!.sqrtPrice).base;
    const buyerReceived = 5_783_037_000n; // printed by the launch script for AEGIS_BUY=6200
    const diff = sold > buyerReceived ? sold - buyerReceived : buyerReceived - sold;
    expect(diff).toBeLessThan(1_000n); // within a thousandth of a token

    // The asset loader reads the same launch the registry does.
    const one = await loadAsset(new Connection("http://127.0.0.1:8899", "confirmed"), a.launch.realRwaMint);
    expect(one.launch.address.equals(a.launch.address)).toBe(true);
    expect(one.backing.kind).toBe("backed");

    console.log(
      registry.entries.map((e) => ({
        name: e.label?.name,
        stage: e.launch.stage,
        raised: e.raise?.raised.toString(),
        price: e.price?.toString(),
        backing: e.backing.kind,
      }))
    );
  });
});
