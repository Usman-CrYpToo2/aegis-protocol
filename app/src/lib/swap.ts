/**
 * Swap previews that reproduce Meteora DBC's own maths (pinned f552f20), step for step and with
 * the same rounding, so what the page promises is what the program will do.
 *
 *   buy  = quote in, base out  (QuoteToBase). Fee taken from the quote paid in.
 *   sell = base in, quote out  (BaseToQuote). Fee taken from the quote paid out.
 *
 * Sources: state/virtual_pool.rs (get_swap_result_from_exact_input, _partial_input,
 * calculate_quote_to_base_from_amount_in, calculate_base_to_quote_from_amount_in),
 * state/config.rs (get_excluded_fee_amount, get_included_fee_amount) and curve.rs.
 *
 * Only valid for Aegis launches: flat base fee, no dynamic fee, fees collected in quote. The
 * caller checks `collectFeeMode` before using it.
 */
import type { CurveSegment } from "../chain/meteora";

const FEE_DENOMINATOR = 1_000_000_000n;
const Q128 = 1n << 128n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// curve.rs -------------------------------------------------------------------------------------

function deltaBase(lower: bigint, upper: bigint, liquidity: bigint, roundUp: boolean) {
  const num = liquidity * (upper - lower);
  const den = lower * upper;
  return roundUp ? ceilDiv(num, den) : num / den;
}

function deltaQuote(lower: bigint, upper: bigint, liquidity: bigint, roundUp: boolean) {
  const prod = liquidity * (upper - lower);
  return roundUp ? ceilDiv(prod, Q128) : prod >> 128n;
}

/** √P' = √P + Δy / L, rounded down. */
const nextSqrtFromQuoteIn = (sqrt: bigint, liquidity: bigint, amount: bigint) => sqrt + (amount << 128n) / liquidity;

/** √P' = L √P / (L + Δx √P), rounded up. */
function nextSqrtFromBaseIn(sqrt: bigint, liquidity: bigint, amount: bigint) {
  if (amount === 0n) return sqrt;
  return ceilDiv(liquidity * sqrt, liquidity + amount * sqrt);
}

// config.rs ------------------------------------------------------------------------------------

/** Fee on an amount that includes it: rounded up, so the fee is never under-charged. */
function excludeFee(numerator: bigint, included: bigint) {
  const fee = ceilDiv(included * numerator, FEE_DENOMINATOR);
  return { amount: included - fee, fee };
}

/** The amount that, after its fee, leaves `excluded`. Rounded up. */
function includeFee(numerator: bigint, excluded: bigint) {
  const included = ceilDiv(excluded * FEE_DENOMINATOR, FEE_DENOMINATOR - numerator);
  return { amount: included, fee: included - excluded };
}

// virtual_pool.rs ------------------------------------------------------------------------------

type Walk = { out: bigint; left: bigint; nextSqrt: bigint };

function quoteToBase(current: bigint, curve: CurveSegment[], amountIn: bigint, stop: bigint): Walk {
  let sqrt = current;
  let left = amountIn;
  let out = 0n;
  for (const seg of curve) {
    if (seg.sqrtPrice === 0n || seg.liquidity === 0n) break;
    const reference = stop < seg.sqrtPrice ? stop : seg.sqrtPrice;
    if (reference <= sqrt) continue;
    const maxIn = deltaQuote(sqrt, reference, seg.liquidity, true);
    if (left < maxIn) {
      const next = nextSqrtFromQuoteIn(sqrt, seg.liquidity, left);
      out += deltaBase(sqrt, next, seg.liquidity, false);
      return { out, left: 0n, nextSqrt: next };
    }
    out += deltaBase(sqrt, reference, seg.liquidity, false);
    sqrt = reference;
    left -= maxIn;
    if (reference === stop) break;
  }
  return { out, left, nextSqrt: sqrt };
}

