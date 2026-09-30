/**
 * Read-only decoder for the Aegis `Launch` account.
 *
 * The layout is fixed-size (no strings or vectors), so it is read at fixed offsets rather than
 * through a general Borsh decoder. `aegis.test.ts` recomputes every offset from the program's IDL,
 * so if the program's account ever changes shape the test fails instead of the page misreading it.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import idl from "../idl/aegis.json";
import { AEGIS_PROGRAM_ID } from "./ids";

export type LaunchStage = "TokenCreated" | "Funded" | "Configured" | "Live" | "Graduated" | "Aborted";
export type Archetype = "FixedPar" | "BookBuilding" | "GrowthCapital";

/** A decoded `Launch` account, with every integer as a bigint so no amount ever loses precision. */
export type LaunchAccount = {
  address: PublicKey;
  issuer: PublicKey;
  realRwaMint: PublicKey;
  crwaMint: PublicKey;
  meteoraConfig: PublicKey;
  virtualPool: PublicKey;
  quoteMint: PublicKey;
  escrowVault: PublicKey;
  totalSupply: bigint;
  realRwaLocked: bigint;
  crwaMinted: bigint;
  issuerUnsold: bigint;
  decimals: number;
  stage: LaunchStage;
  archetype: Archetype;
};

export const LAUNCH_DISCRIMINATOR = Uint8Array.from(
  (idl.accounts.find((a) => a.name === "Launch") ?? { discriminator: [] }).discriminator
);
if (LAUNCH_DISCRIMINATOR.length !== 8) throw new Error("Launch discriminator missing from the IDL");

/** Byte offsets, discriminator included. Checked against the IDL in aegis.test.ts. */
export const LAUNCH_LAYOUT = {
  issuer: 8,
  realRwaMint: 40,
  crwaMint: 72,
  meteoraConfig: 104,
  virtualPool: 136,
  quoteMint: 168,
  escrowVault: 200,
  totalSupply: 232,
  realRwaLocked: 240,
  crwaMinted: 248,
  issuerUnsold: 256,
  vaultGroup: 264,
  investorGroup: 272,
  decimals: 280,
  stage: 281,
  archetype: 282,
  bump: 283,
  authorityBump: 284,
  size: 285,
} as const;

const STAGES: readonly LaunchStage[] = ["TokenCreated", "Funded", "Configured", "Live", "Graduated", "Aborted"];
const ARCHETYPES: readonly Archetype[] = ["FixedPar", "BookBuilding", "GrowthCapital"];

export function decodeLaunch(address: PublicKey, data: Uint8Array): LaunchAccount {
  const L = LAUNCH_LAYOUT;
  if (data.length < L.size) throw new Error("launch account too short");
  if (!LAUNCH_DISCRIMINATOR.every((b, i) => data[i] === b)) throw new Error("not a launch account");

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  const u64 = (at: number) => view.getBigUint64(at, true);
  const stage = STAGES[data[L.stage]!];
  const archetype = ARCHETYPES[data[L.archetype]!];
  if (!stage) throw new Error(`unknown launch stage ${data[L.stage]}`);
  if (!archetype) throw new Error(`unknown archetype ${data[L.archetype]}`);

  return {
    address,
    issuer: key(L.issuer),
    realRwaMint: key(L.realRwaMint),
    crwaMint: key(L.crwaMint),
    meteoraConfig: key(L.meteoraConfig),
    virtualPool: key(L.virtualPool),
    quoteMint: key(L.quoteMint),
    escrowVault: key(L.escrowVault),
    totalSupply: u64(L.totalSupply),
    realRwaLocked: u64(L.realRwaLocked),
    crwaMinted: u64(L.crwaMinted),
    issuerUnsold: u64(L.issuerUnsold),
    decimals: data[L.decimals]!,
    stage,
    archetype,
  };
}

export type LaunchScan = { launches: LaunchAccount[]; unreadable: number };

/**
 * Every launch the program owns. An account that fails to decode is counted, not thrown: one bad
 * account must never blank the whole registry.
 */
export async function fetchAllLaunches(connection: Connection): Promise<LaunchScan> {
  const accounts = await connection.getProgramAccounts(AEGIS_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(LAUNCH_DISCRIMINATOR) } }],
  });
  const launches: LaunchAccount[] = [];
  let unreadable = 0;
  for (const { pubkey, account } of accounts) {
    try {
      launches.push(decodeLaunch(pubkey, account.data));
    } catch {
      unreadable += 1;
    }
  }
  return { launches, unreadable };
}

export const isSet = (key: PublicKey) => !key.equals(PublicKey.default);
