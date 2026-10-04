import { useQuery } from "@tanstack/react-query";
import { fetchUsdPrices, isStable, type PricedToken } from "../chain/prices";
import { formatUsd, totalUsd, unpricedNote, type CurrencyAmount } from "../lib/usd";

/** Dollar prices for the given currencies, refreshed every few minutes. See chain/prices. */
export function useUsdPrices(tokens: PricedToken[]) {
  const unique = [...new Map(tokens.map((t) => [t.mint, t])).values()].sort((a, b) => a.mint.localeCompare(b.mint));
  return useQuery({
    queryKey: ["usdPrices", unique.map((t) => `${t.mint}:${t.symbol}`).join()],
    queryFn: () => fetchUsdPrices(unique),
    staleTime: 120_000,
    refetchInterval: 300_000,
  });
}

/**
 * One dollar figure for amounts in several currencies, with a note naming any it couldn't price.
 * `loading` while a non-stable currency still waits for its price; stablecoins need no wait.
 */
export function useUsdTotal(amounts: CurrencyAmount[] | null): { loading: true } | { loading: false; text: string; note: string | null } {
  const prices = useUsdPrices((amounts ?? []).map((a) => ({ mint: a.mint, symbol: a.symbol })));
  if (!amounts) return { loading: true };
  const needsMarket = amounts.some((a) => a.atoms > 0n && !isStable(a.symbol));
  if (needsMarket && prices.isLoading) return { loading: true };
  const known = prices.data ?? new Map(amounts.filter((a) => isStable(a.symbol)).map((a) => [a.mint, 1]));
  const { usd, unpriced } = totalUsd(amounts, known);
  return { loading: false, text: formatUsd(usd), note: unpricedNote(unpriced) };
}
