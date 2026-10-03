import { createHash } from "node:crypto";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "../idl/aegis_faucet.json";
import { dripInstructions, FAUCET_PROGRAM_ID, faucetAuthority, faucetKind } from "./faucet";

const key = () => Keypair.generate().publicKey;

describe("faucet", () => {
  it("builds drip exactly as the faucet's IDL describes it", () => {
    const mint = key(), owner = key();
    const [create, drip] = dripInstructions(mint, owner, 1_000_000_000n, TOKEN_PROGRAM_ID);
    expect(create!.programId.equals(TOKEN_PROGRAM_ID)).toBe(false); // the associated token program
    const d = Buffer.from(drip!.data);
    expect([...d.subarray(0, 8)]).toEqual([...createHash("sha256").update("global:drip").digest().subarray(0, 8)]);
    expect(d.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(drip!.programId.equals(FAUCET_PROGRAM_ID)).toBe(true);
    const spec = idl.instructions.find((i) => i.name === "drip")!.accounts.map((a) => a.name);
    expect(spec).toEqual(["mint", "faucet_authority", "destination", "token_program"]);
    expect(drip!.keys.map((k) => k.pubkey.toBase58())).toEqual([mint, faucetAuthority(), getAssociatedTokenAddressSync(mint, owner), TOKEN_PROGRAM_ID].map((k) => k.toBase58()));
    expect(drip!.keys.map((k) => k.isWritable)).toEqual([true, false, true, false]);
  });

  it("knows which tokens it can mint", () => {
    expect(faucetKind(key(), faucetAuthority())).toBe("mint");
    expect(faucetKind(key(), key())).toBe("none");
    expect(faucetKind(key(), null)).toBe("none");
    expect(faucetKind(NATIVE_MINT, null)).toBe("sol");
  });

  it("derives the authority the devnet test USDC was handed to", () => {
    expect(faucetAuthority().equals(new PublicKey("4a7bDpK4oAgE4SKvASnTvDwq5APfB9o38EkSgkSiNQBK"))).toBe(true);
  });
});
