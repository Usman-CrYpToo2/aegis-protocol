/**
 * The issuer's legal powers on a local node, and what each one does to a holder's bridge.
 * Needs a graduated launch (the default yarn localnet:launch). Skipped unless AEGIS_LOCALNET=1.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadBridgeStatus } from "./bridge";
import { alreadyApproved, approvalBatch, loadRegister } from "./investors";
import { freezeInstruction, loadPaused, pauseInstruction, removeInstruction } from "./powers";
import { loadRegistry } from "./registry";
import { prepareTransaction } from "./tx";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");

describe.runIf(process.env.AEGIS_LOCALNET === "1")("legal powers against a live node", () => {
  it("pauses, freezes and removes, and holders see each one", async () => {
    const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
    const issuer = Keypair.fromSecretKey(Uint8Array.from(actors.issuer));
    const buyer = Keypair.fromSecretKey(Uint8Array.from(actors.buyer));
    const entry = (await loadRegistry(connection)).entries.find((e) => e.launch.stage === "Graduated" && e.launch.issuer.equals(issuer.publicKey));
    expect(entry, "seed a graduated launch").toBeDefined();
    const { launch } = entry!;
    const mint = launch.realRwaMint;
    const send = async (ixs: TransactionInstruction[]) => {
      const p = await prepareTransaction(connection, issuer.publicKey, ixs);
      p.transaction.sign([issuer]);
      const r = await connection.confirmTransaction({ signature: await connection.sendTransaction(p.transaction), blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
      expect(r.value.err).toBeNull();
    };

    // Pause: nobody can redeem; resume restores it.
    expect(await loadPaused(connection, mint)).toBe(false);
    await send([pauseInstruction(mint, issuer.publicKey, true)]);
    expect(await loadPaused(connection, mint)).toBe(true);
    expect((await loadBridgeStatus(connection, launch, buyer.publicKey)).redeem).toEqual({ kind: "paused" });
    await send([pauseInstruction(mint, issuer.publicKey, false)]);
    expect(await loadPaused(connection, mint)).toBe(false);
    expect((await loadBridgeStatus(connection, launch, buyer.publicKey)).redeem).toBeNull();

    // Freeze one holder: the register shows it, that holder alone is stopped; thaw restores it.
    await send([freezeInstruction(mint, issuer.publicKey, buyer.publicKey, true)]);
    expect((await loadRegister(connection, launch)).find((w) => w.owner.equals(buyer.publicKey))?.frozen).toBe(true);
    expect((await loadBridgeStatus(connection, launch, buyer.publicKey)).redeem).toEqual({ kind: "frozen" });
    await send([freezeInstruction(mint, issuer.publicKey, buyer.publicKey, false)]);
    expect((await loadRegister(connection, launch)).find((w) => w.owner.equals(buyer.publicKey))?.frozen).toBe(false);

    // Remove a wallet from the register: it is no longer approved.
    const stranger = Keypair.generate().publicKey;
    await send(await approvalBatch(connection, launch, issuer.publicKey, [stranger]));
    expect(await alreadyApproved(connection, launch, [stranger])).toEqual([true]);
    await send([await removeInstruction(connection, mint, issuer.publicKey, stranger)]);
    expect(await alreadyApproved(connection, launch, [stranger])).toEqual([false]);
    expect((await loadBridgeStatus(connection, launch, stranger)).redeem).toEqual({ kind: "not-approved" });
  }, 90_000);
});
