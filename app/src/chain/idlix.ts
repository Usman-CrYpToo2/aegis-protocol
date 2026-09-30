/**
 * Builds an instruction straight from an Anchor IDL: the account order and every writable/signer
 * flag come from the IDL, so they cannot drift from the program. A missing account throws.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

type IdlAccount = { name: string; writable?: boolean; signer?: boolean };
type Idl = { address: string; instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[] };

export function idlInstruction(idl: Idl, name: string, accounts: Record<string, PublicKey>, args: Uint8Array = new Uint8Array()): TransactionInstruction {
  const spec = idl.instructions.find((i) => i.name === name);
  if (!spec) throw new Error(`${name} is not in the IDL`);
  return new TransactionInstruction({
    programId: new PublicKey(idl.address),
    data: Buffer.from([...spec.discriminator, ...args]),
    keys: spec.accounts.map((a) => {
      const pubkey = accounts[a.name];
      if (!pubkey) throw new Error(`${name}: missing account ${a.name}`);
      return { pubkey, isWritable: Boolean(a.writable), isSigner: Boolean(a.signer) };
    }),
  });
}

/** Borsh, just the types these instructions take. */
export const borsh = {
  u8: (v: number) => Uint8Array.of(v),
  u16: (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; },
  u32: (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; },
  u64: (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; },
  u128: (v: bigint) => { const b = new Uint8Array(16); const d = new DataView(b.buffer); d.setBigUint64(0, v & 0xffffffffffffffffn, true); d.setBigUint64(8, v >> 64n, true); return b; },
  string: (s: string) => { const bytes = new TextEncoder().encode(s); return Uint8Array.from([...borsh.u32(bytes.length), ...bytes]); },
  concat: (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p])),
};
