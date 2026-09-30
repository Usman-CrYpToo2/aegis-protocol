/**
 * A real redeem and deposit on a local node, with the approved buyer from
 * scripts/localnet-launch.ts (a graduated launch). Skipped unless AEGIS_LOCALNET=1.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadBridgeStatus, prepareBridge } from "./bridge";
import { loadRegistry } from "./registry";

describe.runIf(process.env.AEGIS_LOCALNET === "1")("bridge against a live node", () => {
  it("redeems and deposits exactly, and reports a stranger as not approved", async () => {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
    const buyer = Keypair.fromSecretKey(Uint8Array.from(actors.buyer));
    const graduated = (await loadRegistry(connection)).entries.find((e) => e.launch.stage === "Graduated");
    expect(graduated, "seed a graduated launch (the default yarn localnet:launch)").toBeDefined();
    const launch = graduated!.launch;
    const unit = 10n ** BigInt(launch.decimals);

    const stranger = await loadBridgeStatus(connection, launch, Keypair.generate().publicKey);
    expect(stranger.redeem).toEqual({ kind: "not-approved" });
    expect(stranger.deposit).toEqual({ kind: "not-approved" });

    const before = await loadBridgeStatus(connection, launch, buyer.publicKey);
    expect(before.redeem).toBeNull();
    expect(before.deposit).toBeNull();
    expect(before.wrapper).toBeGreaterThan(10n * unit);

    const send = async (direction: "redeem" | "deposit", amount: bigint) => {
      const p = await prepareBridge(connection, direction, launch, buyer.publicKey, amount);
      p.transaction.sign([buyer]);
      const sig = await connection.sendTransaction(p.transaction);
      const r = await connection.confirmTransaction({ signature: sig, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
      expect(r.value.err).toBeNull();
    };

    await send("redeem", 10n * unit);
    const mid = await loadBridgeStatus(connection, launch, buyer.publicKey);
    expect(before.wrapper - mid.wrapper).toBe(10n * unit);
    expect(mid.security - before.security).toBe(10n * unit);
    expect(before.escrowed - mid.escrowed).toBe(10n * unit);

    await send("deposit", 5n * unit);
    const after = await loadBridgeStatus(connection, launch, buyer.publicKey);
    expect(after.wrapper - mid.wrapper).toBe(5n * unit);
    expect(mid.security - after.security).toBe(5n * unit);
    expect(after.escrowed - mid.escrowed).toBe(5n * unit);
  }, 60_000);
});
