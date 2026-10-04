import { describe, expect, it } from "vitest";
import { fetchUsdPrices } from "../chain/prices";
import { formatUsd, totalUsd, unpricedNote } from "./usd";

const SOL = "So11111111111111111111111111111111111111112";

describe("fetchUsdPrices", () => {
  it("counts stablecoins at a dollar without asking anyone", async () => {
    const asked: string[] = [];
    const prices = await fetchUsdPrices([{ mint: "usdc", symbol: "USDC" }], async (u) => { asked.push(u); return {}; });
    expect(prices.get("usdc")).toBe(1);
    expect(asked).toEqual([]);
  });

  it("prices the rest from Jupiter by mint, falling back to Coinbase by symbol", async () => {
    const prices = await fetchUsdPrices([{ mint: SOL, symbol: "SOL" }, { mint: "devnetonly", symbol: "BONK" }, { mint: "nowhere", symbol: "ZZZ" }], async (u) => {
      if (u.includes("jup.ag")) return { [SOL]: { usdPrice: 121.3 } };
      if (u.includes("BONK-USD")) return { data: { amount: "0.00002" } };
      throw new Error("404");
    });
    expect(prices.get(SOL)).toBe(121.3);
    expect(prices.get("devnetonly")).toBe(0.00002);
    expect(prices.has("nowhere")).toBe(false);
  });

  it("still prices from Coinbase when Jupiter is down", async () => {
    const prices = await fetchUsdPrices([{ mint: SOL, symbol: "SOL" }], async (u) => {
      if (u.includes("jup.ag")) throw new Error("503");
      return { data: { amount: "120.5" } };
    });
    expect(prices.get(SOL)).toBe(120.5);
  });
});

describe("totalUsd", () => {
  it("adds every currency up in dollars, whatever its decimals", () => {
    const { usd, unpriced } = totalUsd(
      [
        { mint: "usdc", symbol: "USDC", decimals: 6, atoms: 1_188_000_000n }, // 1,188 USDC
        { mint: SOL, symbol: "SOL", decimals: 9, atoms: 1_500_000_000n }, // 1.5 SOL
      ],
      new Map([["usdc", 1], [SOL, 120]])
    );
    expect(usd).toBe(1_368);
    expect(unpriced).toEqual([]);
  });

  it("names what it couldn't price instead of counting it as nothing", () => {
    const { usd, unpriced } = totalUsd([{ mint: "x", symbol: "XYZ", decimals: 6, atoms: 5n }, { mint: "y", symbol: "ABC", decimals: 6, atoms: 0n }], new Map());
    expect(usd).toBe(0);
    expect(unpriced).toEqual(["XYZ"]);
  });
});

describe("formatUsd", () => {
  it("reads like money at every size", () => {
    expect(formatUsd(1_368)).toBe("$1,368");
    expect(formatUsd(123.456)).toBe("$123.46");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("unpricedNote", () => {
  it("names one or two, and counts more, so the line never grows with the currency list", () => {
    expect(unpricedNote([])).toBeNull();
    expect(unpricedNote(["XYZ", "ABC"])).toBe("Not counted: XYZ and ABC (no price right now)");
    expect(unpricedNote(["A", "B", "C", "D"])).toBe("Not counted: 4 currencies with no price right now");
  });
});
