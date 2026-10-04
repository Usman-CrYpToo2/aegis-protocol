/**
 * Durable nonces: transactions that don't expire while a wallet is open.
 *
 * A normal transaction carries a recent blockhash that the network honours for about 150 blocks,
 * roughly a minute. A launch hands a wallet eight transactions at once, each depending on the one
 * before, and a wallet that previews them one by one can take longer than that before it even shows
 * the approval. The batch is then dead on arrival however quickly anyone approves.
 *
 * A transaction whose first instruction advances a nonce account, and whose "blockhash" is that
 * account's stored value, stays valid until the nonce is advanced: in practice, until it lands.
 * Each transaction in a batch needs its own nonce account, because landing one advances its nonce.
 *
 * The accounts are derived from the wallet with fixed seeds, so they are found again for every later
 * launch with no keys to store. Only the wallet can advance or close them; each holds a small deposit.
 */
import { NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { sendSigned, withBackup } from "./send";

/** One account per transaction the largest batch sends: the eight launch steps. */
export const NONCE_COUNT = 8;
/** Per setup transaction: creating and initialising four accounts fits Solana's size limit. */
const PER_SETUP_TX = 4;

const seed = (i: number) => `aegis-nonce-${i}`;

export type Nonce = { address: PublicKey; value: string };

export function nonceAddresses(owner: PublicKey): Promise<PublicKey[]> {
  return Promise.all(Array.from({ length: NONCE_COUNT }, (_, i) => PublicKey.createWithSeed(owner, seed(i), SystemProgram.programId)));
}

/**
 * The wallet's nonce accounts and their current values, in order; `missing` lists the indexes not yet
 * created. An account that exists but isn't a nonce owned by this wallet is treated as missing, and
 * creating it would fail loudly rather than be used.
 */
export async function loadNonces(connection: Connection, owner: PublicKey): Promise<{ nonces: (Nonce | null)[]; missing: number[] }> {
  const addresses = await nonceAddresses(owner);
  const infos = await connection.getMultipleAccountsInfo(addresses, "confirmed");
  const nonces = infos.map((info, i) => {
    if (!info || !info.owner.equals(SystemProgram.programId) || info.data.length !== NONCE_ACCOUNT_LENGTH) return null;
    const account = NonceAccount.fromAccountData(info.data);
    return account.authorizedPubkey.equals(owner) ? { address: addresses[i]!, value: account.nonce } : null;
  });
  return { nonces, missing: nonces.flatMap((n, i) => (n ? [] : [i])) };
}

/** Instruction groups that create and initialise the given nonce accounts, a few per transaction. */
export async function setupInstructions(owner: PublicKey, indexes: number[], rentLamports: number): Promise<TransactionInstruction[][]> {
  const addresses = await nonceAddresses(owner);
  const groups: TransactionInstruction[][] = [];
  for (let at = 0; at < indexes.length; at += PER_SETUP_TX) {
    groups.push(
      indexes.slice(at, at + PER_SETUP_TX).flatMap((i) => [
        SystemProgram.createAccountWithSeed({ fromPubkey: owner, newAccountPubkey: addresses[i]!, basePubkey: owner, seed: seed(i), lamports: rentLamports, space: NONCE_ACCOUNT_LENGTH, programId: SystemProgram.programId }),
        SystemProgram.nonceInitialize({ noncePubkey: addresses[i]!, authorizedPubkey: owner }),
      ])
    );
  }
  return groups;
}

/** The instruction a nonce transaction must start with. */
export const advanceInstruction = (nonce: Nonce, owner: PublicKey) => SystemProgram.nonceAdvance({ noncePubkey: nonce.address, authorizedPubkey: owner });

/** What advancing a nonce adds to a transaction's compute. */
export const NONCE_UNITS = 5_000;

/**
 * The wallet's nonces, creating any that are missing first. Creating them is one short approval of
 * independent transactions (a wallet previews those at once, so a blockhash is fine for them);
 * `onSetup` fires just before, so a page can say what the approval is for.
 */
export async function ensureNonces(connection: Connection, owner: PublicKey, signAll: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>, onSetup?: () => void): Promise<Nonce[]> {
  let { nonces, missing } = await withBackup(connection, (c) => loadNonces(c, owner));
  if (missing.length) {
    onSetup?.();
    const rent = await withBackup(connection, (c) => c.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH));
    const groups = await setupInstructions(owner, missing, rent);
    const latest = await withBackup(connection, (c) => c.getLatestBlockhash("confirmed"));
    const txs = groups.map((ixs) => new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: latest.blockhash, instructions: ixs }).compileToV0Message()));
    for (const tx of await signAll(txs)) await sendSigned(connection, tx, latest.lastValidBlockHeight, true);
    ({ nonces, missing } = await withBackup(connection, (c) => loadNonces(c, owner)));
    if (missing.length) throw new Error("Your wallet’s approval accounts weren’t created. Try again.");
  }
  return nonces as Nonce[];
}

/**
 * How long a sent nonce transaction may take to land before a page stops waiting, in blocks (about
 * two minutes). It never expires on its own, so this is patience, not a deadline.
 */
export const LAND_WITHIN_BLOCKS = 300;
