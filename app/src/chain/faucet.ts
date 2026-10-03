/**
 * The devnet faucet: mints test tokens to anyone who asks, for any mint whose mint authority was
 * handed to the faucet's PDA. Not part of the protocol; the Aegis program never calls it.
 * faucet.test.ts checks the instruction against the faucet's IDL.
 */
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import idl from "../idl/aegis_faucet.json";

export const FAUCET_PROGRAM_ID = new PublicKey(idl.address);
const DRIP = Uint8Array.from(idl.instructions.find((i) => i.name === "drip")!.discriminator);

/** Most whole tokens one claim may mint; the program refuses more. */
export const MAX_WHOLE_PER_CLAIM = 10_000n;

export const faucetAuthority = () => PublicKey.findProgramAddressSync([new TextEncoder().encode("faucet")], FAUCET_PROGRAM_ID)[0];

/** What the faucet page can do for a token. */
export type FaucetKind = "mint" | "sol" | "none";

export function faucetKind(mint: PublicKey, mintAuthority: PublicKey | null): FaucetKind {
  if (mint.equals(NATIVE_MINT)) return "sol";
  return mintAuthority?.equals(faucetAuthority()) ? "mint" : "none";
}

/**
 * Creates `owner`'s token account if needed, then mints `atoms` into it. `payer` signs and pays the
 * fee and the account's deposit; it is the owner unless tokens are being sent to another wallet.
 */
export function dripInstructions(mint: PublicKey, owner: PublicKey, atoms: bigint, tokenProgram: PublicKey, payer: PublicKey = owner): TransactionInstruction[] {
  const destination = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const data = new Uint8Array(16);
  data.set(DRIP, 0);
  new DataView(data.buffer).setBigUint64(8, atoms, true);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, destination, owner, mint, tokenProgram),
    new TransactionInstruction({
      programId: FAUCET_PROGRAM_ID,
      data: Buffer.from(data),
      keys: [
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: faucetAuthority(), isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
    }),
  ];
}
