import { NATIVE_MINT } from "@solana/spl-token";
import type { Registry, RegistryEntry } from "../chain/registry";
import { formatPrice, formatUnits } from "./amount";

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
  /** The total raised in each currency: dollar tokens first, then by whole units. The first is the headline. */
  raised: RaisedTotal[];
  /** Every launch's backing, in one word. */
  backing: "all" | "short" | "unknown" | "none";
  short: number;
  /** The open offering closest to filling, for the banner. */
  featured: { entry: RegistryEntry; pct: number } | null;
  /** Lines for the moving ticker, one or two per launch. */
  tape: TapeItem[];
};

export type RaisedTotal = { mint: string; symbol: string; decimals: number; total: bigint; sol: boolean };

export type TapeItem = { key: string; text: string; strong?: string; tone: "plain" | "good" | "bad"; mint?: string };

const cmp = (a: bigint, b: bigint) => (a > b ? 1 : a < b ? -1 : 0);

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
  const raised = new Map<string, RaisedTotal>();
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
      const row = raised.get(key) ?? { mint: key, symbol: e.quote.symbol, decimals: e.quote.decimals, total: 0n, sol: e.quote.mint.equals(NATIVE_MINT) };
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
    // Raw totals can't be compared across currencies: a SOL atom and a USDC atom are worth different
    // amounts and even have different decimals. Dollar tokens lead, as they do in the launch form.
    raised: [...raised.values()].filter((r) => r.total > 0n).sort((a, b) => Number(a.sol) - Number(b.sol) || cmp(b.total / 10n ** BigInt(b.decimals), a.total / 10n ** BigInt(a.decimals))),
    backing,
    short,
    featured: live[0] ?? null,
    tape: tapeItems(active, backing, checked),
  };
}

/** Most lines the ticker shows. It is a glance at what's happening, not a list of everything. */
export const TAPE_MAX = 12;

/**
 * The ticker's lines, most important first and never more than TAPE_MAX: any shortfall (never
 * hidden), the live sales closest to filling, graduations, sales about to open, then the backing
 * check and how many assets the registry holds in all.
 */
function tapeItems(active: RegistryEntry[], backing: LandingSummary["backing"], checked: number): TapeItem[] {
  const line = (e: RegistryEntry): TapeItem | null => {
    const name = entryName(e);
    const mint = e.launch.realRwaMint.toBase58();
    const wrapper = e.wrapperLabel?.symbol;
    switch (e.launch.stage) {
      case "Live": {
        const pct = raisePct(e);
        const price = e.price !== null && e.quote ? ` · ${wrapper ?? "wrapper"} at ${formatPrice(e.price, e.quote.decimals)} ${e.quote.symbol}` : "";
        return { key: `${mint}-live`, strong: name, text: `${pct ?? 0}% of its raise${price}`, tone: "plain", mint };
      }
      case "Graduated":
        return { key: `${mint}-grad`, strong: name, text: "graduated · the bridge is open", tone: "plain", mint };
      case "Funded":
      case "Configured":
        return { key: `${mint}-esc`, strong: name, text: `${formatUnits(whole(e.launch.totalSupply, e.launch.decimals), 0)} units in escrow · sale opening soon`, tone: "plain", mint };
      default:
        return null;
    }
  };
  const short: TapeItem[] = active
    .filter((e) => e.backing.kind === "short")
    .map((e) => ({ key: `${e.launch.realRwaMint.toBase58()}-short`, strong: entryName(e), text: "backing short · its bridge has stopped", tone: "bad", mint: e.launch.realRwaMint.toBase58() }));
  const live = active.filter((e) => e.launch.stage === "Live").sort((a, b) => (raisePct(b) ?? 0) - (raisePct(a) ?? 0));
  const graduated = active.filter((e) => e.launch.stage === "Graduated");
  const opening = active.filter((e) => e.launch.stage === "Funded" || e.launch.stage === "Configured");
  const footer: TapeItem[] = [];
  if (backing === "all") footer.push({ key: "backing", text: `Backing verified · ${checked === 1 ? "the funded entry is" : `all ${checked.toLocaleString("en-US")} funded entries are`} 1 : 1`, tone: "good" });
  const room = TAPE_MAX - footer.length - 1;
  const picked = [...short, ...[...live, ...graduated, ...opening].map(line).filter((l): l is TapeItem => l !== null)].slice(0, room);
  const items = [...picked, ...footer];
  if (active.length > picked.length) items.push({ key: "count", text: `${active.length.toLocaleString("en-US")} assets in the registry`, tone: "plain" });
  return items;
}
