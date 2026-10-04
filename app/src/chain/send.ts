/**
 * Sending and confirming, built to survive a slow or rate-limited RPC.
 *
 * web3.js's `confirmTransaction` waits on a websocket notification. Some providers' websockets are
 * slow, limited or missing, and then a transaction that landed long ago is reported as expired.
 * This asks for the signature's status directly instead, once a second, and while it waits it
 * re-sends the same signed bytes every couple of seconds, which is the standard way to get a
 * transaction through a congested network. Re-sending is safe: the network keeps only one copy of
 * a signature.
 *
 * A free endpoint also drops out now and then for a few seconds. Every call here falls back to the
 * second endpoint (VITE_INDEX_RPC_URL) when the first can't be reached, and every signed transaction
 * is broadcast through both: the network keeps one copy, and whichever path is up delivers it.
 */
import { Connection, type VersionedTransaction } from "@solana/web3.js";
import { config } from "../config";
import { rpcConfig } from "./rpc";

/** The transaction's blockhash ran out before it landed. Nothing in it happened. */
export class ExpiredError extends Error {
  readonly expired = true;
  constructor(signature: string) {
    super(`Transaction ${signature} expired: block height exceeded before it landed`);
  }
}

export const isExpired = (e: unknown): e is ExpiredError => Boolean(e && typeof e === "object" && "expired" in e);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const backup = config.indexRpcUrl && config.indexRpcUrl !== config.rpcUrl ? new Connection(config.indexRpcUrl, rpcConfig()) : null;

/** The endpoint couldn't be reached or refused for load; not an answer about the transaction. */
export const isNetworkError = (e: unknown) =>
  /fetch|network|socket|abort|ECONN|ETIMEDOUT|timed? ?out|\b50[0234]\b|\b429\b/i.test(e instanceof Error ? e.message : String(e));

/** Runs `call` on the main endpoint, and once more on the backup if the main one couldn't be reached. */
export async function withBackup<T>(connection: Connection, call: (c: Connection) => Promise<T>): Promise<T> {
  try {
    return await call(connection);
  } catch (e) {
    if (!backup || !isNetworkError(e)) throw e;
    return call(backup);
  }
}

/** Hands signed bytes to the backup too, without waiting: a second path to the network. */
const broadcast = (raw: Uint8Array) => void backup?.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
const TICK_MS = 500;

/**
 * Resolves once `signature` is confirmed. Throws the program's error (with its logs) if it failed,
 * or `ExpiredError` once the blockhash has run out without it landing. Pass the signed bytes as
 * `raw` to have them re-sent while waiting.
 */
export async function confirmSignature(connection: Connection, signature: string, lastValidBlockHeight: number, raw?: Uint8Array): Promise<void> {
  for (let tick = 0; ; tick++) {
    const status = (await withBackup(connection, (c) => c.getSignatureStatuses([signature]))).value[0];
    if (status?.err) {
      const info = await withBackup(connection, (c) => c.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).catch(() => null);
      throw Object.assign(new Error(JSON.stringify(status.err)), { logs: info?.meta?.logMessages ?? [] });
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    // Once it has been seen in a block, give it time to confirm rather than calling it expired; only a
    // transaction never seen, or one lost with a dropped fork, runs out.
    if (tick % 4 === 3) {
      const height = await withBackup(connection, (c) => c.getBlockHeight("confirmed"));
      if (!status && height > lastValidBlockHeight) {
        const last = (await withBackup(connection, (c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
        if (!last) throw new ExpiredError(signature);
      } else if (height > lastValidBlockHeight + 150) {
        throw new ExpiredError(signature);
      }
    }
    if (raw && !status && tick % 2 === 1) {
      void connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      broadcast(raw);
    }
    await sleep(TICK_MS);
  }
}

/**
 * Sends a signed transaction and waits for it. `check` runs the network's own simulation first,
 * which is right for a transaction whose accounts already exist; later steps of a batch depend on
 * earlier ones landing, so they skip it.
 */
export async function sendSigned(connection: Connection, tx: VersionedTransaction, lastValidBlockHeight: number, check: boolean): Promise<string> {
  const raw = tx.serialize();
  const send = (skipPreflight: boolean) => withBackup(connection, (c) => c.sendRawTransaction(raw, { skipPreflight, preflightCommitment: "confirmed", maxRetries: 0 }));
  let signature: string;
  try {
    signature = await send(!check);
  } catch (e) {
    // A server a few slots behind the one that issued the blockhash doesn't know it yet, and its
    // pre-check rejects a perfectly good transaction. Send it anyway and let the network decide:
    // if it really is stale, the wait below ends in ExpiredError.
    if (!check || !/blockhash not found/i.test(e instanceof Error ? e.message : String(e))) throw e;
    signature = await send(true);
  }
  broadcast(raw);
  await confirmSignature(connection, signature, lastValidBlockHeight, raw);
  return signature;
}
