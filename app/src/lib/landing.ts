import type { Registry, RegistryEntry } from "../chain/registry";
import { formatUnits } from "./amount";

/**
 * What the landing page says about the registry, read from the chain like every other page. It
 * uses the same rules as the registry's totals, so the two can never disagree, and it has no
 * made-up activity: an empty registry gives empty numbers.
 */
export type LandingSummary = {
  /** Launches that were not withdrawn. */
  assets: number;
  open: number;
  /** Whole units of every asset held in escrow, summed. */
  escrowed: bigint;
  /** Whole wrappers in existence across launches whose wrapper exists, and the escrow behind them. */
  seal: { escrowed: bigint; circulating: bigint } | null;
  /** The currency the most was raised in, with the total. */
  raised: { symbol: string; decimals: number; total: bigint } | null;
  /** Every launch's backing, in one word. */
  backing: "all" | "short" | "unknown" | "none";
  short: number;
  /** The open offering closest to filling, for the banner. */
  featured: { entry: RegistryEntry; pct: number } | null;
  /** Lines for the moving ticker, one or two per launch. */
  tape: TapeItem[];
};

export type TapeItem = { key: string; text: string; strong?: string; tone: "plain" | "good" | "bad"; mint?: string };

export const entryName = (e: RegistryEntry) => e.label?.name || "Unnamed asset";

const whole = (atoms: bigint, decimals: number) => atoms / 10n ** BigInt(decimals);

/** Share of the raise reached, rounded down, so 99.6% never reads as 100% before graduation. */
export function raisePct(e: RegistryEntry): number | null {
  if (!e.raise || e.raise.target === 0n) return null;
  if (e.launch.stage === "Graduated") return 100;
  const pct = Number((e.raise.raised * 100n) / e.raise.target);
  return Math.min(99, pct);
}

export function summarize(registry: Registry | undefined): LandingSummary | null {
  if (!registry) return null;
  const active = registry.entries.filter((e) => e.launch.stage !== "Aborted");

  let escrowed = 0n;
  let sealEscrow = 0n;
  let sealCirc = 0n;
  let sealAny = false;
  const raised = new Map<string, { symbol: string; decimals: number; total: bigint }>();
  for (const e of active) {
    const b = e.backing;
    if (b.kind === "backed" || b.kind === "escrowed" || b.kind === "short") escrowed += whole(b.escrowed, e.launch.decimals);
    if (b.kind === "backed") {
      sealAny = true;
      sealEscrow += whole(b.escrowed, e.launch.decimals);
      sealCirc += whole(b.circulating, e.launch.decimals);
    }
    if (e.raise && e.quote) {
      const key = e.quote.mint.toBase58();
      const row = raised.get(key) ?? { symbol: e.quote.symbol, decimals: e.quote.decimals, total: 0n };
      row.total += e.raise.raised;
      raised.set(key, row);
    }
  }

  const short = active.filter((e) => e.backing.kind === "short").length;
  const unknown = active.filter((e) => e.backing.kind === "unknown").length;
  const checked = active.filter((e) => e.backing.kind === "backed" || e.backing.kind === "escrowed").length;
  const backing = short ? "short" : unknown ? "unknown" : checked ? "all" : "none";

  const live = active
    .filter((e) => e.launch.stage === "Live")
    .map((entry) => ({ entry, pct: raisePct(entry) }))
    .filter((f): f is { entry: RegistryEntry; pct: number } => f.pct !== null)
    .sort((a, b) => b.pct - a.pct);

  return {
    assets: active.length,
    open: active.filter((e) => e.launch.stage === "Live").length,
    escrowed,
    seal: sealAny ? { escrowed: sealEscrow, circulating: sealCirc } : null,
    raised: [...raised.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0))[0] ?? null,
    backing,
    short,
    featured: live[0] ?? null,
    tape: tapeItems(active, backing, checked),
  };
}

function tapeItems(active: RegistryEntry[], backing: LandingSummary["backing"], checked: number): TapeItem[] {
  const items: TapeItem[] = [];
  for (const e of active) {
    const name = entryName(e);
    const mint = e.launch.realRwaMint.toBase58();
    const wrapper = e.wrapperLabel?.symbol;
    switch (e.launch.stage) {
      case "Live": {
        const pct = raisePct(e);
        const price = e.price !== null && e.quote ? ` · ${wrapper ?? "wrapper"} at ${formatUnits(e.price, e.quote.decimals, { maxFraction: 4 })} ${e.quote.symbol}` : "";
        items.push({ key: `${mint}-live`, strong: name, text: `${pct ?? 0}% of its raise${price}`, tone: "plain", mint });
        break;
      }
      case "Graduated":
        items.push({ key: `${mint}-grad`, strong: name, text: "graduated · the bridge is open", tone: "plain", mint });
        break;
      case "Funded":
      case "Configured":
        items.push({ key: `${mint}-esc`, strong: name, text: `${formatUnits(whole(e.launch.totalSupply, e.launch.decimals), 0)} units in escrow · sale opening soon`, tone: "plain", mint });
        break;
      case "TokenCreated":
        items.push({ key: `${mint}-filed`, strong: name, text: "filed", tone: "plain", mint });
        break;
    }
    if (e.backing.kind === "short") items.push({ key: `${mint}-short`, strong: name, text: "backing short · its bridge has stopped", tone: "bad", mint });
  }
  if (backing === "all") items.push({ key: "backing", text: `Backing verified · ${checked === 1 ? "the funded entry is" : `all ${checked} funded entries are`} 1 : 1`, tone: "good" });
  return items;
}