function baseToQuote(current: bigint, curve: CurveSegment[], sqrtStart: bigint, amountIn: bigint): Walk {
  let sqrt = current;
  let left = amountIn;
  let out = 0n;
  for (let i = curve.length - 2; i >= 0; i--) {
    const lower = curve[i]!;
    const liquidity = curve[i + 1]!.liquidity;
    if (lower.sqrtPrice === 0n || lower.liquidity === 0n) continue;
    if (lower.sqrtPrice >= sqrt) continue;
    const maxIn = deltaBase(lower.sqrtPrice, sqrt, liquidity, true);
    if (left < maxIn) {
      const next = nextSqrtFromBaseIn(sqrt, liquidity, left);
      out += deltaQuote(next, sqrt, liquidity, false);
      return { out, left: 0n, nextSqrt: next };
    }
    out += deltaQuote(lower.sqrtPrice, sqrt, liquidity, false);
    sqrt = lower.sqrtPrice;
    left -= maxIn;
  }
  if (left !== 0n) {
    const liquidity = curve[0]!.liquidity;
    let next = nextSqrtFromBaseIn(sqrt, liquidity, left);
    if (next < sqrtStart) {
      next = sqrtStart;
      left -= deltaBase(next, sqrt, liquidity, true);
    } else {
      left = 0n;
    }
    out += deltaQuote(next, sqrt, liquidity, false);
    sqrt = next;
  }
  return { out, left, nextSqrt: sqrt };
}

// Public API -----------------------------------------------------------------------------------

export type CurveState = {
  sqrtPrice: bigint;
  sqrtStartPrice: bigint;
  migrationSqrtPrice: bigint;
  curve: CurveSegment[];
  feeNumerator: bigint;
};

export type BuyQuote = {
  /** Quote atoms that will actually leave the wallet (less than asked if the sale fills up). */
  spend: bigint;
  /** Wrapper atoms received. */
  out: bigint;
  fee: bigint;
  nextSqrt: bigint;
  /** This purchase fills the sale; only `spend` is used and the rest stays in the wallet. */
  fillsSale: boolean;
};

export function quoteBuy(state: CurveState, amountIn: bigint): BuyQuote | null {
  if (amountIn <= 0n) return null;
  const { amount: net, fee } = excludeFee(state.feeNumerator, amountIn);
  const walk = quoteToBase(state.sqrtPrice, state.curve, net, state.migrationSqrtPrice);
  if (walk.left === 0n) return { spend: amountIn, out: walk.out, fee, nextSqrt: walk.nextSqrt, fillsSale: false };
  // Partial fill: the curve stops at the graduation price; the fee is recomputed on what was used.
  const used = includeFee(state.feeNumerator, net - walk.left);
  return { spend: used.amount, out: walk.out, fee: used.fee, nextSqrt: walk.nextSqrt, fillsSale: true };
}

export type SellQuote = { out: bigint; gross: bigint; fee: bigint; nextSqrt: bigint };

/** Null when the curve can't absorb it: nobody can sell below the opening price. */
export function quoteSell(state: CurveState, amountIn: bigint): SellQuote | null {
  if (amountIn <= 0n) return null;
  const walk = baseToQuote(state.sqrtPrice, state.curve, state.sqrtStartPrice, amountIn);
  if (walk.left !== 0n) return null;
  const { amount, fee } = excludeFee(state.feeNumerator, walk.out);
  return { out: amount, gross: walk.out, fee, nextSqrt: walk.nextSqrt };
}

/** Quote atoms left before the sale fills, fee included: the most a single buy can use. */
export function remainingToFill(state: CurveState): bigint {
  const walk = quoteToBase(state.sqrtPrice, state.curve, 1n << 62n, state.migrationSqrtPrice);
  const net = (1n << 62n) - walk.left;
  return includeFee(state.feeNumerator, net).amount;
}

/** `amount` less `bps` basis points, rounded down: the least the user accepts to receive. */
export const withSlippage = (amount: bigint, bps: number) => (amount * BigInt(10_000 - bps)) / 10_000n;
