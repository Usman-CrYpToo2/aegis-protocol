import { Keypair, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "../idl/aegis.json";
import type { LaunchAccount } from "./aegis";
import { bridgeAddresses, bridgeInstruction } from "./bridge";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";

const key = () => Keypair.generate().publicKey;
const launch = {
  address: key(), realRwaMint: key(), crwaMint: key(), escrowVault: key(), vaultGroup: 2n, investorGroup: 1n,
} as LaunchAccount;
const user = key();

describe("bridge instructions", () => {
  for (const [direction, name] of [["redeem", "bridge_redeem"], ["deposit", "bridge_deposit"]] as const) {
    it(`${name} lists every account in the IDL's order, with the IDL's flags`, () => {
      const a = bridgeAddresses(launch, user);
      const expected: Record<string, string> = {
        user: user.toBase58(), launch: a.launch.toBase58(), real_rwa_mint: launch.realRwaMint.toBase58(), crwa_mint: launch.crwaMint.toBase58(),
        aegis_authority: a.authority.toBase58(), escrow_vault: a.escrowVault.toBase58(), user_real_rwa_account: a.userReal.toBase58(),
        user_crwa_account: a.userCrwa.toBase58(), access_control: a.accessControl.toBase58(), transfer_restriction_data: a.trd.toBase58(),
        user_saa: a.userSaa.toBase58(), vault_saa: a.vaultSaa.toBase58(), redeem_rule: a.redeemRule.toBase58(), deposit_rule: a.depositRule.toBase58(),
        real_rwa_extra_metas: a.extraMetas.toBase58(), transfer_restrictions_program: TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58(),
        token_program: TOKEN_2022_PROGRAM_ID.toBase58(), associated_token_program: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        system_program: SystemProgram.programId.toBase58(),
      };
      const spec = idl.instructions.find((i) => i.name === name)!;
      const ix = bridgeInstruction(direction, launch, user, 1_000n);
      expect(ix.keys).toHaveLength(spec.accounts.length);
      spec.accounts.forEach((acc, i) => {
        const k = ix.keys[i]!;
        expect(k.pubkey.toBase58(), acc.name).toBe(expected[acc.name]);
        if ("address" in acc && acc.address) expect(k.pubkey.toBase58(), acc.name).toBe(acc.address);
        expect(k.isWritable, `${acc.name} writable`).toBe(Boolean("writable" in acc && acc.writable));
        expect(k.isSigner, `${acc.name} signer`).toBe(Boolean("signer" in acc && acc.signer));
      });
      expect([...ix.data.subarray(0, 8)]).toEqual(spec.discriminator);
      expect(Buffer.from(ix.data).readBigUInt64LE(8)).toBe(1_000n);
    });
  }
});
