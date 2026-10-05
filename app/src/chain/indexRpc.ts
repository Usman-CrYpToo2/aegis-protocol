import { Connection, PublicKey, type AccountInfo, type GetProgramAccountsConfig } from "@solana/web3.js";
import { config } from "../config";
import { LISTING_TIMEOUT_MS, rpcConfig } from "./rpc";
import { withBackup } from "./send";

type Listed = { pubkey: PublicKey; account: AccountInfo<Buffer> };

/** A route that just failed is skipped for this long, so a dead provider doesn't slow every page. */
const REST_MS = 120_000;
/** How long a listing route gets before the next one is asked as well; the first answer wins. */
const HEDGE_MS = 3_000;
/** getMultipleAccountsInfo's own limit per request. */
const PER_READ = 100;

// A listing route gives up at once on "too many requests" rather than backing off for seconds:
// the next route, or the remembered addresses, answer faster.
const listingConfig = () => ({ ...rpcConfig(LISTING_TIMEOUT_MS), disableRetryOnRateLimit: true });
let routes: Connection[] | null = null;
const resting = new Map<Connection, number>();
const inflight = new Map<string, Promise<readonly Listed[]>>();

function listingRoutes(connection: Connection): Connection[] {
  routes ??= [
    ...config.indexRpcUrls.map((url) => new Connection(url, listingConfig())),
    ...(config.cluster === "devnet" ? [new Connection("https://api.devnet.solana.com", listingConfig())] : []),
  ];
  // The app's own connection comes last: its plan may refuse listings (Alchemy's free plan does).
  return [...routes, connection];
}

/**
 * Asks the routes in turn, without waiting for a slow one: each gets HEDGE_MS before the next is
 * asked too, and a failure moves on at once. The first answer wins; it fails only if all fail.
 */
function hedged<T>(routes: Connection[], call: (c: Connection) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let failed = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      if (settled || next >= routes.length) return;
      const via = routes[next++]!;
      clearTimeout(timer);
      timer = setTimeout(ask, HEDGE_MS);
      call(via).then(
        (answer) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resting.delete(via);
          resolve(answer);
        },
        (e) => {
          resting.set(via, Date.now() + REST_MS);
          if (settled) return;
          if (++failed === routes.length) {
            settled = true;
            clearTimeout(timer);
            reject(e);
          } else ask();
        },
      );
    };
    ask();
  });
}

// The addresses each listing found last time, kept in this browser. If every route fails, those
// accounts are re-read directly, by address, through the app's own endpoint: their data is current,
// and only an account created since the last successful listing is missed until a route recovers.
const storeKey = (programId: PublicKey, options: GetProgramAccountsConfig) =>
  `aegis:listing:${config.cluster}:${programId.toBase58()}:${JSON.stringify(options.filters ?? [])}`;

function remember(key: string, found: readonly Listed[]) {
  try {
    localStorage.setItem(key, JSON.stringify(found.map((f) => f.pubkey.toBase58())));
  } catch {
    // Storage unavailable (private window, quota): the listing still works, just without this fallback.
  }
}

function recall(key: string): PublicKey[] {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "[]") as string[]).map((a) => new PublicKey(a));
  } catch {
    return [];
  }
}

async function readKnown(connection: Connection, programId: PublicKey, known: PublicKey[]): Promise<readonly Listed[]> {
  const out: Listed[] = [];
  for (let i = 0; i < known.length; i += PER_READ) {
    const chunk = known.slice(i, i + PER_READ);
    const infos = await withBackup(connection, (c) => c.getMultipleAccountsInfo(chunk, "confirmed"));
    chunk.forEach((pubkey, j) => {
      const account = infos[j];
      if (account && account.owner.equals(programId)) out.push({ pubkey, account });
    });
  }
  return out;
}

async function list(connection: Connection, programId: PublicKey, options: GetProgramAccountsConfig, key: string): Promise<readonly Listed[]> {
  const all = listingRoutes(connection);
  const now = Date.now();
  const awake = all.filter((r) => (resting.get(r) ?? 0) <= now);
  try {
    const found = await hedged(awake.length ? awake : all, (via) => via.getProgramAccounts(programId, options));
    remember(key, found);
    return found;
  } catch (e) {
    const known = recall(key);
    if (known.length) return readKnown(connection, programId, known);
    throw e;
  }
}

/**
 * Lists a program's accounts through the index endpoints when configured, then on devnet Solana's
 * public endpoint, then the app's own connection: a listing page should never hang on one
 * provider. If all of them fail, the accounts found last time are re-read by address. Identical
 * listings asked for at the same moment (several parts of a page) share one request.
 */
export function programAccounts(connection: Connection, programId: PublicKey, options: GetProgramAccountsConfig): Promise<readonly Listed[]> {
  const key = storeKey(programId, options);
  let pending = inflight.get(key);
  if (!pending) {
    pending = list(connection, programId, options, key).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
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
