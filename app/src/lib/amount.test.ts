import { describe, expect, it } from "vitest";
import { formatUnits, percentOf, shortAddress, sqrtPriceToQuoteAtoms } from "./amount";

describe("formatUnits", () => {
  it("groups thousands and trims trailing zeros", () => {
    expect(formatUnits(1_000_000_000_000n, 6)).toBe("1,000,000");
    expect(formatUnits(1_234_500n, 6)).toBe("1.2345");
  });
  it("cuts extra digits instead of rounding up", () => {
    expect(formatUnits(1_999_999n, 6, { maxFraction: 2 })).toBe("1.99");
  });
  it("pads to a minimum", () => {
    expect(formatUnits(5_000_000n, 6, { minFraction: 2 })).toBe("5.00");
  });
  it("handles zero, sub-unit and 9 decimals", () => {
    expect(formatUnits(0n, 6)).toBe("0");
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(123_456_789_000_000_000n, 9, { maxFraction: 3 })).toBe("123,456,789");
  });
});

describe("sqrtPriceToQuoteAtoms", () => {
  const Q64 = 1n << 64n;
  it("reads a price of exactly 1 with equal decimals", () => {
    // sqrt(1) in Q64.64, per atom; one whole token (1e6 atoms) costs 1e6 quote atoms.
    expect(sqrtPriceToQuoteAtoms(Q64, 6)).toBe(1_000_000n);
  });
  it("reads 1.21 as 1.1 squared", () => {
    const sqrt = (Q64 * 11n) / 10n;
    expect(sqrtPriceToQuoteAtoms(sqrt, 6)).toBe(1_209_999n); // floor of 1.21 USDC, never above
  });
});

describe("percentOf", () => {
  it("floors, clamps and treats an empty target as zero", () => {
    expect(percentOf(6_200n, 10_000n)).toBe(62);
    expect(percentOf(9_999n, 10_000n)).toBe(99);
    expect(percentOf(12_000n, 10_000n)).toBe(100);
    expect(percentOf(5n, 0n)).toBe(0);
  });
});

describe("shortAddress", () => {
  it("keeps both ends", () => {
    expect(shortAddress("FRR7Ff4HW8nPdutTGQmRGoEzkkoqTk57Vy7bfpnMtFy")).toBe("FRR7…MtFy");
  });
});
