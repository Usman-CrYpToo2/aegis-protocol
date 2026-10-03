/**
 * Paying and being paid in SOL when a sale is priced in wrapped SOL.
 *
 * Meteora trades the SPL token form of SOL, which lives in a token account. People hold plain SOL,
 * so the app treats the two as one balance: a buy spends wrapped SOL first and wraps only the
 * shortfall, in the same transaction. Only what the app wrapped is unwrapped again: a token account
 * it had to create for the trade is closed at the end, returning its contents and its deposit as
 * SOL; an account the wallet already had is left exactly as it was.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";

export const isNativeMint = (mint: PublicKey) => mint.equals(NATIVE_MINT);

export const wsolAccount = (owner: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);

/**
 * The network's deposit rate. A deposit is linear in size, (bytes + 128) × a per-byte rate, so the
 * deposit for an empty account (128 bytes of overhead) fixes every other one. Read from the network
 * rather than assumed: the rate has been lowered before and may be again.
 */
export type RentRate = { emptyAccount: bigint };
export const rentFor = (bytes: number, rate: RentRate) => ((BigInt(bytes) + 128n) * rate.emptyAccount) / 128n;
/** A wrapped SOL account. */
export const WSOL_ACCOUNT_BYTES = 165;
/** A wrapper account: Token-2022 with the immutable-owner and transfer-hook-account extensions. */
export const WRAPPER_ACCOUNT_BYTES = 175;
/** Network fees for the one transaction, with room to spare. */
export const FEE_ALLOWANCE = 100_000n;

/** Moves `lamports` of the wallet's SOL into its wrapped SOL account, creating it if needed. */
export function wrapInstructions(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const account = wsolAccount(owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, account, owner, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: account, lamports }),
    createSyncNativeInstruction(account),
  ];
}

/** Closes the wallet's wrapped SOL account, returning everything in it as SOL. */
export const unwrapInstruction = (owner: PublicKey): TransactionInstruction => createCloseAccountInstruction(wsolAccount(owner), owner, owner);

export type SolBuyPlan = {
  /** SOL to wrap on top of the wrapped SOL already held. */
  wrap: bigint;
  /** Close the wrapped SOL account afterwards: true when the trade creates it. */
  unwrap: boolean;
};

/** How a buy of `amount` lamports is funded from wrapped SOL first, then SOL. */
export function planSolBuy(amount: bigint, wrapped: bigint, hasWrappedAccount: boolean): SolBuyPlan {
  return { wrap: amount > wrapped ? amount - wrapped : 0n, unwrap: !hasWrappedAccount };
}

export type SolWallet = { sol: bigint; wrapped: bigint; hasWrappedAccount: boolean; hasWrapperAccount: boolean; rate: RentRate };

/**
 * SOL a buy must leave untouched: the network fee, the wallet's own floor (a wallet cannot drop
 * below an empty account's deposit without closing), and the deposits of any
 * account the buy opens. A wrapped SOL account the buy creates is closed again in the same
 * transaction, but its deposit still has to be there while it exists.
 */
export function solReserve(w: SolWallet): bigint {
  const wallet = rentFor(0, w.rate);
  const wrapper = w.hasWrapperAccount ? 0n : rentFor(WRAPPER_ACCOUNT_BYTES, w.rate);
  const wrapped = w.hasWrappedAccount ? 0n : rentFor(WSOL_ACCOUNT_BYTES, w.rate);
  return FEE_ALLOWANCE + wallet + wrapper + wrapped;
}

/** The most this wallet can put into a SOL-priced buy, after the reserve. */
export function spendableSol(w: SolWallet): bigint {
  const free = w.sol - solReserve(w);
  return w.wrapped + (free > 0n ? free : 0n);
}
