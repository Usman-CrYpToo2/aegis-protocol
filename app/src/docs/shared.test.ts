import { describe, expect, it } from "vitest";
import { DOC_PAGES } from "./content";
import { EXAMPLE, figures } from "./shared";

describe("docs", () => {
  it("the worked example is what the planner computes", () => {
    expect(EXAMPLE).toMatchObject({ sold: "9,091", close: "1.21", average: "1.10", cash: "5,000", poolQuote: "5,000", poolBase: "4,132" });
    expect(Number(EXAMPLE.unsold.replace(/,/g, ""))).toBeCloseTo(986_777, -1);
    const s = EXAMPLE.shares;
    expect(s.sold + s.pool + s.unsold).toBeCloseTo(1, 2);
  });
  it("falls back to the program defaults when the platform can't be read", () => {
    expect(figures(undefined)).toMatchObject({ live: false, creationFee: "1 SOL", saleFee: "1%", meteoraCut: "0.2%", aegisCut: "0.8%", cash: "1–90%", aegisLp: "10%", vesting: "3 to 24 months", poolFee: "0.1% to 3%" });
  });
  it("every page has a unique address", () => {
    const slugs = DOC_PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
