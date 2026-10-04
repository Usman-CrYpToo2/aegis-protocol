import { describe, expect, it } from "vitest";
import { formatMoney, formatPrice, formatUnits, parseUnits, percentOf, shortAddress, sqrtPriceToQuoteAtoms, toInputText } from "./amount";

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

describe("parseUnits", () => {
  const ok = (s: string, d = 6) => { const r = parseUnits(s, d); return r.ok ? r.atoms : r.reason; };
  it("reads plain amounts exactly", () => {
    expect(ok("250")).toBe(250_000_000n);
    expect(ok("12.5")).toBe(12_500_000n);
    expect(ok(".5")).toBe(500_000n);
    expect(ok("0.000001")).toBe(1n);
    expect(ok("1,000")).toBe(1_000_000_000n);
    expect(ok(" 7 ")).toBe(7_000_000n);
  });
  it("rejects anything ambiguous or impossible, with a reason", () => {
    expect(ok("")).toBe("Enter an amount");
    expect(ok("0")).toBe("Enter more than zero");
    expect(ok("1,5")).toMatch(/digits only/);
    expect(ok("-3")).toMatch(/digits only/);
    expect(ok("1e6")).toMatch(/digits only/);
    expect(ok("1.2.3")).toMatch(/digits only/);
    expect(ok("0.0000001")).toMatch(/At most 6/);
    expect(ok("99999999999999999999")).toMatch(/too large/);
  });
  it("round-trips a max amount into the input", () => {
    expect(toInputText(12_345_670_000n, 6)).toBe("12345.67");
  });
});

describe("formatMoney", () => {
  it("shows as many decimals as the size of the amount calls for", () => {
    expect(formatMoney(10_000_000_000n, 6)).toBe("10,000"); // 10,000 USDC
    expect(formatMoney(12_345_678n, 6)).toBe("12.34");
    expect(formatMoney(850_000_000n, 9)).toBe("0.85"); // 0.85 SOL, not "0"
    expect(formatMoney(1_234_567n, 9)).toBe("0.0012");
    expect(formatMoney(0n, 9)).toBe("0");
  });
});

describe("formatPrice", () => {
  it("rounds a square-root price back to what the issuer set", () => {
    expect(formatPrice(4_999_999n, 6)).toBe("5.00"); // a 5.00 opening price, read back from the curve
    expect(formatPrice(49_999_900n, 6)).toBe("50.00");
    expect(formatPrice(49_999_999n, 9)).toBe("0.05"); // 0.05 SOL
    expect(formatPrice(5_270_500n, 6)).toBe("5.271");
    expect(formatPrice(7_499_400n, 6)).toBe("7.499");
    expect(formatPrice(1_234_567_000n, 6)).toBe("1,235");
    expect(formatPrice(0n, 6)).toBe("0");
  });
});
