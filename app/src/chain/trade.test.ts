import { createHash } from "node:crypto";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
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

describe("trading against wrapped SOL", () => {
  const solLaunch = { crwaMint: key(), quoteMint: NATIVE_MINT, virtualPool: key(), meteoraConfig: key() } as LaunchAccount;
  const accounts = { quoteProgram: TOKEN_PROGRAM_ID, hookProgram: key(), extraAccountMetaList: key() };
  const pool = { baseVault: tokenVault(solLaunch.crwaMint, solLaunch.virtualPool), quoteVault: tokenVault(NATIVE_MINT, solLaunch.virtualPool) } as DbcPool;
  const owner = key();
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  const names = (ixs: { programId: PublicKey; data: Buffer }[]) =>
    ixs.map((ix) => (ix.programId.equals(SystemProgram.programId) ? "transfer" : ix.programId.equals(TOKEN_PROGRAM_ID) ? ({ 17: "sync", 9: "close" } as Record<number, string>)[ix.data[0]!] ?? "token" : ix.programId.equals(METEORA_DBC_PROGRAM_ID) ? "swap" : "create"));

  it("wraps the shortfall into the wallet's own wrapped SOL account before the swap, and closes it after", () => {
    const ixs = tradeInstructions({ launch: solLaunch, pool, accounts, owner, side: "buy", amountIn: 2_000_000_000n, minimumOut: 0n, sol: { wrap: 1_500_000_000n, unwrap: true } });
    expect(names(ixs)).toEqual(["create", "transfer", "sync", "create", "swap", "close"]);
    expect(ixs[1]!.keys[1]!.pubkey.equals(wsol)).toBe(true);
    expect(Buffer.from(ixs[1]!.data).readBigUInt64LE(4)).toBe(1_500_000_000n);
    // The swap pays from that same account, and the close sends everything back to the wallet.
    expect(ixs[4]!.keys[3]!.pubkey.equals(wsol)).toBe(true);
    expect(ixs[5]!.keys[0]!.pubkey.equals(wsol) && ixs[5]!.keys[1]!.pubkey.equals(owner)).toBe(true);
  });

  it("leaves an account the wallet already had untouched, and wraps nothing it does not need", () => {
    const ixs = tradeInstructions({ launch: solLaunch, pool, accounts, owner, side: "buy", amountIn: 1n, minimumOut: 0n, sol: { wrap: 0n, unwrap: false } });
    expect(names(ixs)).toEqual(["create", "swap"]);
  });

  it("unwraps a sale's proceeds when the account was opened for it", () => {
    const ixs = tradeInstructions({ launch: solLaunch, pool, accounts, owner, side: "sell", amountIn: 1n, minimumOut: 0n, sol: { wrap: 5n, unwrap: true } });
    expect(names(ixs)).toEqual(["create", "swap", "close"]);
  });

  it("ignores the SOL plan for any other currency", () => {
    const usdc = { ...solLaunch, quoteMint: key() } as LaunchAccount;
    const usdcPool = { baseVault: tokenVault(usdc.crwaMint, usdc.virtualPool), quoteVault: tokenVault(usdc.quoteMint, usdc.virtualPool) } as DbcPool;
    const ixs = tradeInstructions({ launch: usdc, pool: usdcPool, accounts, owner, side: "buy", amountIn: 1n, minimumOut: 0n, sol: { wrap: 1n, unwrap: true } });
    expect(names(ixs)).toEqual(["create", "swap"]);
  });
});
