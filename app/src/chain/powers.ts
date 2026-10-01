/**
 * The issuer's legal powers over its security, held through Upside: pause every transfer, freeze
 * one holder, and remove a wallet from the register. Built from the Upside IDLs.
 *
 * Moving or burning tokens (force transfer, burn) is deliberately absent: those powers exist for
 * court orders, and Aegis gives them no button. If they are ever used, the backing check shows it.
 */
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";
import acIdl from "../idl/access_control.json";
import trIdl from "../idl/transfer_restrictions.json";
import { borsh, idlInstruction } from "./idlix";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";
import { issueAddresses } from "./issue";

const text = (s: string) => new TextEncoder().encode(s);
const pda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, TRANSFER_RESTRICTIONS_PROGRAM_ID)[0];
const SAA = [68, 169, 137, 56, 226, 21, 69, 124];
const TRD_PAUSED = 96;

export function pauseInstruction(mint: PublicKey, issuer: PublicKey, paused: boolean): TransactionInstruction {
  const a = issueAddresses(mint, issuer);
  return idlInstruction(trIdl, "pause", {
    security_mint: mint, transfer_restriction_data: a.trd, access_control_account: a.accessControl, authority_wallet_role: a.issuerRole, payer: issuer,
  }, borsh.u8(paused ? 1 : 0));
}

/** Freezes (or thaws) one holder's security account. Upside refuses this on the escrow. */
export function freezeInstruction(mint: PublicKey, issuer: PublicKey, wallet: PublicKey, freeze: boolean): TransactionInstruction {
  const a = issueAddresses(mint, issuer);
  return idlInstruction(acIdl, freeze ? "freeze_wallet" : "thaw_wallet", {
    authority: issuer, authority_wallet_role: a.issuerRole, access_control: a.accessControl, security_mint: mint,
    target_account: getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID), target_authority: wallet, token_program: TOKEN_2022_PROGRAM_ID,
  });
}

/**
 * Takes a wallet off the register: it can no longer receive the security. What it already holds
 * stays with it (freeze it to stop that moving). The approval record names its holder and group,
 * so everything is derived from it.
 */
export async function removeInstruction(connection: Connection, mint: PublicKey, issuer: PublicKey, wallet: PublicKey): Promise<TransactionInstruction> {
  const a = issueAddresses(mint, issuer);
  const tokenAccount = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID);
  const saa = pda([text("saa"), tokenAccount.toBytes()]);
  const info = await connection.getAccountInfo(saa, "confirmed");
  if (!info || !info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) || info.data.length < 49 || !SAA.every((b, i) => info.data[i] === b)) throw new Error("This wallet isn’t on the register.");
  const group = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(8, true);
  if (info.data[16] !== 1) throw new Error("This approval record names no holder.");
  const holder = new PublicKey(info.data.subarray(17, 49));
  const holderGroup = PublicKey.findProgramAddressSync([text("trhg"), holder.toBytes(), borsh.u64(group)], TRANSFER_RESTRICTIONS_PROGRAM_ID)[0];
  return idlInstruction(trIdl, "revoke_security_associated_account", {
    security_associated_account: saa, group: a.group(group), holder, holder_group: holderGroup, security_token: mint, transfer_restriction_data: a.trd,
    user_wallet: wallet, associated_token_account: tokenAccount, authority_wallet_role: a.issuerRole, authority: issuer, payer: issuer, system_program: SystemProgram.programId,
  });
}

/** Whether the issuer has paused every transfer of the security. */
export async function loadPaused(connection: Connection, mint: PublicKey): Promise<boolean | null> {
  const info = await connection.getAccountInfo(pda([text("trd"), mint.toBytes()]), "confirmed");
  if (!info || !info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) || info.data.length <= TRD_PAUSED) return null;
  return info.data[TRD_PAUSED] === 1;
}
