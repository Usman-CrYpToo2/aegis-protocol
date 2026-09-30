/**
 * Minimal, read-only decoders for the two Meteora DBC accounts the registry needs.
 *
 * Offsets come from the pinned DBC source (f552f20), `state/virtual_pool.rs` and `state/config.rs`,
 * and are checked against Meteora's own `const_assert_eq!` sizes: PoolState is 416 bytes,
 * PoolConfig 1040. Every read first checks the owner, the discriminator and the length, so a
 * substituted or truncated account is rejected instead of being decoded into nonsense.
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { METEORA_DBC_PROGRAM_ID } from "./ids";

const DISC = {
  virtualPool: [213, 224, 5, 209, 98, 69, 119, 92],
  transferHookPool: [237, 219, 184, 23, 42, 189, 169, 35],
  poolConfig: [26, 108, 14, 123, 116, 230, 129, 43],
  // Transfer-hook launches (all Aegis launches) use this type. It starts with a full PoolConfig,
  // so the offsets below apply to both (DBC state/config.rs, ConfigWithTransferHook).
  configWithTransferHook: [40, 220, 194, 251, 41, 199, 123, 253],
} as const;

const POOL_LEN = 8 + 416;
const CONFIG_LEN = 8 + 1040;

const POOL = { config: 72, creator: 104, baseMint: 136, baseVault: 168, quoteVault: 200, baseReserve: 232, quoteReserve: 240, sqrtPrice: 280, isMigrated: 305, migrationFeeStatus: 311 } as const;
/** Bit in `migration_fee_withdraw_status` set once the creator has collected (virtual_pool.rs). */
export const CREATOR_MIGRATION_FEE_MASK = 0b010;
const CONFIG = {
  curveFeeNumerator: 104, // pool_fees.base_fee.cliff_fee_numerator (u64)
  partnerVesting: 184, // LiquidityVestingInfo, 16 bytes
  creatorVesting: 200,
  collectFeeMode: 232,
  partnerPermanentPct: 239,
  creatorPermanentPct: 241,
  creatorTradingFeePct: 245,
  migrationFeePct: 247,
  creatorMigrationFeePct: 248,
  migrationQuoteThreshold: 264,
  migrationSqrtPrice: 280,
  migratedPoolFeeBps: 362, // u16
  sqrtStartPrice: 392, // u128
  curve: 408, // 20 x { sqrt_price: u128, liquidity: u128 }
} as const;
const CURVE_POINTS = 20;

/** Meteora's fee denominator (constants.rs `FEE_DENOMINATOR`). */
export const FEE_DENOMINATOR = 1_000_000_000n;
/** Share of every trading fee Meteora keeps for itself (constants.rs `PROTOCOL_FEE_PERCENT`). */
export const METEORA_PROTOCOL_FEE_PCT = 20;

export type DbcPool = {
  config: PublicKey;
  /** The pool's creator: the issuer, who alone may collect the creator's share of the raise. */
  creator: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** Wrapper atoms still in the pool, unsold. */
  baseReserve: bigint;
  /** Quote tokens paid into the curve so far, fees excluded. */
  quoteReserve: bigint;
  /** Current price as Q64.64 square root, in atoms of quote per atom of base. */
  sqrtPrice: bigint;
  isMigrated: boolean;
  migrationFeeStatus: number;
};

export type LiquidityVesting = {
  percentage: number;
  periods: number;
  /** Seconds between unlocks. */
  frequency: number;
  cliffSeconds: number;
};

export type CurveSegment = { sqrtPrice: bigint; liquidity: bigint };

export type DbcConfig = {
  /** The raise target: the sale closes itself when `quoteReserve` reaches it. */
  migrationQuoteThreshold: bigint;
  /** Where the sale ends and the pool opens, as Q64.64 square root. */
  migrationSqrtPrice: bigint;
  sqrtStartPrice: bigint;
  /** Segments in order; each runs from the previous point's price to its own `sqrtPrice`. */
  curve: CurveSegment[];
  /** Share of the raise paid out at graduation instead of going into the pool. */
  migrationFeePct: number;
  /** Of that payout, the creator's (issuer's) share. */
  creatorMigrationFeePct: number;
  /** Trading fee on the curve, in basis points. */
  curveFeeBps: number;
  /** The same fee as Meteora stores it, over 1e9. Swap previews use this, not the rounded bps. */
  curveFeeNumerator: bigint;
  /** 0 = fees taken in the quote token (all Aegis launches), 1 = in the output token. */
  collectFeeMode: number;
  /** Of the non-Meteora part of that fee, the creator's (issuer's) share. */
  creatorTradingFeePct: number;
  /** Shares of the graduated pool's liquidity. */
  partnerPermanentPct: number;
  creatorPermanentPct: number;
  creatorVesting: LiquidityVesting | null;
  /** Swap fee of the permanent pool, in basis points. */
  migratedPoolFeeBps: number;
};

