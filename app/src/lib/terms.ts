/**
 * Sale terms: from an issuer's plain answers to the arguments `create_rwa_config` takes, and what
 * those terms will do. `planCurve` is programs/aegis/src/curve.rs `plan_curve`, line for line, with
 * the two Meteora helpers it calls; terms.test.ts reproduces the program's own unit tests.
 * The final word is always the program: the app simulates create_rwa_config before anyone signs.
 */
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673521066979257578248091n;
const BPS = 10_000n;
const SWAP_BUFFER_PERCENTAGE = 25n;

export type Archetype = "FixedPar" | "BookBuilding" | "GrowthCapital";
export const ARCHETYPES: Archetype[] = ["FixedPar", "BookBuilding", "GrowthCapital"];
/** curve.rs `max_sqrt_expansion_bps`. */
export const MAX_SQRT_BPS: Record<Archetype, number> = { FixedPar: 10_099, BookBuilding: 11_180, GrowthCapital: 12_247 };
export const ARCHETYPE_INDEX: Record<Archetype, number> = { FixedPar: 0, BookBuilding: 1, GrowthCapital: 2 };

/** Floor square root. Newton's method from above, which only ever decreases, so it always ends. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("negative");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Q64.64 sqrt price for `quoteAtomsPerToken` quote atoms per whole token. */
export function priceToSqrt(quoteAtomsPerToken: bigint, baseDecimals: number): bigint {
  return isqrt((quoteAtomsPerToken << 128n) / 10n ** BigInt(baseDecimals));
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const quoteUp = (a: bigint, b: bigint, l: bigint) => (b <= a ? 0n : ceilDiv(l * (b - a), 1n << 128n));
/** get_base_token_for_swap rounds up. */
const baseUp = (a: bigint, b: bigint, l: bigint) => (b <= a ? 0n : ceilDiv(l * (b - a), a * b));

export type CurvePlan = {
  sqrtStart: bigint;
  sqrtEnd: bigint;
  liquidity: bigint;
  migrationSqrt: bigint;
  baseSold: bigint;
  baseWithBuffer: bigint;
};

export type PlanError =
  | "InvalidStartPrice" | "InvalidQuoteThreshold" | "PriceExpansionTooSmall" | "PriceExpansionExceedsRwaLimit"
  | "PriceExceedsMaxSqrtPrice" | "ZeroLiquiditySegment" | "MigrationPriceAboveCurve" | "CurveSellsNothing" | "SupplyTooSmallForCurve";

export function planCurve(sqrtStart: bigint, sqrtBps: number, targetRaise: bigint, archetype: Archetype, totalSupply: bigint): { ok: true; plan: CurvePlan } | { ok: false; error: PlanError } {
  const fail = (error: PlanError) => ({ ok: false as const, error });
  if (!(sqrtStart >= MIN_SQRT_PRICE && sqrtStart < MAX_SQRT_PRICE)) return fail("InvalidStartPrice");
  if (targetRaise <= 0n) return fail("InvalidQuoteThreshold");
  if (sqrtBps <= 10_000) return fail("PriceExpansionTooSmall");
  if (sqrtBps > MAX_SQRT_BPS[archetype]) return fail("PriceExpansionExceedsRwaLimit");
  const sqrtEnd = (sqrtStart * BigInt(sqrtBps)) / BPS;
  if (sqrtEnd > MAX_SQRT_PRICE) return fail("PriceExceedsMaxSqrtPrice");
  if (sqrtEnd <= sqrtStart) return fail("PriceExpansionTooSmall");
  const liquidity = ceilDiv(targetRaise << 128n, sqrtEnd - sqrtStart);
  if (liquidity >= 1n << 128n) return fail("PriceExceedsMaxSqrtPrice");
  if (liquidity === 0n) return fail("ZeroLiquiditySegment");
  // Meteora get_migration_threshold_price, one segment.
  const migrationSqrt = quoteUp(sqrtStart, sqrtEnd, liquidity) > targetRaise ? sqrtStart + (targetRaise << 128n) / liquidity : sqrtEnd;
  if (migrationSqrt >= MAX_SQRT_PRICE) return fail("PriceExceedsMaxSqrtPrice");
  if (migrationSqrt > sqrtEnd) return fail("MigrationPriceAboveCurve");
  if (migrationSqrt <= sqrtStart) return fail("InvalidStartPrice");
  const baseSold = baseUp(sqrtStart, migrationSqrt, liquidity);
  if (baseSold === 0n) return fail("CurveSellsNothing");
  // PoolConfig::get_swap_amount_with_buffer: +25%, capped at everything the curve can sell.
  const buffered = (baseSold * SWAP_BUFFER_PERCENTAGE) / 100n + baseSold;
  const maxOnCurve = baseUp(sqrtStart, sqrtEnd, liquidity);
  const baseWithBuffer = buffered < maxOnCurve ? buffered : maxOnCurve;
  if (baseWithBuffer >= totalSupply) return fail("SupplyTooSmallForCurve");
  return { ok: true, plan: { sqrtStart, sqrtEnd, liquidity, migrationSqrt, baseSold, baseWithBuffer } };
}

/** Meteora get_migration_quote_amount: what goes to the pool, and the fee taken out of the raise. */
export function migrationSplit(targetRaise: bigint, feePct: number) {
  const toPool = ceilDiv(targetRaise * BigInt(100 - feePct), 100n);
  return { toPool, fee: targetRaise - toPool };
}

export type Terms = {
  quoteAtomsPerToken: bigint;
  archetype: Archetype;
  sqrtBps: number;
  targetRaise: bigint;
  migrationFeePct: number;
  permanentPct: number;
  vestedPct: number;
  vestingMonths: number;
  poolFeeBps: number;
};

/** Borsh body of CreateRwaConfigArgs, in the IDL's field order. */
export function termsArgs(t: Terms, baseDecimals: number) {
  return {
    sqrtStartPrice: priceToSqrt(t.quoteAtomsPerToken, baseDecimals),
    sqrtExpansionBps: t.sqrtBps,
    targetRaise: t.targetRaise,
    archetype: ARCHETYPE_INDEX[t.archetype],
    migrationFeePct: t.migrationFeePct,
    issuerPermanentLockPct: t.permanentPct,
    issuerVestedPct: t.vestedPct,
    vestingMonths: t.vestedPct > 0 ? t.vestingMonths : 0,
    poolFeeBps: t.poolFeeBps,
  };
}

/** Price multiple at the end of the curve, for a sqrt multiple in bps: (bps/10000)². */
export const priceMultiple = (sqrtBps: number) => (sqrtBps / 10_000) ** 2;
/** The sqrt bps for a desired price multiple, floored so it never exceeds the archetype. */
export const sqrtBpsFor = (multiple: number) => Math.floor(Math.sqrt(multiple) * 10_000);

export type PlatformLimits = {
  aegisMigrationFeeSharePct: number;
  aegisLpSharePct: number;
  minMigrationFeePct: number;
  maxMigrationFeePct: number;
  minIssuerPermanentPct: number;
  minVestingMonths: number;
  maxVestingMonths: number;
  minPoolFeeBps: number;
  maxPoolFeeBps: number;
};

/** Meteora's own bounds on the graduated pool fee, which apply on top of the platform's. */
const METEORA_POOL_FEE_BPS = { min: 10, max: 1_000 };

export function poolFeeRange(p: PlatformLimits) {
  return { min: Math.max(p.minPoolFeeBps, METEORA_POOL_FEE_BPS.min), max: Math.min(p.maxPoolFeeBps, METEORA_POOL_FEE_BPS.max) };
}

/** Everything the platform checks on the answers, before the curve maths (create_rwa_config.rs). */
export function limitProblems(t: Terms, p: PlatformLimits, minRaise: bigint): string[] {
  const out: string[] = [];
  const share = 100 - p.aegisLpSharePct;
  if (t.targetRaise < minRaise) out.push("The raise is below this currency’s minimum.");
  if (t.migrationFeePct < p.minMigrationFeePct || t.migrationFeePct > p.maxMigrationFeePct) out.push(`Your cash share must be between ${p.minMigrationFeePct}% and ${p.maxMigrationFeePct}%.`);
  if (t.permanentPct + t.vestedPct !== share) out.push(`Locked forever and unlocking must add up to your ${share}% of the pool.`);
  if (t.permanentPct < p.minIssuerPermanentPct) out.push(`At least ${p.minIssuerPermanentPct}% must be locked forever.`);
  if (t.vestedPct > 0 && (t.vestingMonths < p.minVestingMonths || t.vestingMonths > p.maxVestingMonths)) out.push(`The unlock period must be ${p.minVestingMonths} to ${p.maxVestingMonths} months.`);
  const fee = poolFeeRange(p);
  if (t.poolFeeBps < fee.min || t.poolFeeBps > fee.max) out.push(`The pool fee must be between ${fee.min / 100}% and ${fee.max / 100}%.`);
  return out;
}

export type Preview = {
  plan: CurvePlan;
  /** Quote atoms per whole token at the close of the sale. */
  endPrice: bigint;
  cashToIssuer: bigint;
  poolQuote: bigint;
  /** Tokens paired with the quote in the pool, at the closing price. An estimate: Meteora sizes it. */
  poolBase: bigint;
  /** Tokens not sold and not in the pool. An estimate, for the same reason. */
  unsold: bigint;
};

export function previewTerms(t: Terms, p: PlatformLimits, totalSupply: bigint, baseDecimals: number): { ok: true; preview: Preview } | { ok: false; error: PlanError } {
  const planned = planCurve(priceToSqrt(t.quoteAtomsPerToken, baseDecimals), t.sqrtBps, t.targetRaise, t.archetype, totalSupply);
  if (!planned.ok) return planned;
  const plan = planned.plan;
  const { toPool, fee } = migrationSplit(t.targetRaise, t.migrationFeePct);
  const issuerPct = t.migrationFeePct === 0 ? 0 : 100 - p.aegisMigrationFeeSharePct;
  // Pool tokens at the closing price: quote / price, where price = s² / 2^128 in atoms.
  const poolBase = (toPool << 128n) / (plan.migrationSqrt * plan.migrationSqrt);
  const used = plan.baseSold + poolBase;
  return {
    ok: true,
    preview: {
      plan,
      endPrice: (plan.migrationSqrt * plan.migrationSqrt * 10n ** BigInt(baseDecimals)) >> 128n,
      cashToIssuer: (fee * BigInt(issuerPct)) / 100n,
      poolQuote: toPool,
      poolBase,
      unsold: used < totalSupply ? totalSupply - used : 0n,
    },
  };
}
