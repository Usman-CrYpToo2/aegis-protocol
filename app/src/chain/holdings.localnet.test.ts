/**
 * Holdings and activity for the local test buyer, who bought on a live launch and, on a graduated
 * one, was approved and used the bridge (scripts/localnet-launch.ts). Skipped unless AEGIS_LOCALNET=1.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadActivity } from "./activity";
import { loadHoldings } from "./holdings";
import { loadRegistry } from "./registry";

describe.runIf(process.env.AEGIS_LOCALNET === "1")("holdings against a live node", () => {
  it("lists what the buyer holds, prices it, and rebuilds its activity", async () => {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
    const buyer = Keypair.fromSecretKey(Uint8Array.from(actors.buyer)).publicKey;
    const registry = await loadRegistry(connection);
    const held = await loadHoldings(connection, registry, buyer);

    const graduated = held.find((h) => h.entry.launch.stage === "Graduated");
    const live = held.find((h) => h.entry.launch.stage === "Live");
    expect(graduated, "seed a graduated launch").toBeDefined();
    expect(live, "seed a live launch").toBeDefined();

    // Graduated: approved, holds both tokens, priced from the live pool (the sale ended at 1.21).
    expect(graduated!.approved).toBe(true);
    expect(graduated!.security).toBeGreaterThan(0n);
    expect(graduated!.wrapper).toBeGreaterThan(0n);
    expect(graduated!.priceSource).toBe("pool");
    expect(graduated!.price!).toBeGreaterThan(1_200_000n);
    expect(graduated!.price!).toBeLessThan(1_220_000n);
    expect(graduated!.pool).not.toBeNull();

    // Live: bought on the curve, never approved there, priced on the curve.
    expect(live!.approved).toBe(false);
    expect(live!.wrapper).toBeGreaterThan(0n);
    expect(live!.priceSource).toBe("curve");
    expect(live!.value).toBe((live!.wrapper * live!.price!) / 1_000_000n);

    // A wallet that holds nothing gets an empty list, not an error.
    expect(await loadHoldings(connection, registry, Keypair.generate().publicKey)).toEqual([]);

    const activity = await loadActivity(connection, buyer, held);
    const kinds = new Set(activity.map((a) => a.kind));
    for (const k of ["bought", "redeemed", "deposited", "approved"] as const) expect(kinds.has(k), k).toBe(true);
    const redeem = activity.find((a) => a.kind === "redeemed")!;
    expect(redeem.token).toBe("security");
    expect(redeem.amount!).toBeGreaterThan(0n);
  }, 60_000);
});
