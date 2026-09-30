import { describe, expect, it } from "vitest";
import { assessBacking } from "./backing";

const M = 1_000_000n;

describe("assessBacking", () => {
  it("never calls a launch backed when a read failed", () => {
    expect(assessBacking({ stage: "Live", totalSupply: M }).kind).toBe("unknown");
    expect(assessBacking({ stage: "Live", totalSupply: M, escrowed: M }).kind).toBe("unknown");
    expect(assessBacking({ stage: "Funded", totalSupply: M }).kind).toBe("unknown");
  });
  it("is backed when escrow covers circulation exactly or with the issuer's unsold on top", () => {
    expect(assessBacking({ stage: "Live", totalSupply: M, escrowed: M, circulating: M }).kind).toBe("backed");
    expect(assessBacking({ stage: "Graduated", totalSupply: M, escrowed: M, circulating: 958_750n }).kind).toBe("backed");
  });
  it("reports the exact shortfall when escrow is below circulation", () => {
    expect(assessBacking({ stage: "Graduated", totalSupply: M, escrowed: M - 1n, circulating: M })).toEqual({
      kind: "short",
      escrowed: M - 1n,
      required: M,
    });
  });
  it("before the wrapper exists, requires the whole issue in escrow", () => {
    expect(assessBacking({ stage: "Configured", totalSupply: M, escrowed: M }).kind).toBe("escrowed");
    expect(assessBacking({ stage: "Funded", totalSupply: M, escrowed: M / 2n }).kind).toBe("short");
  });
  it("names the stages with nothing to back", () => {
    expect(assessBacking({ stage: "TokenCreated", totalSupply: M }).kind).toBe("not-funded");
    expect(assessBacking({ stage: "Aborted", totalSupply: M }).kind).toBe("withdrawn");
  });
});
