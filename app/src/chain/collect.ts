/**
 * The issuer collecting its money:
 *  - its share of the raise, from Meteora DBC `withdraw_migration_fee` with the creator flag
 *    (ix_withdraw_migration_fee.rs), which only the pool's creator can call;
 *  - its unsold stock, from Aegis `claim_unsold`, in the IDL's account order.
 * collect.test.ts checks both against their sources.
 */
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import idl from "../idl/aegis.json";
import type { LaunchAccount } from "./aegis";
import { bridgeAddresses } from "./bridge";
import { AEGIS_PROGRAM_ID, METEORA_DBC_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";
import { eventAuthority, poolAuthority, tokenVault } from "./trade";
import { unwrapInstruction } from "./wsol";

/** sha256("global:withdraw_migration_fee")[..8]; collect.test.ts recomputes it. */
export const WITHDRAW_MIGRATION_FEE = Uint8Array.from([237, 142, 45, 23, 129, 6, 222, 162]);
/** DBC SenderFlag::Creator. */
const CREATOR = 1;

/** `unwrapSol`: the raise is in wrapped SOL and the issuer had no wrapped SOL account; close it after. */
export function collectRaiseInstructions(launch: LaunchAccount, issuer: PublicKey, quoteProgram: PublicKey, unwrapSol = false): TransactionInstruction[] {
  const destination = getAssociatedTokenAddressSync(launch.quoteMint, issuer, false, quoteProgram);
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return [
    createAssociatedTokenAccountIdempotentInstruction(issuer, destination, issuer, launch.quoteMint, quoteProgram),
    new TransactionInstruction({
      programId: METEORA_DBC_PROGRAM_ID,
      data: Buffer.from([...WITHDRAW_MIGRATION_FEE, CREATOR]),
      keys: [
        r(poolAuthority()),
        r(launch.meteoraConfig),
        w(launch.virtualPool),
        w(destination),
        w(tokenVault(launch.quoteMint, launch.virtualPool)),
        r(launch.quoteMint),
        { pubkey: issuer, isSigner: true, isWritable: false },
        r(quoteProgram),
        // #[event_cpi]
        r(eventAuthority()),
        r(METEORA_DBC_PROGRAM_ID),
      ],
    }),
    ...(unwrapSol ? [unwrapInstruction(issuer)] : []),
  ];
}

const CLAIM_UNSOLD = Uint8Array.from(idl.instructions.find((i) => i.name === "claim_unsold")!.discriminator);

export function claimUnsoldInstruction(launch: LaunchAccount, issuer: PublicKey): TransactionInstruction {
  const a = bridgeAddresses(launch, issuer); // the issuer's own security account and approval record
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: AEGIS_PROGRAM_ID,
    data: Buffer.from(CLAIM_UNSOLD),
    keys: [
      { pubkey: issuer, isSigner: true, isWritable: false },
      w(launch.address),
      r(launch.realRwaMint),
      r(launch.crwaMint),
      r(a.authority),
      w(launch.escrowVault),
      w(a.userReal),
      r(a.accessControl),
      r(a.trd),
      r(a.vaultSaa),
      r(a.userSaa),
      r(a.redeemRule),
      r(a.extraMetas),
      r(TRANSFER_RESTRICTIONS_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
    ],
  });
}
