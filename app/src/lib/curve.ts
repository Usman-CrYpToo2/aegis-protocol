/**
 * The bonding curve, computed exactly as Meteora DBC does (curve.rs), in bigint.
 *
 * A curve is a list of segments. Each segment holds constant liquidity L between two square-root
 * prices (Q64.64). Between prices a < b:
 *   base  = L * (b - a) / (a * b)          wrapper atoms sold
 *   quote = L * (b - a) >> 128             quote atoms paid
 */
import type { CurveSegment } from "../chain/meteora";
import { sqrtPriceToQuoteAtoms } from "./amount";

export const baseBetween = (a: bigint, b: bigint, liquidity: bigint) =>
  b <= a ? 0n : (liquidity * (b - a)) / (a * b);

export const quoteBetween = (a: bigint, b: bigint, liquidity: bigint) =>
  b <= a ? 0n : (liquidity * (b - a)) >> 128n;

type Walk = { base: bigint; quote: bigint };

/**
 * Totals from the start price up to `target` (clamped to the curve), summed over every segment the
 * range crosses.
 */
export function walkCurve(start: bigint, curve: CurveSegment[], target: bigint): Walk {
  let lower = start;
  let base = 0n;
  let quote = 0n;
  for (const seg of curve) {
    if (target <= lower) break;
    const upper = target < seg.sqrtPrice ? target : seg.sqrtPrice;
    base += baseBetween(lower, upper, seg.liquidity);
    quote += quoteBetween(lower, upper, seg.liquidity);
    lower = seg.sqrtPrice;
  }
  return { base, quote };
}

export type CurvePoint = {
  /** Wrapper atoms sold to reach this price. */
  sold: bigint;
  /** Price of one whole wrapper, in quote atoms. */
  price: bigint;
};

/** `count` evenly spaced (in sqrt price) points from the start to `end`, for drawing. */
export function sampleCurve(start: bigint, curve: CurveSegment[], end: bigint, baseDecimals: number, count = 48): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (let i = 0; i <= count; i++) {
    const sqrt = start + ((end - start) * BigInt(i)) / BigInt(count);
    points.push({ sold: walkCurve(start, curve, sqrt).base, price: sqrtPriceToQuoteAtoms(sqrt, baseDecimals) });
  }
  return points;
}

/** Price multiple of the archetype ceiling, from the program's sqrt caps (curve.rs). */
export const ARCHETYPE_CEILING = {
  FixedPar: { sqrtBps: 10_099n, label: "Fixed par", multiple: "1.02×" },
  BookBuilding: { sqrtBps: 11_180n, label: "Book building", multiple: "1.25×" },
  GrowthCapital: { sqrtBps: 12_247n, label: "Growth capital", multiple: "1.50×" },
} as const;

/** The ceiling price, in quote atoms per whole wrapper, for a curve that opens at `startSqrt`. */
export function ceilingPrice(startSqrt: bigint, sqrtBps: bigint, baseDecimals: number): bigint {
  return sqrtPriceToQuoteAtoms((startSqrt * sqrtBps) / 10_000n, baseDecimals);
}
