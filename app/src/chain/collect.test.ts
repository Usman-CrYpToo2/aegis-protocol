import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "../idl/aegis.json";
import type { LaunchAccount } from "./aegis";
import { bridgeAddresses } from "./bridge";
import { claimUnsoldInstruction, collectRaiseInstructions, WITHDRAW_MIGRATION_FEE } from "./collect";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";

const key = () => Keypair.generate().publicKey;
const launch = { address: key(), realRwaMint: key(), crwaMint: key(), escrowVault: key(), quoteMint: key(), virtualPool: key(), meteoraConfig: key(), vaultGroup: 2n, investorGroup: 1n } as LaunchAccount;
const issuer = key();

describe("collect instructions", () => {
  it("uses Anchor's discriminator for withdraw_migration_fee, with the creator flag", () => {
    expect([...WITHDRAW_MIGRATION_FEE]).toEqual([...createHash("sha256").update("global:withdraw_migration_fee").digest().subarray(0, 8)]);
    const [, ix] = collectRaiseInstructions(launch, issuer, new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    expect(ix!.data[8]).toBe(1);
    expect(ix!.keys).toHaveLength(10);
    expect(ix!.keys[6]!.pubkey.equals(issuer) && ix!.keys[6]!.isSigner).toBe(true);
  });

  it("matches the order DBC declares for WithdrawMigrationFeeCtx", () => {
    const src = readFileSync(`${process.env.HOME}/.cargo/git/checkouts/dynamic-bonding-curve-7f6f273ca8a21cb1/f552f20/programs/dynamic-bonding-curve/src/instructions/migration/ix_withdraw_migration_fee.rs`, "utf8");
    const struct = src.slice(src.indexOf("pub struct WithdrawMigrationFeeCtx"), src.indexOf("#[repr(u8)]"));
    const fields = [...struct.matchAll(/pub (\w+):/g)].map((m) => m[1]);
    expect(fields).toEqual(["pool_authority", "config", "virtual_pool", "token_quote_account", "quote_vault", "quote_mint", "sender", "token_quote_program"]);
  });

  it("claim_unsold lists every account in the IDL's order, with the IDL's flags", () => {
    const a = bridgeAddresses(launch, issuer);
    const expected: Record<string, string> = {
      issuer: issuer.toBase58(), launch: launch.address.toBase58(), real_rwa_mint: launch.realRwaMint.toBase58(), crwa_mint: launch.crwaMint.toBase58(),
      aegis_authority: a.authority.toBase58(), escrow_vault: launch.escrowVault.toBase58(), issuer_real_rwa_account: a.userReal.toBase58(),
      access_control: a.accessControl.toBase58(), transfer_restriction_data: a.trd.toBase58(), vault_saa: a.vaultSaa.toBase58(), issuer_saa: a.userSaa.toBase58(),
      redeem_rule: a.redeemRule.toBase58(), real_rwa_extra_metas: a.extraMetas.toBase58(),
      transfer_restrictions_program: TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58(), token_program: TOKEN_2022_PROGRAM_ID.toBase58(),
    };
    const spec = idl.instructions.find((i) => i.name === "claim_unsold")!;
    const ix = claimUnsoldInstruction(launch, issuer);
    expect(ix.keys).toHaveLength(spec.accounts.length);
    spec.accounts.forEach((acc, i) => {
      expect(ix.keys[i]!.pubkey.toBase58(), acc.name).toBe(expected[acc.name]);
      expect(ix.keys[i]!.isWritable, `${acc.name} writable`).toBe(Boolean("writable" in acc && acc.writable));
      expect(ix.keys[i]!.isSigner, `${acc.name} signer`).toBe(Boolean("signer" in acc && acc.signer));
    });
    expect([...ix.data]).toEqual(spec.discriminator);
  });
});
