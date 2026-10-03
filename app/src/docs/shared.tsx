import type { ReactNode } from "react";
import { explorerUrl } from "../config";
import { GRADUATION_DEPOSIT_LAMPORTS } from "../chain/graduate";
import { METEORA_PROTOCOL_FEE_PCT } from "../chain/meteora";
import type { Platform } from "../chain/platform";
import { formatUnits } from "../lib/amount";
import { ARCHETYPE_CEILING } from "../lib/curve";
import { poolFeeRange, previewTerms, type PlatformLimits } from "../lib/terms";

/** Shared by every docs page: the live platform figures, the worked example and small helpers. */

const pct = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")}%`;

/** The program's defaults (initialize_platform.rs), used only while the live settings can't be read. */
const DEFAULTS = { creationFeeLamports: 1_000_000_000n, curveFeeBps: 100, issuerCurveFeeSharePct: 0, aegisLpSharePct: 10, minMigrationFeePct: 1, maxMigrationFeePct: 90, minIssuerPermanentPct: 0, minVestingMonths: 3, maxVestingMonths: 24, minPoolFeeBps: 10, maxPoolFeeBps: 300, aegisMigrationFeeSharePct: 0 };

export type Figures = ReturnType<typeof figures>;

export function figures(platform: Platform | undefined) {
  const p = platform?.config ?? DEFAULTS;
  const fee = p.curveFeeBps / 100;
  const meteora = (fee * METEORA_PROTOCOL_FEE_PCT) / 100;
  const issuer = ((fee - meteora) * p.issuerCurveFeeSharePct) / 100;
  const range = poolFeeRange(p);
  return {
    live: Boolean(platform),
    creationFee: `${formatUnits(p.creationFeeLamports, 9, { maxFraction: 3 })} SOL`,
    saleFee: pct(fee),
    meteoraCut: pct(meteora),
    aegisCut: pct(fee - meteora - issuer),
    issuerCut: issuer ? pct(issuer) : null,
    cash: `${p.minMigrationFeePct}–${p.maxMigrationFeePct}%`,
    aegisLp: `${p.aegisLpSharePct}%`,
    issuerLp: `${100 - p.aegisLpSharePct}%`,
    minPermanent: `${p.minIssuerPermanentPct}%`,
    vesting: `${Math.max(1, p.minVestingMonths)} to ${p.maxVestingMonths} months`,
    poolFee: `${pct(range.min / 100)} to ${pct(range.max / 100)}`,
    quotes: platform?.quotes.filter((q) => q.isActive).map((q) => ({ symbol: q.symbol, mint: q.mint.toBase58(), minRaise: formatUnits(q.minRaise, q.decimals, { maxFraction: 2 }) })) ?? [],
  };
}

export const ceilings = Object.values(ARCHETYPE_CEILING);
export const ceilingLabel = (m: string) => m.replace(/0×$/, "×");
export const gradDeposit = formatUnits(GRADUATION_DEPOSIT_LAMPORTS, 9, { maxFraction: 3 });
export const Addr = ({ id }: { id: string }) => (
  <a href={explorerUrl("address", id)} target="_blank" rel="noopener noreferrer" className="font-mono text-[13px] break-all text-blue underline underline-offset-2">{id}</a>
);




export type DocPage = { slug: string; group: string; title: string; summary: string; body: (f: Figures) => ReactNode };

/**
 * The worked example used across the docs, computed by the same planner the launch form uses, so
 * its numbers are exactly what the app would show: 1,000,000 units, opening at 1.00 USDC, a Book
 * building sale allowed to rise to 1.21×, a 10,000 USDC raise and 50% cash.
 */
export const EXAMPLE = (() => {
  const limits: PlatformLimits = { aegisMigrationFeeSharePct: 0, aegisLpSharePct: 10, minMigrationFeePct: 1, maxMigrationFeePct: 90, minIssuerPermanentPct: 0, minVestingMonths: 3, maxVestingMonths: 24, minPoolFeeBps: 10, maxPoolFeeBps: 300 };
  const supply = 1_000_000n * 1_000_000n;
  const r = previewTerms({ quoteAtomsPerToken: 1_000_000n, archetype: "BookBuilding", sqrtBps: 11_000, targetRaise: 10_000_000_000n, migrationFeePct: 50, permanentPct: 0, vestedPct: 90, vestingMonths: 12, poolFeeBps: 100 }, limits, supply, 6);
  if (!r.ok) throw new Error(`docs example no longer plans: ${r.error}`);
  const p = r.preview;
  // Rounded to the nearest, not cut off: 1.2099 reads 1.21 and 9,090.9 reads 9,091.
  const round = (atoms: bigint, frac: number) => {
    const step = 10n ** BigInt(6 - frac);
    return formatUnits(((atoms + step / 2n) / step) * step, 6, { maxFraction: frac, minFraction: frac });
  };
  const n = (atoms: bigint) => round(atoms, 0);
  const share = (atoms: bigint) => Number((atoms * 10_000n) / supply) / 10_000;
  return {
    supply: "1,000,000",
    open: "1.00",
    ceiling: "1.25×",
    rise: "1.21×",
    raise: "10,000",
    sold: n(p.plan.baseSold),
    close: round(p.endPrice, 2),
    average: round((10_000_000_000n * 1_000_000n) / p.plan.baseSold, 2),
    cash: n(p.cashToIssuer),
    poolQuote: n(p.poolQuote),
    poolBase: n(p.poolBase),
    unsold: n(p.unsold),
    shares: { sold: share(p.plan.baseSold), pool: share(p.poolBase), unsold: share(p.unsold) },
  };
})();
