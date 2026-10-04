/**
 * Asking a wallet to approve one transaction, so that a slow approval never sinks it.
 *
 * A normal transaction carries a blockhash the network honours for about a minute. A wallet that
 * already has its durable-nonce accounts (every issuer, and anyone who has filled a sale; see
 * chain/nonce) gets a nonce instead, which doesn't expire at all. Anyone else gets a blockhash, and
 * if their approval comes back after it has run out, nothing is sent: the transaction is rebuilt
 * with a fresh one and the wallet is asked once more. A new user is never made to approve a setup
 * step just to make a single transaction.
 */
import type { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { LAND_WITHIN_BLOCKS, loadNonces, NONCE_COUNT, type Nonce } from "./nonce";
import { confirmSignature, sendSigned, withBackup } from "./send";
import type { PreparedTx } from "./tx";
import { trackWallet } from "../lib/walletWait";

/** A blockhash must have at least this many blocks left when the wallet returns, or it is re-asked. */
const SEND_MARGIN_BLOCKS = 20;

/** The approval came back after its blockhash ran out, twice. Nothing was sent. */
export class ApprovalTooSlowError extends Error {
  readonly approvalTooSlow = true;
  constructor() {
    super("The approval took longer than the network accepts; nothing was sent.");
  }
}

export type Wallet = {
  signTransaction?: <T extends VersionedTransaction>(tx: T) => Promise<T>;
  sendTransaction: (tx: VersionedTransaction, connection: Connection, options?: { preflightCommitment?: "confirmed"; signers?: Keypair[] }) => Promise<string>;
};

/** The nonce a single transaction can use without any setup: the wallet's last one, if it has all eight. */
export async function spareNonce(connection: Connection, owner: Parameters<typeof loadNonces>[1]): Promise<Nonce | undefined> {
  try {
    const { nonces, missing } = await withBackup(connection, (c) => loadNonces(c, owner));
    return missing.length === 0 ? (nonces[NONCE_COUNT - 1] ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds (with a nonce when there is one), has the wallet approve, and lands the transaction.
 * `build` is called again for a second approval. `onSigned` fires once the wallet has approved;
 * `onRetry` just before the wallet is asked a second time.
 */
export async function approveAndSend(
  connection: Connection,
  wallet: Wallet,
  owner: Parameters<typeof loadNonces>[1],
  build: (nonce?: Nonce) => Promise<PreparedTx>,
  { signers = [], onSigned, onRetry }: { signers?: Keypair[]; onSigned?: () => void; onRetry?: () => void } = {}
): Promise<string> {
  if (!wallet.signTransaction) {
    // A wallet that can only send for itself: no chance to check the timing in between.
    const prepared = await build();
    const signature = await trackWallet(wallet.sendTransaction(prepared.transaction, connection, { preflightCommitment: "confirmed", signers }));
    onSigned?.();
    await confirmSignature(connection, signature, prepared.lastValidBlockHeight);
    return signature;
  }
  const nonce = await spareNonce(connection, owner);
  for (let attempt = 1; ; attempt++) {
    const prepared = await build(nonce);
    if (signers.length) prepared.transaction.sign(signers);
    const signed = await trackWallet(wallet.signTransaction(prepared.transaction));
    const height = await withBackup(connection, (c) => c.getBlockHeight("confirmed"));
    if (nonce) {
      onSigned?.();
      return sendSigned(connection, signed, height + LAND_WITHIN_BLOCKS, true);
    }
    if (height + SEND_MARGIN_BLOCKS <= prepared.lastValidBlockHeight) {
      onSigned?.();
      return sendSigned(connection, signed, prepared.lastValidBlockHeight, true);
    }
    if (attempt >= 2) throw new ApprovalTooSlowError();
    onRetry?.();
  }
}
