import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { sqrtPriceToQuoteAtoms } from "../lib/amount";
import { fetchAllLaunches, isSet, type LaunchAccount } from "./aegis";
import { assessBacking, type Backing } from "./backing";
import { AEGIS_PROGRAM_ID } from "./ids";
import { decodeDbcConfig, decodeDbcPool, type DbcConfig, type DbcPool } from "./meteora";
import { decodeMint, decodeTokenAccount, mintLabel, type TokenLabel } from "./token";

export type QuoteToken = { mint: PublicKey; symbol: string; decimals: number };

export type RegistryEntry = {
  launch: LaunchAccount;
  /** From the asset's own metadata. Null when the mint carries none or could not be read. */
  label: TokenLabel | null;
  /** The wrapper's own metadata; null until the wrapper exists. */
  wrapperLabel: TokenLabel | null;
  backing: Backing;
  quote: QuoteToken | null;
  /** Current curve price of one whole wrapper, in quote atoms. Only while the offering is open. */
  price: bigint | null;
  /** Quote raised so far and the target. Present from `Live` on. */
  raise: { raised: bigint; target: bigint } | null;
  /** Human-readable reasons some part of this entry could not be read. */
  problems: string[];
};

export type Registry = {
  entries: RegistryEntry[];
  /** Launch accounts that exist but could not be decoded; surfaced, never silently dropped. */
  unreadable: number;
  /** When this snapshot was read. */
  readAt: number;
};

export class ProgramNotDeployedError extends Error {
  constructor() {
    super(`Aegis is not deployed on ${config.cluster}.`);
  }
}

type Info = AccountInfo<Uint8Array>;

/** getMultipleAccountsInfo accepts at most 100 keys per call. */
async function readMany(connection: Connection, keys: PublicKey[]): Promise<Map<string, Info | null>> {
  const unique = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
  const out = new Map<string, Info | null>();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    chunk.forEach((k, j) => out.set(k.toBase58(), infos[j] ?? null));
  }
  return out;
}

function quoteSymbol(mint: PublicKey, label: TokenLabel | null): string {
  return config.quoteLabels.get(mint.toBase58()) ?? label?.symbol ?? "tokens";
}

/**
 * Runs `read` and records a readable problem instead of throwing, so one damaged account costs
 * one cell of one row rather than the whole page.
 */
function attempt<T>(problems: string[], what: string, read: () => T): T | undefined {
  try {
    return read();
  } catch (e) {
    problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function buildEntry(launch: LaunchAccount, accounts: Map<string, Info | null>): RegistryEntry {
  const problems: string[] = [];
  const get = (key: PublicKey, what: string): Info | undefined => {
    const info = accounts.get(key.toBase58());
    if (!info) problems.push(`${what}: account not found`);
    return info ?? undefined;
  };

  const realInfo = get(launch.realRwaMint, "asset mint");
  const realMint = realInfo && attempt(problems, "asset mint", () => decodeMint(launch.realRwaMint, realInfo));
  const label = realMint ? mintLabel(realMint) : null;

  // The escrow is only trusted if it really is a token account for this asset's mint.
  let escrowed: bigint | undefined;
  if (isSet(launch.escrowVault)) {
    const info = get(launch.escrowVault, "escrow");
    const vault = info && attempt(problems, "escrow", () => decodeTokenAccount(launch.escrowVault, info));
    if (vault && !vault.mint.equals(launch.realRwaMint)) problems.push("escrow: holds a different token");
    else escrowed = vault?.amount;
  }

  let circulating: bigint | undefined;
  let wrapperLabel: TokenLabel | null = null;
  if (isSet(launch.crwaMint)) {
    const info = get(launch.crwaMint, "wrapper mint");
    const mint = info && attempt(problems, "wrapper mint", () => decodeMint(launch.crwaMint, info));
    circulating = mint?.supply;
    wrapperLabel = mint ? mintLabel(mint) : null;
  }

  let quote: QuoteToken | null = null;
  if (isSet(launch.quoteMint)) {
    const info = get(launch.quoteMint, "quote mint");
    const mint = info && attempt(problems, "quote mint", () => decodeMint(launch.quoteMint, info));
    if (mint) quote = { mint: launch.quoteMint, symbol: quoteSymbol(launch.quoteMint, mintLabel(mint)), decimals: mint.decimals };
  }

  let pool: DbcPool | undefined;
  let dbcConfig: DbcConfig | undefined;
  if (launch.stage === "Live" || launch.stage === "Graduated") {
    const poolInfo = isSet(launch.virtualPool) ? get(launch.virtualPool, "pool") : undefined;
    pool = poolInfo && attempt(problems, "pool", () => decodeDbcPool(poolInfo));
    // A pool is only believed if it is the one this launch recorded, trading this wrapper.
    if (pool && (!pool.config.equals(launch.meteoraConfig) || !pool.baseMint.equals(launch.crwaMint))) {
      problems.push("pool: does not match this launch");
      pool = undefined;
    }
    const configInfo = isSet(launch.meteoraConfig) ? get(launch.meteoraConfig, "sale terms") : undefined;
    dbcConfig = configInfo && attempt(problems, "sale terms", () => decodeDbcConfig(configInfo));
  }

  const raise =
    dbcConfig && (launch.stage === "Graduated" || pool)
      ? {
          // After graduation Meteora moves the reserve into the permanent pool, so the target
          // is what was raised.
          raised: launch.stage === "Graduated" ? dbcConfig.migrationQuoteThreshold : pool!.quoteReserve,
          target: dbcConfig.migrationQuoteThreshold,
        }
      : null;

  return {
    launch,
    label,
    wrapperLabel,
    backing: assessBacking({ stage: launch.stage, totalSupply: launch.totalSupply, escrowed, circulating }),
    quote,
    price: launch.stage === "Live" && pool && !pool.isMigrated ? sqrtPriceToQuoteAtoms(pool.sqrtPrice, launch.decimals) : null,
    raise,
    problems,
  };
}

export async function loadRegistry(connection: Connection): Promise<Registry> {
  const program = await connection.getAccountInfo(AEGIS_PROGRAM_ID, "confirmed");
  if (!program?.executable) throw new ProgramNotDeployedError();

  const { launches, unreadable } = await fetchAllLaunches(connection);
  const keys = launches.flatMap((l) =>
    [l.realRwaMint, l.crwaMint, l.escrowVault, l.quoteMint, l.virtualPool, l.meteoraConfig].filter(isSet)
  );
  const accounts = await readMany(connection, keys);
  return { entries: launches.map((l) => buildEntry(l, accounts)), unreadable, readAt: Date.now() };
}
