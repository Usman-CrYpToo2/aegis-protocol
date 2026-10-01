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
