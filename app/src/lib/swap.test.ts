import { describe, expect, it } from "vitest";
import { walkCurve } from "./curve";
import { quoteBuy, quoteSell, remainingToFill, withSlippage, type CurveState } from "./swap";

const Q64 = 1n << 64n;
const USDC = 1_000_000n;
// Opens at 1.00, sale ends at 1.21, one more segment beyond it (as Aegis curves have).
const start = Q64;
const migration = (Q64 * 11n) / 10n;
const curve = [
  { sqrtPrice: migration, liquidity: 150_000n * USDC * Q64 },
  { sqrtPrice: (Q64 * 12n) / 10n, liquidity: 150_000n * USDC * Q64 },
];
const fresh: CurveState = { sqrtPrice: start, sqrtStartPrice: start, migrationSqrtPrice: migration, curve, feeNumerator: 10_000_000n }; // 1%

describe("quoteBuy", () => {
  it("takes 1% of the input as fee, rounded up, and moves the price up", () => {
    const q = quoteBuy(fresh, 500n * USDC)!;
    expect(q.fee).toBe(5n * USDC);
    expect(q.spend).toBe(500n * USDC);
    expect(q.fillsSale).toBe(false);
    expect(q.nextSqrt).toBeGreaterThan(start);
    // Matches the curve: the tokens out are the base between the old and new price (floor).
    expect(q.out).toBe(walkCurve(start, curve, q.nextSqrt).base);
  });

  it("rounds a fee on a tiny amount up, never down to zero", () => {
    expect(quoteBuy(fresh, 1n)!.fee).toBe(1n);
  });

  it("fills the sale and uses only what fits when the buy is too big", () => {
    const need = remainingToFill(fresh);
    const q = quoteBuy(fresh, need * 3n)!;
    expect(q.fillsSale).toBe(true);
    expect(q.nextSqrt).toBe(migration);
    expect(q.spend).toBe(need);
    expect(q.spend).toBeLessThan(need * 3n);
  });

  it("returns nothing for zero", () => {
    expect(quoteBuy(fresh, 0n)).toBeNull();
  });
});

describe("quoteSell", () => {
  const afterBuy = (amount: bigint) => {
    const q = quoteBuy(fresh, amount)!;
    return { state: { ...fresh, sqrtPrice: q.nextSqrt }, bought: q.out };
  };

  it("never pays back more than was paid in: buying then selling loses the fees", () => {
    const { state, bought } = afterBuy(1_000n * USDC);
    const s = quoteSell(state, bought)!;
    expect(s.out).toBeLessThan(1_000n * USDC);
    expect(s.out).toBeGreaterThan(970n * USDC); // about two 1% fees
    expect(s.nextSqrt).toBeGreaterThanOrEqual(start);
  });

  it("refuses to sell more than the curve has sold", () => {
    const { state, bought } = afterBuy(100n * USDC);
    expect(quoteSell(state, bought * 2n)).toBeNull();
    expect(quoteSell(fresh, 1n * USDC)).toBeNull(); // nothing sold yet
  });
});

describe("withSlippage", () => {
  it("accepts slightly less, rounded down", () => {
    expect(withSlippage(1_000_000n, 100)).toBe(990_000n);
    expect(withSlippage(999n, 50)).toBe(994n);
  });
});
