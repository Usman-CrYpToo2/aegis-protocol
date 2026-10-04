/** Adding up amounts held in different currencies, in US dollars. See chain/prices. */

export type CurrencyAmount = { mint: string; symbol: string; decimals: number; atoms: bigint };

/**
 * The dollar value of amounts in several currencies. `unpriced` names the currencies with a
 * non-zero amount but no price, so a page can say what the total leaves out.
 */
export function totalUsd(amounts: CurrencyAmount[], prices: Map<string, number>): { usd: number; unpriced: string[] } {
  let usd = 0;
  const unpriced: string[] = [];
  for (const a of amounts) {
    if (a.atoms === 0n) continue;
    const price = prices.get(a.mint);
    if (price === undefined) {
      if (!unpriced.includes(a.symbol)) unpriced.push(a.symbol);
      continue;
    }
    usd += (Number(a.atoms) / 10 ** a.decimals) * price;
  }
  return { usd, unpriced };
}

/** "$12,345" from a thousand up, "$123.45" below, "$0.0123" under a dollar. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  const digits = usd >= 1_000 ? 0 : usd >= 1 ? 2 : 4;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: digits === 4 ? 2 : digits, maximumFractionDigits: digits })}`;
}

/** The line under a dollar total that names anything it couldn't price. */
export const unpricedNote = (unpriced: string[]) => (unpriced.length ? `Not counted: ${unpriced.join(", ")} (no price right now)` : null);
