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
 * Decimal places worth showing for an amount of money: none once it reaches the thousands, two for
 * everyday sums, four below one unit. So a raise of 10,000 USDC and one of 0.85 SOL both read right.
 */
export function moneyFraction(atoms: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const abs = atoms < 0n ? -atoms : atoms;
  if (abs >= 1_000n * base) return 0;
  if (abs >= base) return Math.min(2, decimals);
  return Math.min(4, decimals);
}

/** An amount of a sale's currency, with as many decimals as its size calls for. */
export const formatMoney = (atoms: bigint, decimals: number) => formatUnits(atoms, decimals, { maxFraction: moneyFraction(atoms, decimals) });

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

export type Parsed = { ok: true; atoms: bigint } | { ok: false; reason: string };

/**
 * What someone typed, as atoms. Strict on purpose: plain digits with at most one "." and no more
 * fraction digits than the token has. Commas are accepted as thousands separators ("1,000"), never
 * as a decimal point, so "1,5" is rejected rather than silently read as 15.
 */
export function parseUnits(text: string, decimals: number): Parsed {
  const s = text.trim().replace(/,(?=\d{3}(\D|$))/g, "");
  if (s === "") return { ok: false, reason: "Enter an amount" };
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return { ok: false, reason: "Use digits only, like 250 or 12.5" };
  const [whole = "", fraction = ""] = s.split(".");
  if (fraction.length > decimals) return { ok: false, reason: `At most ${decimals} digits after the point` };
  const atoms = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((fraction || "").padEnd(decimals, "0") || "0");
  if (atoms === 0n) return { ok: false, reason: "Enter more than zero" };
  if (atoms > 18_446_744_073_709_551_615n) return { ok: false, reason: "That amount is too large" };
  return { ok: true, atoms };
}

/** Atoms back to the plain text an input field shows (no grouping), for "Max" buttons. */
export function toInputText(atoms: bigint, decimals: number): string {
  return formatUnits(atoms, decimals).replace(/,/g, "");
}