function hasPrefix(data: Uint8Array, prefix: readonly number[]) {
  return prefix.every((b, i) => data[i] === b);
}

function checkOwner(info: AccountInfo<Uint8Array>, what: string) {
  if (!info.owner.equals(METEORA_DBC_PROGRAM_ID)) throw new Error(`${what} is not owned by Meteora DBC`);
}

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const u64 = (data: Uint8Array, at: number) => view(data).getBigUint64(at, true);
const u128 = (data: Uint8Array, at: number) => u64(data, at) | (u64(data, at + 8) << 64n);

export function decodeDbcPool(info: AccountInfo<Uint8Array>): DbcPool {
  checkOwner(info, "pool");
  const d = info.data;
  if (d.length < POOL_LEN) throw new Error("pool account too short");
  if (!hasPrefix(d, DISC.virtualPool) && !hasPrefix(d, DISC.transferHookPool)) {
    throw new Error("not a Meteora DBC pool");
  }
  return {
    config: new PublicKey(d.subarray(POOL.config, POOL.config + 32)),
    creator: new PublicKey(d.subarray(POOL.creator, POOL.creator + 32)),
    baseMint: new PublicKey(d.subarray(POOL.baseMint, POOL.baseMint + 32)),
    baseVault: new PublicKey(d.subarray(POOL.baseVault, POOL.baseVault + 32)),
    quoteVault: new PublicKey(d.subarray(POOL.quoteVault, POOL.quoteVault + 32)),
    baseReserve: u64(d, POOL.baseReserve),
    quoteReserve: u64(d, POOL.quoteReserve),
    sqrtPrice: u128(d, POOL.sqrtPrice),
    isMigrated: d[POOL.isMigrated] === 1,
    migrationFeeStatus: d[POOL.migrationFeeStatus] ?? 0,
  };
}

export function decodeDbcConfig(info: AccountInfo<Uint8Array>): DbcConfig {
  checkOwner(info, "config");
  const d = info.data;
  if (d.length < CONFIG_LEN) throw new Error("config account too short");
  if (!hasPrefix(d, DISC.poolConfig) && !hasPrefix(d, DISC.configWithTransferHook)) {
    throw new Error("not a Meteora DBC config");
  }
  const v = view(d);
  const vesting = (at: number): LiquidityVesting | null =>
    d[at] === 1
      ? {
          percentage: d[at + 1]!,
          periods: v.getUint16(at + 6, true),
          frequency: v.getUint32(at + 8, true),
          cliffSeconds: v.getUint32(at + 12, true),
        }
      : null;

  const curve: CurveSegment[] = [];
  for (let i = 0; i < CURVE_POINTS; i++) {
    const at = CONFIG.curve + i * 32;
    const sqrtPrice = u128(d, at);
    if (sqrtPrice === 0n) break; // unused slots are zeroed
    curve.push({ sqrtPrice, liquidity: u128(d, at + 16) });
  }

  return {
    migrationQuoteThreshold: u64(d, CONFIG.migrationQuoteThreshold),
    migrationSqrtPrice: u128(d, CONFIG.migrationSqrtPrice),
    sqrtStartPrice: u128(d, CONFIG.sqrtStartPrice),
    curve,
    migrationFeePct: d[CONFIG.migrationFeePct]!,
    creatorMigrationFeePct: d[CONFIG.creatorMigrationFeePct]!,
    curveFeeBps: Number((u64(d, CONFIG.curveFeeNumerator) * 10_000n) / FEE_DENOMINATOR),
    curveFeeNumerator: u64(d, CONFIG.curveFeeNumerator),
    collectFeeMode: d[CONFIG.collectFeeMode]!,
    creatorTradingFeePct: d[CONFIG.creatorTradingFeePct]!,
    partnerPermanentPct: d[CONFIG.partnerPermanentPct]!,
    creatorPermanentPct: d[CONFIG.creatorPermanentPct]!,
    creatorVesting: vesting(CONFIG.creatorVesting),
    migratedPoolFeeBps: v.getUint16(CONFIG.migratedPoolFeeBps, true),
  };
}
