import { Connection, type GetProgramAccountsConfig, type PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { withBackup } from "./send";

let index: Connection | null = null;
let publicDevnet: Connection | null = null;

/**
 * Lists a program's accounts through the index endpoint when one is configured, and through the
 * app's own connection otherwise. Only this call is split off: some free RPC plans refuse it while
 * serving everything else, and the opposite plan can carry it.
 *
 * If that endpoint can't answer (down, unreachable, refusing), the app's own connection is tried,
 * then on devnet Solana's public endpoint: a listing page should never hang on one provider.
 */
export async function programAccounts(connection: Connection, programId: PublicKey, options: GetProgramAccountsConfig) {
  const routes: Connection[] = [];
  if (config.indexRpcUrl) routes.push((index ??= new Connection(config.indexRpcUrl, "confirmed")));
  routes.push(connection);
  if (config.cluster === "devnet") routes.push((publicDevnet ??= new Connection("https://api.devnet.solana.com", "confirmed")));
  let last: unknown;
  for (const via of routes) {
    try {
      return await via.getProgramAccounts(programId, options);
    } catch (e) {
      last = e;
    }
  }
  throw last;
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
  const largest = (await withBackup(connection, (c) => c.getTokenLargestAccounts(mint, "confirmed"))).value;
  const infos = await withBackup(connection, (c) => c.getMultipleAccountsInfo(largest.map((l) => l.address), "confirmed"));
  return largest.flatMap((l, i) => (infos[i] ? [{ pubkey: l.address, account: infos[i]! }] : []));
}
