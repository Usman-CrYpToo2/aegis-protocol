/**
 * A real buy and a real sell on a local node, built by the app's own code and signed by the
 * throwaway buyer in .localnet/actors.json. Asserts that what arrives equals the preview exactly.
 * Skipped unless AEGIS_LOCALNET=1 (see registry.localnet.test.ts for seeding).
 */
import { readFileSync } from "node:fs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { quoteBuy, quoteSell, withSlippage, type CurveState } from "../lib/swap";
import { loadAsset } from "./asset";
import { TOKEN_2022_PROGRAM_ID } from "./ids";
import { loadRegistry } from "./registry";
import { loadTradeAccounts, prepareTrade } from "./trade";

const RPC = "http://127.0.0.1:8899";
const USDC = 1_000_000n;

describe.runIf(process.env.AEGIS_LOCALNET === "1")("trading against a live node", () => {
  it("buys and sells exactly what the preview says", async () => {
    const connection = new Connection(RPC, "confirmed");
    const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
    const buyer = Keypair.fromSecretKey(Uint8Array.from(actors.buyer));

    const live = (await loadRegistry(connection)).entries.find((e) => e.launch.stage === "Live");
    expect(live, "seed a launch with AEGIS_STOP_AT=live").toBeDefined();
    const mint = live!.launch.realRwaMint;

    const balance = async (account: PublicKey) => {
      const info = await connection.getTokenAccountBalance(account).catch(() => null);
      return info ? BigInt(info.value.amount) : 0n;
    };
    const send = async (side: "buy" | "sell", amountIn: bigint, minimumOut: bigint) => {
      const asset = await loadAsset(connection, mint);
      const accounts = await loadTradeAccounts(connection, asset.launch);
      const prepared = await prepareTrade(connection, { launch: asset.launch, pool: asset.detail.pool!, accounts, owner: buyer.publicKey, side, amountIn, minimumOut });
      prepared.transaction.sign([buyer]);
      const sig = await connection.sendTransaction(prepared.transaction);
      const result = await connection.confirmTransaction({ signature: sig, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, "confirmed");
      expect(result.value.err).toBeNull();
      return accounts;
    };
    const state = async (): Promise<CurveState> => {
      const a = await loadAsset(connection, mint);
      const t = a.detail.terms!;
      return { sqrtPrice: a.detail.pool!.sqrtPrice, sqrtStartPrice: t.sqrtStartPrice, migrationSqrtPrice: t.migrationSqrtPrice, curve: t.curve, feeNumerator: t.curveFeeNumerator };
    };

    // --- buy 250 USDC ---
    const buy = quoteBuy(await state(), 250n * USDC)!;
    const accounts = await loadTradeAccounts(connection, live!.launch);
    const userQuote = getAssociatedTokenAddressSync(live!.launch.quoteMint, buyer.publicKey, false, accounts.quoteProgram);
    const userBase = getAssociatedTokenAddressSync(live!.launch.crwaMint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const [q0, b0] = [await balance(userQuote), await balance(userBase)];
    await send("buy", 250n * USDC, withSlippage(buy.out, 100));
    const [q1, b1] = [await balance(userQuote), await balance(userBase)];
    expect(q0 - q1).toBe(buy.spend);
    expect(b1 - b0).toBe(buy.out);

    // --- sell what was just bought ---
    const sell = quoteSell(await state(), buy.out)!;
    await send("sell", buy.out, withSlippage(sell.out, 100));
    const [q2, b2] = [await balance(userQuote), await balance(userBase)];
    expect(b1 - b2).toBe(buy.out);
    expect(q2 - q1).toBe(sell.out);
    expect(sell.out).toBeLessThan(buy.spend); // fees, both ways
  }, 60_000);
});
