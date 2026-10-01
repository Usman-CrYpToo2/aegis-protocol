import { ExtensionType, getExtensionData, unpackAccount, unpackMint } from "@solana/spl-token";
import { unpack as unpackTokenMetadata } from "@solana/spl-token-metadata";
import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./ids";

type Info = AccountInfo<Uint8Array>;

const asBuffer = (info: Info): AccountInfo<Buffer> => ({ ...info, data: Buffer.from(info.data) });

function tokenProgramOf(info: Info): PublicKey {
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error("not owned by a token program");
}

export type MintInfo = { supply: bigint; decimals: number; tlvData: Buffer; program: PublicKey };

export function decodeMint(address: PublicKey, info: Info): MintInfo {
  const program = tokenProgramOf(info);
  const mint = unpackMint(address, asBuffer(info), program);
  return { supply: mint.supply, decimals: mint.decimals, tlvData: mint.tlvData, program };
}

export type TokenAccountInfo = { mint: PublicKey; owner: PublicKey; amount: bigint; isFrozen: boolean };

export function decodeTokenAccount(address: PublicKey, info: Info): TokenAccountInfo {
  const account = unpackAccount(address, asBuffer(info), tokenProgramOf(info));
  return { mint: account.mint, owner: account.owner, amount: account.amount, isFrozen: account.isFrozen };
}

export type TokenLabel = {
  name: string;
  symbol: string;
  /** The issuer's offering documents, from the metadata link. Only a well-formed https URL. */
  docs: string | null;
};

/**
 * Metadata strings are written by whoever created the token, so they are untrusted: control
 * characters are stripped and length is capped before anything is rendered. React escapes the
 * rest.
 */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, max);
}

/** A metadata link worth showing: https only, so a hostile issuer can't plant a script URL. */
export function safeDocsUrl(value: string): string | null {
  const v = cleanText(value, 200);
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Name, symbol and documents link from a Token-2022 mint's embedded metadata, or null when it carries none. */
export function mintLabel(mint: MintInfo): TokenLabel | null {
  if (!mint.program.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const data = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData);
  if (!data) return null;
  try {
    const meta = unpackTokenMetadata(data);
    const name = cleanText(meta.name, 64);
    const symbol = cleanText(meta.symbol, 12);
    return name || symbol ? { name, symbol, docs: safeDocsUrl(meta.uri) } : null;
  } catch {
    return null;
  }
}
