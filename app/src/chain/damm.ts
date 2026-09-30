/**
 * The permanent Meteora DAMM v2 pool a launch graduates into: found by its wrapper mint, read for
 * its live price. Layout from MeteoraAg/damm-v2 `state/pool.rs` (Pool, 1104 bytes; PoolFeesStruct
 * 160) and checked against a real migrated pool on a local node: token A is the wrapper, and the
 * price there equals the sale's final price.
 */
import { PublicKey, type Connection } from "@solana/web3.js";

export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

const POOL_SIZE = 8 + 1104;
const AT = { tokenA: 168, tokenB: 200, sqrtMin: 424, sqrtMax: 440, sqrtPrice: 456 } as const;

export type DammPool = { address: PublicKey; tokenB: PublicKey; sqrtPrice: bigint };

const u128 = (d: Uint8Array, at: number) => {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(at, true) | (v.getBigUint64(at + 8, true) << 64n);
};

/** The pool trading this wrapper against `quoteMint`, or null if it cannot be found or is malformed. */
export async function findDammPool(connection: Connection, wrapperMint: PublicKey, quoteMint: PublicKey): Promise<DammPool | null> {
  const found = await connection.getProgramAccounts(DAMM_V2_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ dataSize: POOL_SIZE }, { memcmp: { offset: AT.tokenA, bytes: wrapperMint.toBase58() } }, { memcmp: { offset: AT.tokenB, bytes: quoteMint.toBase58() } }],
  });
  for (const { pubkey, account } of found) {
    const d = account.data;
    const sqrtPrice = u128(d, AT.sqrtPrice);
    // A sane pool keeps its price between its own bounds; anything else is not trusted.
    if (u128(d, AT.sqrtMin) <= sqrtPrice && sqrtPrice <= u128(d, AT.sqrtMax) && sqrtPrice > 0n) {
      return { address: pubkey, tokenB: quoteMint, sqrtPrice };
    }
  }
  return null;
}
