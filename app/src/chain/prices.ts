/**
 * US dollar prices for the currencies sales are priced in, used only where amounts in different
 * currencies are added together (totals across sales). A single sale is always shown in its own
 * currency.
 *
 * Stablecoins count at one dollar. Everything else is priced by Jupiter's public price API, by mint,
 * with Coinbase's public spot price by symbol as a fallback; both are free, need no key and allow
 * browser requests, so no server is involved. A devnet token that neither knows stays unpriced, and
 * the page says so rather than counting it as zero.
 */
import type { PublicKey } from "@solana/web3.js";

/** Dollar stablecoins: counted at $1 without asking anyone. */
export const STABLE_SYMBOLS = new Set(["USDC", "USDT", "PYUSD", "USDG", "USDS", "FDUSD", "DAI"]);

export type PricedToken = { mint: string; symbol: string };

export const isStable = (symbol: string) => STABLE_SYMBOLS.has(symbol.toUpperCase());

const JUPITER = "https://lite-api.jup.ag/price/v3";
const COINBASE = (symbol: string) => `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`;

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
};

/** Dollar price per whole token, by mint. A token missing from the result couldn't be priced. */
export async function fetchUsdPrices(tokens: PricedToken[], get: (url: string) => Promise<unknown> = getJson): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const market = tokens.filter((t) => !isStable(t.symbol));
  for (const t of tokens) if (isStable(t.symbol)) prices.set(t.mint, 1);
  if (market.length) {
    try {
      const body = (await get(`${JUPITER}?ids=${market.map((t) => t.mint).join(",")}`)) as Record<string, { usdPrice?: number } | null>;
      for (const t of market) {
        const p = body?.[t.mint]?.usdPrice;
        if (typeof p === "number" && p > 0) prices.set(t.mint, p);
      }
    } catch {
      // Fall through to the next source.
    }
    await Promise.all(
      market
        .filter((t) => !prices.has(t.mint))
        .map(async (t) => {
          try {
            const p = Number(((await get(COINBASE(t.symbol))) as { data?: { amount?: string } })?.data?.amount);
            if (p > 0) prices.set(t.mint, p);
          } catch {
            // Unpriced: the page says so.
          }
        })
    );
  }
  return prices;
}

export const tokenOf = (mint: PublicKey, symbol: string): PricedToken => ({ mint: mint.toBase58(), symbol });
