import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { LaunchAccount } from "./aegis";
import { METEORA_DBC_PROGRAM_ID } from "./ids";
import type { DbcPool } from "./meteora";
import { SWAP2_WITH_TRANSFER_HOOK, tokenVault, tradeInstructions } from "./trade";

const key = () => Keypair.generate().publicKey;

describe("swap instruction", () => {
  it("uses Anchor's discriminator for swap2_with_transfer_hook", () => {
    const expected = createHash("sha256").update("global:swap2_with_transfer_hook").digest().subarray(0, 8);
    expect([...SWAP2_WITH_TRANSFER_HOOK]).toEqual([...expected]);
  });

  const launch = { crwaMint: key(), quoteMint: key(), virtualPool: key(), meteoraConfig: key() } as LaunchAccount;
  const accounts = { quoteProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), hookProgram: key(), extraAccountMetaList: key() };
  const pool = { baseVault: tokenVault(launch.crwaMint, launch.virtualPool), quoteVault: tokenVault(launch.quoteMint, launch.virtualPool) } as DbcPool;
  const owner = key();

  it("encodes amounts, mode and the hook slice, and ends with the hook accounts", () => {
    const [, swap] = tradeInstructions({ launch, pool, accounts, owner, side: "buy", amountIn: 500_000_000n, minimumOut: 430_000_000n });
    const d = Buffer.from(swap!.data);
    expect(d.readBigUInt64LE(8)).toBe(500_000_000n);
    expect(d.readBigUInt64LE(16)).toBe(430_000_000n);
    expect(d[24]).toBe(1); // PartialFill for buys
    expect(d.readUInt32LE(25)).toBe(1);
    expect([d[29], d[30]]).toEqual([0, 2]);
    expect(swap!.programId.equals(METEORA_DBC_PROGRAM_ID)).toBe(true);
    expect(swap!.keys).toHaveLength(17);
    expect(swap!.keys[9]!.pubkey.equals(owner) && swap!.keys[9]!.isSigner).toBe(true);
    expect(swap!.keys[15]!.pubkey.equals(accounts.hookProgram)).toBe(true);
    expect(swap!.keys[16]!.pubkey.equals(accounts.extraAccountMetaList)).toBe(true);
  });

  it("uses exact-in for sells, paying wrapper in and quote out", () => {
    const [, swap] = tradeInstructions({ launch, pool, accounts, owner, side: "sell", amountIn: 1n, minimumOut: 0n });
    expect(Buffer.from(swap!.data)[24]).toBe(0);
  });

  it("refuses a pool whose vaults are not Meteora's for this sale", () => {
    const bad = { ...pool, quoteVault: key() } as DbcPool;
    expect(() => tradeInstructions({ launch, pool: bad, accounts, owner, side: "buy", amountIn: 1n, minimumOut: 0n })).toThrow("Refusing to trade");
  });
});
