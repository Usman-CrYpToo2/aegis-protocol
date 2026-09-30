import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { sqrtPriceToQuoteAtoms } from "../lib/amount";
import { isSet } from "./aegis";
import { findDammPool } from "./damm";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";
import type { Registry, RegistryEntry } from "./registry";

export type Holding = {
  entry: RegistryEntry;
  /** Security (Real RWA) in the wallet. */
  security: bigint;
  /** Wrapper (cRWA) in the wallet. */
  wrapper: bigint;
  /** On the issuer's register in the investor group: may hold the security and use the bridge. */
  approved: boolean;
  /** Price of one whole token in quote atoms: the curve while the sale is open, the pool after. */
  price: bigint | null;
  priceSource: "curve" | "pool" | null;
  /** The Meteora pool after graduation, for linking. */
  pool: PublicKey | null;
  /** (security + wrapper) × price, in quote atoms. */
  value: bigint | null;
  /** The connected wallet issued this asset. */
  isIssuer: boolean;
};

const SAA_DISCRIMINATOR = [68, 169, 137, 56, 226, 21, 69, 124];

function tokenAmount(info: AccountInfo<Uint8Array> | null | undefined): bigint {
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID) || info.data.length < 72) return 0n;
  return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(64, true);
}

function approvedGroup(info: AccountInfo<Uint8Array> | null | undefined): bigint | null {
  if (!info || !info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) || info.data.length < 16) return null;
  if (!SAA_DISCRIMINATOR.every((b, i) => info.data[i] === b)) return null;
  return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(8, true);
}

export const saaAddress = (tokenAccount: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode("saa"), tokenAccount.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID)[0];

export function holderAccounts(entry: RegistryEntry, owner: PublicKey) {
  const l = entry.launch;
  const security = getAssociatedTokenAddressSync(l.realRwaMint, owner, false, TOKEN_2022_PROGRAM_ID);
  const wrapper = isSet(l.crwaMint) ? getAssociatedTokenAddressSync(l.crwaMint, owner, false, TOKEN_2022_PROGRAM_ID) : null;
  return { security, wrapper, saa: saaAddress(security) };
}

/**
 * What `owner` holds across every registered asset. Addresses are derived, so there is no scan of
 * the wallet: one batched read for all balances and approvals, then one pool lookup per graduated
 * asset actually held.
 */
export async function loadHoldings(connection: Connection, registry: Registry, owner: PublicKey): Promise<Holding[]> {
  const candidates = registry.entries.filter((e) => e.launch.stage !== "Aborted" && e.launch.stage !== "TokenCreated");
  const keys = candidates.flatMap((e) => {
    const a = holderAccounts(e, owner);
    return [a.security, a.wrapper ?? a.security, a.saa];
  });
  const infos: (AccountInfo<Uint8Array> | null)[] = [];
  for (let i = 0; i < keys.length; i += 99) {
    infos.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 99), "confirmed")));
  }

  const held: Holding[] = [];
  candidates.forEach((entry, i) => {
    const security = tokenAmount(infos[i * 3]);
    const wrapper = holderAccounts(entry, owner).wrapper ? tokenAmount(infos[i * 3 + 1]) : 0n;
    if (security === 0n && wrapper === 0n) return;
    held.push({
      entry,
      security,
      wrapper,
      approved: approvedGroup(infos[i * 3 + 2]) === entry.launch.investorGroup,
      price: null,
      priceSource: null,
      pool: null,
      value: null,
      isIssuer: entry.launch.issuer.equals(owner),
    });
  });

  await Promise.all(
    held.map(async (h) => {
      const { launch } = h.entry;
      if (launch.stage === "Live" && h.entry.price !== null) {
        h.price = h.entry.price;
        h.priceSource = "curve";
      } else if (launch.stage === "Graduated" && isSet(launch.quoteMint)) {
        const pool = await findDammPool(connection, launch.crwaMint, launch.quoteMint).catch(() => null);
        if (pool) {
          h.price = sqrtPriceToQuoteAtoms(pool.sqrtPrice, launch.decimals);
          h.priceSource = "pool";
          h.pool = pool.address;
        }
      }
      if (h.price !== null) h.value = ((h.security + h.wrapper) * h.price) / 10n ** BigInt(launch.decimals);
    })
  );
  return held;
}
