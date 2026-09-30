import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import tr from "../idl/transfer_restrictions.json";
import type { LaunchAccount } from "./aegis";
import { ACCESS_CONTROL_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";
import { approvalChunks, approveInstructions, registerAddresses } from "./investors";

const key = () => Keypair.generate().publicKey;
const launch = { address: key(), realRwaMint: key(), crwaMint: key(), escrowVault: key(), issuer: key(), vaultGroup: 2n, investorGroup: 1n } as LaunchAccount;
const issuer = launch.issuer;
const wallet = key();
const u64 = (v: number) => Buffer.from(new BigUint64Array([BigInt(v)]).buffer);
const seed = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();

describe("approving an investor", () => {
  it("derives every address the same way the test scripts do (tests/upside.ts)", () => {
    const a = registerAddresses(launch, issuer, wallet, 7n);
    const trd = seed([Buffer.from("trd"), launch.realRwaMint.toBuffer()], TRANSFER_RESTRICTIONS_PROGRAM_ID);
    const holder = seed([Buffer.from("trh"), new PublicKey(trd).toBuffer(), u64(7)], TRANSFER_RESTRICTIONS_PROGRAM_ID);
    const ata = getAssociatedTokenAddressSync(launch.realRwaMint, wallet, true, TOKEN_2022_PROGRAM_ID);
    expect(a.trd.toBase58()).toBe(trd);
    expect(a.holder.toBase58()).toBe(holder);
    expect(a.group.toBase58()).toBe(seed([Buffer.from("trg"), new PublicKey(trd).toBuffer(), u64(1)], TRANSFER_RESTRICTIONS_PROGRAM_ID));
    expect(a.holderGroup.toBase58()).toBe(seed([Buffer.from("trhg"), new PublicKey(holder).toBuffer(), u64(1)], TRANSFER_RESTRICTIONS_PROGRAM_ID));
    expect(a.saa.toBase58()).toBe(seed([Buffer.from("saa"), ata.toBuffer()], TRANSFER_RESTRICTIONS_PROGRAM_ID));
    expect(a.authorityRole.toBase58()).toBe(seed([Buffer.from("wallet_role"), launch.realRwaMint.toBuffer(), issuer.toBuffer()], ACCESS_CONTROL_PROGRAM_ID));
  });

  it("lists every account in the IDL's order, with the IDL's flags and arguments", () => {
    const a = registerAddresses(launch, issuer, wallet, 7n);
    const byName: Record<string, PublicKey> = {
      transfer_restriction_holder: a.holder, transfer_restriction_data: a.trd, access_control_account: a.accessControl, authority_wallet_role: a.authorityRole,
      authority: issuer, payer: issuer, system_program: SystemProgram.programId, holder_group: a.holderGroup, group: a.group, holder: a.holder,
      security_associated_account: a.saa, security_token: launch.realRwaMint, user_wallet: wallet, associated_token_account: a.tokenAccount,
    };
    const [ata, ...ixs] = approveInstructions(launch, issuer, wallet, 7n);
    expect(ata!.programId.toBase58()).not.toBe(TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58());
    const names = ["initialize_transfer_restriction_holder", "initialize_holder_group", "initialize_security_associated_account"];
    const args = [[...u64(7)], [], [...u64(1), ...u64(7)]];
    names.forEach((name, n) => {
      const spec = tr.instructions.find((i) => i.name === name)!;
      const ix = ixs[n]!;
      expect(ix.keys, name).toHaveLength(spec.accounts.length);
      spec.accounts.forEach((acc, i) => {
        expect(ix.keys[i]!.pubkey.toBase58(), `${name}.${acc.name}`).toBe(byName[acc.name]!.toBase58());
        expect(ix.keys[i]!.isWritable, `${name}.${acc.name} writable`).toBe(Boolean("writable" in acc && acc.writable));
        expect(ix.keys[i]!.isSigner, `${name}.${acc.name} signer`).toBe(Boolean("signer" in acc && acc.signer));
      });
      expect([...ix.data], name).toEqual([...spec.discriminator, ...args[n]!]);
    });
  });

  it("packs several approvals into each transaction, and every chunk fits", () => {
    const wallets = Array.from({ length: 9 }, key);
    const chunks = approvalChunks(launch, issuer, wallets);
    expect(chunks.flat().map(String)).toEqual(wallets.map(String));
    expect(chunks.length).toBeLessThan(wallets.length);
  });
});
