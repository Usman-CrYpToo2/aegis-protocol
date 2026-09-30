import { describe, expect, it } from "vitest";
import { baseBetween, ceilingPrice, quoteBetween, sampleCurve, sqrtAtSold, walkCurve } from "./curve";

const Q64 = 1n << 64n;

describe("curve math", () => {
  // A segment where one unit of price-range buys a known amount.
  const L = 1_000_000n * Q64; // liquidity in Q64 units
  const a = Q64; // price 1.0
  const b = (Q64 * 11n) / 10n; // price 1.21

  it("matches the closed forms for one segment", () => {
    // base = L (b-a)/(ab) = 1e6 * (0.1)/(1.1) in atoms ≈ 90,909
    expect(baseBetween(a, b, L)).toBe(90_909n);
    // quote = L (b-a) / 2^128 = 1e6 * 0.1 = 100,000 (floor)
    expect(quoteBetween(a, b, L)).toBe(99_999n);
  });

  it("is zero for an empty or reversed range", () => {
    expect(baseBetween(b, a, L)).toBe(0n);
    expect(quoteBetween(a, a, L)).toBe(0n);
  });

  it("walks across several segments and stops at the target", () => {
    const mid = (Q64 * 105n) / 100n;
    const curve = [
      { sqrtPrice: mid, liquidity: L },
      { sqrtPrice: b, liquidity: L },
    ];
    const whole = walkCurve(a, curve, b);
    const one = walkCurve(a, [{ sqrtPrice: b, liquidity: L }], b);
    // Splitting a segment in two only changes rounding, by at most one atom per segment.
    expect(whole.base - one.base).toBeLessThanOrEqual(1n);
    expect(walkCurve(a, curve, mid).base).toBe(baseBetween(a, mid, L));
    expect(walkCurve(a, curve, a).base).toBe(0n);
  });

  it("samples from the start price to the end, rising", () => {
    const pts = sampleCurve(a, [{ sqrtPrice: b, liquidity: L }], b, 6, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual({ sold: 0n, price: 1_000_000n });
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.price).toBeGreaterThan(pts[i - 1]!.price);
      expect(pts[i]!.sold).toBeGreaterThan(pts[i - 1]!.sold);
    }
  });

  it("puts the Book Building ceiling at 1.25", () => {
    // sqrt 1.118 squared = 1.2499…, floored in atoms
    expect(ceilingPrice(Q64, 11_180n, 6)).toBe(1_249_923n);
  });

  it("inverts: the price after selling N tokens sells N tokens", () => {
    const mid = (Q64 * 105n) / 100n;
    const curve = [
      { sqrtPrice: mid, liquidity: L },
      { sqrtPrice: b, liquidity: 2n * L },
    ];
    const total = walkCurve(a, curve, b).base;
    for (const n of [0n, 1n, 1_000n, total / 3n, total / 2n, total - 1n]) {
      const back = walkCurve(a, curve, sqrtAtSold(a, curve, n)).base;
      const diff = back > n ? back - n : n - back;
      expect(diff, `n=${n}`).toBeLessThanOrEqual(2n);
    }
    expect(sqrtAtSold(a, curve, total * 2n)).toBe(b); // past the end, clamps to it
  });
});
