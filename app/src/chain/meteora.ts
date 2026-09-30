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

const POOL = { config: 72, baseMint: 136, quoteReserve: 240, sqrtPrice: 280, isMigrated: 305 } as const;
const CONFIG = {
  migrationFeePct: 247,
  swapBaseAmount: 256,
  migrationQuoteThreshold: 264,
  migrationSqrtPrice: 280,
} as const;

export type DbcPool = {
  config: PublicKey;
  baseMint: PublicKey;
  /** Quote tokens paid into the curve so far, fees excluded. */
  quoteReserve: bigint;
  /** Current price as Q64.64 square root, in atoms of quote per atom of base. */
  sqrtPrice: bigint;
  isMigrated: boolean;
};

export type DbcConfig = {
  /** The raise target: the sale closes itself when `quoteReserve` reaches it. */
  migrationQuoteThreshold: bigint;
  migrationSqrtPrice: bigint;
  migrationFeePct: number;
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
    baseMint: new PublicKey(d.subarray(POOL.baseMint, POOL.baseMint + 32)),
    quoteReserve: u64(d, POOL.quoteReserve),
    sqrtPrice: u128(d, POOL.sqrtPrice),
    isMigrated: d[POOL.isMigrated] === 1,
  };
}

export function decodeDbcConfig(info: AccountInfo<Uint8Array>): DbcConfig {
  checkOwner(info, "config");
  const d = info.data;
  if (d.length < CONFIG_LEN) throw new Error("config account too short");
  if (!hasPrefix(d, DISC.poolConfig) && !hasPrefix(d, DISC.configWithTransferHook)) {
    throw new Error("not a Meteora DBC config");
  }
  return {
    migrationQuoteThreshold: u64(d, CONFIG.migrationQuoteThreshold),
    migrationSqrtPrice: u128(d, CONFIG.migrationSqrtPrice),
    migrationFeePct: d[CONFIG.migrationFeePct] ?? 0,
  };
}
