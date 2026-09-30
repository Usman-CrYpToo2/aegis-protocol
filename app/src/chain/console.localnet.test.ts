/**
 * The console for the local test issuer: a graduated launch whose raise is ready to collect and a
 * live one whose buyer is waiting for approval. Skipped unless AEGIS_LOCALNET=1.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { attentionItems, loadConsole } from "./console";
import { loadRegistry } from "./registry";

describe.runIf(process.env.AEGIS_LOCALNET === "1")("console against a live node", () => {
  it("reads payouts, unsold stock and waiting holders for the issuer", async () => {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
    const issuer = Keypair.fromSecretKey(Uint8Array.from(actors.issuer)).publicKey;
    const buyer = Keypair.fromSecretKey(Uint8Array.from(actors.buyer)).publicKey;
    const launches = await loadConsole(connection, await loadRegistry(connection), issuer);

    const graduated = launches.find((l) => l.entry.launch.stage === "Graduated")!;
    const live = launches.find((l) => l.entry.launch.stage === "Live")!;
    expect(graduated, "seed a graduated launch").toBeDefined();
    expect(live, "seed a live launch").toBeDefined();

    // 50% migration fee on a 10,000 USDC raise, all of it the issuer's.
    expect(graduated.payout).toEqual({ amount: 5_000_000_000n, status: "ready" });
    expect(live.payout).toEqual({ amount: 5_000_000_000n, status: "at-graduation" });

    // The launch script registers the issuer and collects the unsold stock, so none is owed.
    expect(graduated.issuerApproved).toBe(true);
    expect(graduated.unsold).toBe(0n);

    // The buyer holds wrapper on the live launch without approval there; on the graduated one it
    // was approved, so it is not waiting.
    expect(live.waiting.map((w) => w.owner.toBase58())).toContain(buyer.toBase58());
    expect(graduated.waiting.map((w) => w.owner.toBase58())).not.toContain(buyer.toBase58());
    // Pools, vaults and the escrow are programs, never listed as people waiting.
    for (const l of launches) for (const w of l.waiting) expect(w.wrapper).toBeGreaterThan(0n);

    const kinds = attentionItems(launches).map((a) => a.kind);
    expect(kinds).toContain("raise-ready");
    expect(kinds).toContain("waiting");

    // A wallet that issued nothing has no launches.
    expect(await loadConsole(connection, await loadRegistry(connection), buyer)).toEqual([]);
  }, 60_000);
});
