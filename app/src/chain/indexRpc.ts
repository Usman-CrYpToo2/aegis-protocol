import { Connection, type GetProgramAccountsConfig, type PublicKey } from "@solana/web3.js";
import { config } from "../config";

let index: Connection | null = null;

/**
 * Lists a program's accounts through the index endpoint when one is configured, and through the
 * app's own connection otherwise. Only this call is split off: some free RPC plans refuse it while
 * serving everything else, and the opposite plan can carry it.
 */
export function programAccounts(connection: Connection, programId: PublicKey, options: GetProgramAccountsConfig) {
  const via = config.indexRpcUrl ? (index ??= new Connection(config.indexRpcUrl, "confirmed")) : connection;
  return via.getProgramAccounts(programId, options);
}

/**
 * The largest token accounts of one mint (up to 20), with their data, in the shape
 * getProgramAccounts returns.
 *
 * Finding every holder of a Token-2022 mint would mean scanning every Token-2022 account on the
 * network, which a public cluster can't answer in time. The network's own largest-holders lookup is
 * instant and enough for the console: it lists the holders that matter most.
 */
export async function largestTokenAccounts(connection: Connection, mint: PublicKey) {
  const largest = (await connection.getTokenLargestAccounts(mint, "confirmed")).value;
  const infos = await connection.getMultipleAccountsInfo(largest.map((l) => l.address), "confirmed");
  return largest.flatMap((l, i) => (infos[i] ? [{ pubkey: l.address, account: infos[i]! }] : []));
}
