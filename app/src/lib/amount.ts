/**
 * Token amounts are integers of "atoms" (a USDC atom is 0.000001 USDC). They are kept as bigint
 * end to end and only turned into text here, so a balance is never rounded by floating point.
 */

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * `1234567n, 6 -> "1.234567"`. Extra fraction digits are cut, never rounded up, so a displayed
 * amount is never more than what is really there.
 */
export function formatUnits(
  atoms: bigint,
  decimals: number,
  { maxFraction = decimals, minFraction = 0 }: { maxFraction?: number; minFraction?: number } = {}
): string {
  const negative = atoms < 0n;
  const abs = negative ? -atoms : atoms;
  const base = 10n ** BigInt(decimals);
  const whole = group((abs / base).toString());
  let fraction = (abs % base).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFraction));
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Meteora stores price as a Q64.64 square root in atoms of quote per atom of base. Returns the
 * price of one whole base token in quote atoms, so it can be formatted with the quote's decimals.
 */
export function sqrtPriceToQuoteAtoms(sqrtPriceX64: bigint, baseDecimals: number): bigint {
  return (sqrtPriceX64 * sqrtPriceX64 * 10n ** BigInt(baseDecimals)) >> 128n;
}

/** Whole percent, floored and clamped to 0..100. Target 0 counts as nothing raised. */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const pct = (part * 100n) / whole;
  return Number(pct > 100n ? 100n : pct);
}

export const shortAddress = (address: string, keep = 4) =>
  address.length <= keep * 2 + 1 ? address : `${address.slice(0, keep)}…${address.slice(-keep)}`;
