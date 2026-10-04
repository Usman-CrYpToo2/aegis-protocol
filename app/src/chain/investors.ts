/**
 * The issuer's register of approved investors, kept by Upside's Transfer Restrictions program.
 *
 * Approving a wallet is what the test scripts do for the local buyer, in four instructions:
 * create its security token account, register a holder, put the holder in the investor group,
 * and create the wallet's security-associated account (its approval record). Built by
 * issue.ts `holderInstructions`; investors.test.ts checks every account against the IDL.
 *
 * Aegis only reads this register. The issuer signs every change, as the holder of Upside's roles.
 */
import { largestTokenAccounts } from "./indexRpc";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import type { LaunchAccount } from "./aegis";
import { bridgeAddresses } from "./bridge";
import { holderInstructions } from "./issue";
import { ACCESS_CONTROL_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";
import { advanceInstruction, NONCE_UNITS, sealInstruction, type Nonce } from "./nonce";

const text = (s: string) => new TextEncoder().encode(s);
const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const pda = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export function registerAddresses(launch: LaunchAccount, issuer: PublicKey, wallet: PublicKey, holderId: bigint) {
  const trd = bridgeAddresses(launch, issuer).trd;
  const holder = pda([text("trh"), trd.toBytes(), u64(holderId)], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  const tokenAccount = getAssociatedTokenAddressSync(launch.realRwaMint, wallet, false, TOKEN_2022_PROGRAM_ID);
  return {
    trd,
    holder,
    tokenAccount,
    group: pda([text("trg"), trd.toBytes(), u64(launch.investorGroup)], TRANSFER_RESTRICTIONS_PROGRAM_ID),
    holderGroup: pda([text("trhg"), holder.toBytes(), u64(launch.investorGroup)], TRANSFER_RESTRICTIONS_PROGRAM_ID),
    saa: pda([text("saa"), tokenAccount.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID),
    accessControl: pda([text("ac"), launch.realRwaMint.toBytes()], ACCESS_CONTROL_PROGRAM_ID),
    authorityRole: pda([text("wallet_role"), launch.realRwaMint.toBytes(), issuer.toBytes()], ACCESS_CONTROL_PROGRAM_ID),
  };
}

/** The four instructions that put `wallet` in the investor group as holder number `holderId`. */
export function approveInstructions(launch: LaunchAccount, issuer: PublicKey, wallet: PublicKey, holderId: bigint): TransactionInstruction[] {
  return holderInstructions(launch.realRwaMint, issuer, wallet, launch.investorGroup, holderId);
}

/** The next holder number the register will accept: Upside's `holder_ids` counter. */
export async function nextHolderId(connection: Connection, launch: LaunchAccount): Promise<bigint> {
  const trd = bridgeAddresses(launch, launch.issuer).trd;
  const info = await connection.getAccountInfo(trd, "confirmed");
  if (!info || !info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) || info.data.length < 88) throw new Error("The register for this asset couldn’t be read.");
  return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(80, true);
}

/**
 * Splits wallets into groups small enough for one transaction each. Size depends only on the
 * accounts, not on the holder numbers, so the groups are decided once; each group's holder numbers
 * are read fresh when it is sent (approvalBatch), because they must be the register's next ones.
 */
export function approvalChunks(launch: LaunchAccount, issuer: PublicKey, wallets: PublicKey[]): PublicKey[][] {
  const fits = (ws: PublicKey[]) => {
    try {
      const ixs = ws.flatMap((w, i) => approveInstructions(launch, issuer, w, BigInt(i)));
      const msg = new TransactionMessage({ payerKey: issuer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToLegacyMessage();
      // + one signature, + room for what sending adds: the compute limit, the nonce advance and the
      // co-signed seal (chain/nonce), about 260 bytes in all.
      return new VersionedTransaction(msg).serialize().length + 260 <= 1232;
    } catch {
      return false;
    }
  };
  const chunks: PublicKey[][] = [];
  let current: PublicKey[] = [];
  for (const wallet of wallets) {
    if (current.length && !fits([...current, wallet])) {
      chunks.push(current);
      current = [];
    }
    current.push(wallet);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Instructions approving `wallets`, numbered from the register's next free holder number. */
export async function approvalBatch(connection: Connection, launch: LaunchAccount, issuer: PublicKey, wallets: PublicKey[]): Promise<TransactionInstruction[]> {
  const first = await nextHolderId(connection, launch);
  return wallets.flatMap((w, i) => approveInstructions(launch, issuer, w, first + BigInt(i)));
}

/** Compute per approved wallet when approvals are signed together (measured: 79k for one, 140k for two). */
const UNITS_PER_WALLET = 110_000;

/**
 * Every approval as transactions that share one blockhash, for the wallet to sign at once and the
 * app to send in order. Only the first can be simulated (the holder numbers that follow depend on
 * it landing), so each carries a fixed compute limit. Holder numbers are consecutive from the
 * register's next one.
 */
/**
 * The approval transactions for `wallets`. With `nonces` (one per transaction, see chain/nonce) they
 * don't expire while a wallet previews them, and each is sealed so a wallet can't rewrite it.
 */
export async function approvalTransactions(connection: Connection, launch: LaunchAccount, issuer: PublicKey, wallets: PublicKey[], blockhash: string, nonces?: Nonce[]): Promise<VersionedTransaction[]> {
  let next = await nextHolderId(connection, launch);
  return approvalChunks(launch, issuer, wallets).map((chunk, i) => {
    const ixs = chunk.flatMap((w) => approveInstructions(launch, issuer, w, next++));
    const nonce = nonces?.[i];
    const seal = nonce ? sealInstruction() : null;
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: issuer, recentBlockhash: nonce ? nonce.value : blockhash,
      instructions: [
        ...(nonce ? [advanceInstruction(nonce, issuer)] : []),
        ComputeBudgetProgram.setComputeUnitLimit({ units: UNITS_PER_WALLET * chunk.length + (nonce ? NONCE_UNITS : 0) }),
        ...ixs,
        ...(seal ? [seal.instruction] : []),
      ],
    }).compileToV0Message());
    if (seal) tx.sign([seal.signer]);
    return tx;
  });
}

/** The refundable deposit Solana holds for one approval's four new accounts, in lamports. */
export async function approvalDeposit(connection: Connection): Promise<bigint> {
  // Token-2022 account for a transfer-hook mint (base 165 + type byte + ImmutableOwner and
  // TransferHookAccount extensions), holder, holder group, approval record (IDL field sizes).
  const sizes = [175, 8 + 57, 8 + 48, 8 + 41];
  const rents = await Promise.all(sizes.map((s) => connection.getMinimumBalanceForRentExemption(s)));
  return rents.reduce((a, b) => a + BigInt(b), 0n);
}

/** Which of `wallets` already have an approval record for this security, in any group. */
export async function alreadyApproved(connection: Connection, launch: LaunchAccount, wallets: PublicKey[]): Promise<boolean[]> {
  const keys = wallets.map((w) => pda([text("saa"), getAssociatedTokenAddressSync(launch.realRwaMint, w, false, TOKEN_2022_PROGRAM_ID).toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID));
  const out: boolean[] = [];
  for (let i = 0; i < keys.length; i += 99) out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 99), "confirmed")).map((a) => a !== null));
  return out;
}

