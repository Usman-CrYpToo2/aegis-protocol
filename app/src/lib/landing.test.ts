import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { LaunchStage } from "../chain/aegis";
import type { Backing } from "../chain/backing";
import type { Registry, RegistryEntry } from "../chain/registry";
import { raisePct, summarize } from "./landing";

const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const M = 1_000_000n;

function entry(name: string, stage: LaunchStage, backing: Backing, raise?: [bigint, bigint]): RegistryEntry {
  return {
    launch: { realRwaMint: Keypair.generate().publicKey, stage, decimals: 6, totalSupply: 1000n * M } as RegistryEntry["launch"],
    label: { name, symbol: name.slice(0, 4).toUpperCase() } as RegistryEntry["label"],
    wrapperLabel: null,
    backing,
    quote: { mint: USDC, symbol: "USDC", decimals: 6 },
    price: null,
    raise: raise ? { raised: raise[0] * M, target: raise[1] * M } : null,
    problems: [],
    detail: {},
  };
}
const reg = (entries: RegistryEntry[]): Registry => ({ entries, unreadable: 0, readAt: 0 });

describe("summarize", () => {
  it("says nothing before the registry has loaded, and zeros for an empty one", () => {
    expect(summarize(undefined)).toBeNull();
    const s = summarize(reg([]))!;
    expect(s).toMatchObject({ assets: 0, open: 0, escrowed: 0n, seal: null, raised: null, backing: "none", featured: null, tape: [] });
  });

  it("adds up escrow, the seal and the raise across launches", () => {
    const s = summarize(reg([
      entry("Tower A", "Live", { kind: "backed", escrowed: 1000n * M, circulating: 400n * M }, [600n, 1000n]),
      entry("Tower B", "Graduated", { kind: "backed", escrowed: 500n * M, circulating: 500n * M }, [2000n, 2000n]),
      entry("Tower C", "Funded", { kind: "escrowed", escrowed: 1000n * M }),
      entry("Gone", "Aborted", { kind: "withdrawn" }),
    ]))!;
    expect(s.assets).toBe(3);
    expect(s.open).toBe(1);
    expect(s.escrowed).toBe(2500n);
    expect(s.seal).toEqual({ escrowed: 1500n, circulating: 900n });
    expect(s.raised).toMatchObject({ symbol: "USDC", total: 2600n * M });
    expect(s.backing).toBe("all");
    expect(s.featured?.pct).toBe(60);
    expect(s.tape.map((t) => t.strong ?? t.text)).toEqual(["Tower A", "Tower B", "Tower C", "Backing verified · all 3 funded entries are 1 : 1"]);
  });

  it("never hides a shortfall", () => {
    const s = summarize(reg([
      entry("Good", "Live", { kind: "backed", escrowed: M, circulating: M }, [1n, 10n]),
      entry("Bad", "Live", { kind: "short", escrowed: M, required: 2n * M }, [1n, 10n]),
    ]))!;
    expect(s.backing).toBe("short");
    expect(s.short).toBe(1);
    expect(s.tape.some((t) => t.tone === "bad" && t.strong === "Bad")).toBe(true);
    expect(s.tape.some((t) => t.tone === "good")).toBe(false);
  });
});

describe("raisePct", () => {
  it("rounds down and only says 100 once graduated", () => {
    expect(raisePct(entry("x", "Live", { kind: "unknown", reason: "" }, [999n, 1000n]))).toBe(99);
    expect(raisePct(entry("x", "Graduated", { kind: "unknown", reason: "" }, [1000n, 1000n]))).toBe(100);
    expect(raisePct(entry("x", "Live", { kind: "unknown", reason: "" }))).toBeNull();
  });
});
