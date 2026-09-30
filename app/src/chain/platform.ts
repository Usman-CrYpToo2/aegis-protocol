/**
 * The platform's settings and approved quote tokens: the limits every launch's terms must meet.
 * Decoded at fixed offsets; platform.test.ts derives the offsets from the IDL.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import idl from "../idl/aegis.json";
import bs58 from "bs58";
import { AEGIS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./ids";
import { quoteSymbol } from "./registry";
import { decodeMint, mintLabel } from "./token";

const disc = (name: string) => idl.accounts.find((a) => a.name === name)!.discriminator;

export type PlatformConfig = {
  feeRecipient: PublicKey;
  creationFeeLamports: bigint;
  isPaused: boolean;
  curveFeeBps: number;
  issuerCurveFeeSharePct: number;
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

export const PLATFORM_LAYOUT = { feeRecipient: 40, creationFee: 72, isPaused: 80, curveFeeBps: 81, issuerCurveShare: 83, aegisMigrationShare: 84, aegisLpShare: 85, minMigration: 86, maxMigration: 87, minPermanent: 88, minVesting: 89, maxVesting: 91, minPoolFee: 93, maxPoolFee: 95, size: 98 } as const;
export const QUOTE_LAYOUT = { mint: 8, decimals: 40, isActive: 41, isLegacySpl: 42, minRaise: 43, size: 60 } as const;

const hasDisc = (data: Uint8Array, d: number[]) => d.every((b, i) => data[i] === b);

export function decodePlatformConfig(data: Uint8Array): PlatformConfig {
  const L = PLATFORM_LAYOUT;
  if (data.length < L.size || !hasDisc(data, disc("PlatformConfig"))) throw new Error("Not the Aegis platform settings.");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    feeRecipient: new PublicKey(data.subarray(L.feeRecipient, L.feeRecipient + 32)),
    creationFeeLamports: v.getBigUint64(L.creationFee, true),
    isPaused: data[L.isPaused] === 1,
    curveFeeBps: v.getUint16(L.curveFeeBps, true),
    issuerCurveFeeSharePct: data[L.issuerCurveShare]!,
    aegisMigrationFeeSharePct: data[L.aegisMigrationShare]!,
    aegisLpSharePct: data[L.aegisLpShare]!,
    minMigrationFeePct: data[L.minMigration]!,
    maxMigrationFeePct: data[L.maxMigration]!,
    minIssuerPermanentPct: data[L.minPermanent]!,
    minVestingMonths: v.getUint16(L.minVesting, true),
    maxVestingMonths: v.getUint16(L.maxVesting, true),
    minPoolFeeBps: v.getUint16(L.minPoolFee, true),
    maxPoolFeeBps: v.getUint16(L.maxPoolFee, true),
  };
}

export type QuoteToken = { mint: PublicKey; decimals: number; isActive: boolean; minRaise: bigint; symbol: string; program: PublicKey };

export function decodeQuoteToken(data: Uint8Array) {
  const L = QUOTE_LAYOUT;
  if (data.length < L.size || !hasDisc(data, disc("QuoteToken"))) throw new Error("Not an Aegis quote token.");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { mint: new PublicKey(data.subarray(L.mint, L.mint + 32)), decimals: data[L.decimals]!, isActive: data[L.isActive] === 1, minRaise: v.getBigUint64(L.minRaise, true) };
}

export const platformConfigAddress = () => PublicKey.findProgramAddressSync([new TextEncoder().encode("platform_config")], AEGIS_PROGRAM_ID)[0];
export const quoteTokenAddress = (mint: PublicKey) => PublicKey.findProgramAddressSync([new TextEncoder().encode("quote_token"), mint.toBytes()], AEGIS_PROGRAM_ID)[0];

export type Platform = { config: PlatformConfig; quotes: QuoteToken[] };

export async function loadPlatform(connection: Connection): Promise<Platform> {
  const info = await connection.getAccountInfo(platformConfigAddress(), "confirmed");
  if (!info || !info.owner.equals(AEGIS_PROGRAM_ID)) throw new Error("Aegis isn’t set up on this network yet.");
  const config = decodePlatformConfig(info.data);
  const accounts = await connection.getProgramAccounts(AEGIS_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("QuoteToken")) } }],
  });
  const active = accounts.flatMap(({ account }) => { try { return [decodeQuoteToken(account.data)]; } catch { return []; } }).filter((q) => q.isActive);
  const mints = await connection.getMultipleAccountsInfo(active.map((q) => q.mint), "confirmed");
  const quotes = active.flatMap((q, i) => {
    const m = mints[i];
    // A quote token's program owns its mint; only the two token programs are real mints.
    if (!m || !(m.owner.equals(TOKEN_PROGRAM_ID) || m.owner.equals(TOKEN_2022_PROGRAM_ID))) return [];
    return [{ ...q, symbol: quoteSymbol(q.mint, mintLabel(decodeMint(q.mint, m))), program: m.owner }];
  });
  return { config, quotes };
}
