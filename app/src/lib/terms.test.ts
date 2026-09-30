import { describe, expect, it } from "vitest";
import { baseBetween, quoteBetween } from "./curve";
import { MAX_SQRT_BPS, MAX_SQRT_PRICE, MIN_SQRT_PRICE, isqrt, limitProblems, migrationSplit, planCurve, previewTerms, priceMultiple, priceToSqrt } from "./terms";

const ONE = 1n << 64n;
const plan = (bps: number, a: "FixedPar" | "BookBuilding" | "GrowthCapital") => planCurve(ONE, bps, 1_000_000_000_000n, a, 10_000_000_000_000n);

// The program's own tests in programs/aegis/src/curve.rs, reproduced.
describe("planCurve (curve.rs)", () => {
  it("sqrt bps squares to the advertised price multiple", () => {
    expect(Math.abs(Math.floor((MAX_SQRT_BPS.FixedPar ** 2) / 10_000) - 10_200)).toBeLessThanOrEqual(2);
    expect(Math.abs(Math.floor((MAX_SQRT_BPS.BookBuilding ** 2) / 10_000) - 12_500)).toBeLessThanOrEqual(2);
    expect(Math.abs(Math.floor((MAX_SQRT_BPS.GrowthCapital ** 2) / 10_000) - 15_000)).toBeLessThanOrEqual(2);
  });
  it("end price matches the requested expansion", () => {
    const p = plan(11_000, "BookBuilding");
    expect(p.ok && p.plan.sqrtEnd).toBe((ONE * 11_000n) / 10_000n);
  });
  it("the sale closes at or below the endpoint", () => {
    for (const bps of [10_001, 10_099, 11_000, 11_180]) {
      const p = plan(bps, bps <= 10_099 ? "FixedPar" : "BookBuilding");
      expect(p.ok).toBe(true);
      if (p.ok) { expect(p.plan.migrationSqrt <= p.plan.sqrtEnd).toBe(true); expect(p.plan.migrationSqrt > p.plan.sqrtStart).toBe(true); }
    }
  });
  it("rejects expansion beyond the archetype, and accepts exactly the ceiling", () => {
    expect(plan(10_100, "FixedPar")).toEqual({ ok: false, error: "PriceExpansionExceedsRwaLimit" });
    expect(plan(11_181, "BookBuilding")).toEqual({ ok: false, error: "PriceExpansionExceedsRwaLimit" });
    expect(plan(12_248, "GrowthCapital")).toEqual({ ok: false, error: "PriceExpansionExceedsRwaLimit" });
    expect(plan(10_099, "FixedPar").ok && plan(11_180, "BookBuilding").ok && plan(12_247, "GrowthCapital").ok).toBe(true);
  });
  it("rejects a flat or falling curve, a zero raise, prices outside Meteora's range, and too small a supply", () => {
    expect(plan(10_000, "BookBuilding").ok || plan(9_000, "BookBuilding").ok).toBe(false);
    expect(planCurve(ONE, 11_000, 0n, "BookBuilding", 10n ** 13n)).toEqual({ ok: false, error: "InvalidQuoteThreshold" });
    expect(planCurve(MIN_SQRT_PRICE - 1n, 11_000, 10n ** 12n, "BookBuilding", 10n ** 13n)).toEqual({ ok: false, error: "InvalidStartPrice" });
    expect(planCurve(MAX_SQRT_PRICE, 11_000, 10n ** 12n, "BookBuilding", 10n ** 13n)).toEqual({ ok: false, error: "InvalidStartPrice" });
    expect(planCurve(ONE, 11_000, 10n ** 18n, "BookBuilding", 1_000n)).toEqual({ ok: false, error: "SupplyTooSmallForCurve" });
  });
  it("the curve holds at least the target raise", () => {
    for (const raise of [1n, 1_000n, 1_000_000_000_000n, 4_294_967_295n]) {
      const p = planCurve(ONE, 11_000, raise, "BookBuilding", 2n ** 64n - 1n);
      expect(p.ok).toBe(true);
      if (p.ok) expect(quoteBetween(p.plan.sqrtStart, p.plan.sqrtEnd, p.plan.liquidity) + 1n >= raise).toBe(true);
    }
  });
});

describe("terms helpers", () => {
  it("isqrt is exact", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 8n, 99n, 10n ** 30n, (1n << 128n) / 1000n, 2n ** 128n - 1n, 2n ** 128n, 2n ** 200n + 12345n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
  });
  it("prices one whole token at the requested quote amount", () => {
    // 1 USDC (6 dp) per token (6 dp) is a price ratio of 1, so sqrt price is exactly 2^64.
    expect(priceToSqrt(1_000_000n, 6)).toBe(ONE);
    // The localnet default: 1.00 USDC opening, 1.21x ceiling, 10,000 USDC raise sells ~9,091 tokens.
    const p = planCurve(priceToSqrt(1_000_000n, 6), 11_000, 10_000_000_000n, "BookBuilding", 10n ** 12n);
    expect(p.ok && Number(p.plan.baseSold) / 1e6).toBeCloseTo(9090.9, 0);
    expect(priceMultiple(11_000)).toBeCloseTo(1.21);
    expect(baseBetween(1n, 1n, 1n)).toBe(0n);
  });
  it("splits the raise like Meteora", () => {
    expect(migrationSplit(10_000_000_000n, 50)).toEqual({ toPool: 5_000_000_000n, fee: 5_000_000_000n });
    expect(migrationSplit(101n, 50)).toEqual({ toPool: 51n, fee: 50n });
  });
});

describe("previewTerms", () => {
  const limits = { aegisMigrationFeeSharePct: 0, aegisLpSharePct: 10, minMigrationFeePct: 1, maxMigrationFeePct: 90, minIssuerPermanentPct: 10, minVestingMonths: 1, maxVestingMonths: 24, minPoolFeeBps: 10, maxPoolFeeBps: 300 };
  const terms = { quoteAtomsPerToken: 1_000_000n, archetype: "BookBuilding" as const, sqrtBps: 11_000, targetRaise: 10_000_000_000n, migrationFeePct: 50, permanentPct: 30, vestedPct: 60, vestingMonths: 12, poolFeeBps: 100 };
  it("matches the design board's example: 1.00 USDC, 1.21x, 10,000 USDC, 50% cash", () => {
    const r = previewTerms(terms, limits, 10n ** 12n, 6);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.preview.plan.baseSold) / 1e6).toBeCloseTo(9091, 0);
    expect(Number(r.preview.endPrice) / 1e6).toBeCloseTo(1.21, 2);
    expect(r.preview.cashToIssuer).toBe(5_000_000_000n);
    expect(r.preview.poolQuote).toBe(5_000_000_000n);
    expect(Number(r.preview.poolBase) / 1e6).toBeCloseTo(4132, 0);
    expect(Number(r.preview.unsold) / 1e6).toBeCloseTo(986_777, -1);
  });
  it("names every limit an answer breaks", () => {
    expect(limitProblems(terms, limits, 1_000_000_000n)).toEqual([]);
    expect(limitProblems({ ...terms, targetRaise: 1n, migrationFeePct: 95, permanentPct: 5, vestedPct: 60, poolFeeBps: 5 }, limits, 1_000_000_000n)).toHaveLength(5);
  });
});