// ------------------------------------------------------------------------------------------------
// Reading the register
// ------------------------------------------------------------------------------------------------

export type RegisteredWallet = { owner: PublicKey; security: bigint; frozen: boolean };

const SAA = [68, 169, 137, 56, 226, 21, 69, 124];

/**
 * Approved wallets. Approval records don't name their wallet, but every approval creates the
 * wallet's security token account, so the register is: every holder of a security token account
 * whose approval record puts it in the investor group. Program accounts (the escrow) are left out.
 */
export async function loadRegister(connection: Connection, launch: LaunchAccount): Promise<RegisteredWallet[]> {
  const accounts = await largestTokenAccounts(connection, launch.realRwaMint);
  const people: { address: PublicKey; owner: PublicKey; amount: bigint; frozen: boolean }[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const a = unpackAccount(pubkey, { ...account, data: Buffer.from(account.data) }, TOKEN_2022_PROGRAM_ID);
      if (a.mint.equals(launch.realRwaMint) && PublicKey.isOnCurve(a.owner.toBytes())) people.push({ address: pubkey, owner: a.owner, amount: a.amount, frozen: a.isFrozen });
    } catch {
      // not a token account of this mint
    }
  }
  const saas: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>> = [];
  const keys = people.map((p) => pda([text("saa"), p.address.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID));
  for (let i = 0; i < keys.length; i += 99) saas.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 99), "confirmed")));
  return people
    .filter((_, i) => {
      const info = saas[i];
      if (!info || !info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) || info.data.length < 16 || !SAA.every((b, j) => info.data[j] === b)) return false;
      return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(8, true) === launch.investorGroup;
    })
    .map((p) => ({ owner: p.owner, security: p.amount, frozen: p.frozen }))
    .sort((a, b) => (b.security > a.security ? 1 : b.security < a.security ? -1 : 0));
}
