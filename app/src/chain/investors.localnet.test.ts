/**
 * The issuer approving wallets on a local node with the app's own instructions, and a newly
 * approved holder then redeeming. Needs a graduated launch (the default yarn localnet:launch).
 * Skipped unless AEGIS_LOCALNET=1.
 */
import { readFileSync } from "node:fs";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { explainTradeError } from "../lib/txErrors";
import { loadBridgeStatus, prepareBridge } from "./bridge";
import { loadConsole } from "./console";
import { TOKEN_2022_PROGRAM_ID } from "./ids";
import { alreadyApproved, approvalBatch, approvalChunks, approvalDeposit, loadRegister } from "./investors";
import { loadRegistry } from "./registry";
import { prepareTransaction } from "./tx";

describe.runIf(process.env.AEGIS_LOCALNET === "1")("approving investors against a live node", () => {
  it("approves waiting holders two per signature, charges exactly the stated deposit, and lets them redeem", async () => {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
    const issuer = Keypair.fromSecretKey(Uint8Array.from(actors.issuer));
    const buyer = Keypair.fromSecretKey(Uint8Array.from(actors.buyer));
    const registry = await loadRegistry(connection);
    const entry = registry.entries.find((e) => e.launch.stage === "Graduated");
    expect(entry, "seed a graduated launch").toBeDefined();
    const { launch } = entry!;
    const unit = 10n ** BigInt(launch.decimals);

    const send = async (signer: Keypair, ixs: TransactionInstruction[]) => {
      const p = await prepareTransaction(connection, signer.publicKey, ixs);
      p.transaction.sign([signer]);
      const sig = await connection.sendTransaction(p.transaction);
      const r = await connection.confirmTransaction({ signature: sig, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
      expect(r.value.err).toBeNull();
      return sig;
    };

    // Three strangers receive the wrapper from the buyer, so they appear as waiting.
    const strangers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const from = getAssociatedTokenAddressSync(launch.crwaMint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await send(buyer, [
      SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: strangers[0]!.publicKey, lamports: 20_000_000 }),
      ...strangers.flatMap((s) => {
        const to = getAssociatedTokenAddressSync(launch.crwaMint, s.publicKey, false, TOKEN_2022_PROGRAM_ID);
        return [
          createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, to, s.publicKey, launch.crwaMint, TOKEN_2022_PROGRAM_ID),
          createTransferCheckedInstruction(from, launch.crwaMint, to, buyer.publicKey, 2n * unit, launch.decimals, [], TOKEN_2022_PROGRAM_ID),
        ];
      }),
    ]);
    const waiting = (await loadConsole(connection, registry, issuer.publicKey)).find((l) => l.entry.launch.address.equals(launch.address))!.waiting.map((w) => w.owner.toBase58());
    for (const s of strangers) expect(waiting).toContain(s.publicKey.toBase58());
    expect((await loadBridgeStatus(connection, launch, strangers[0]!.publicKey)).redeem).toEqual({ kind: "not-approved" });

    // Two approvals fit in each signature; the issuer pays exactly the deposit we show, plus fees.
    const wallets = strangers.map((s) => s.publicKey);
    const chunks = approvalChunks(launch, issuer.publicKey, wallets);
    expect(chunks.map((c) => c.length)).toEqual([2, 1]);
    const lamports0 = await connection.getBalance(issuer.publicKey);
    let fee = 0;
    for (const chunk of chunks) {
      const sig = await send(issuer, await approvalBatch(connection, launch, issuer.publicKey, chunk));
      fee += (await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.fee;
    }
    const deposit = await approvalDeposit(connection);
    expect(BigInt(lamports0 - (await connection.getBalance(issuer.publicKey)) - fee)).toBe(3n * deposit);

    expect(await alreadyApproved(connection, launch, wallets)).toEqual([true, true, true]);
    const register = (await loadRegister(connection, launch)).map((w) => w.owner.toBase58());
    for (const s of strangers) expect(register).toContain(s.publicKey.toBase58());
    const after = (await loadConsole(connection, await loadRegistry(connection), issuer.publicKey)).find((l) => l.entry.launch.address.equals(launch.address))!;
    for (const s of strangers) expect(after.waiting.map((w) => w.owner.toBase58())).not.toContain(s.publicKey.toBase58());

    // Approving someone twice is refused before signing.
    const twice = await prepareTransaction(connection, issuer.publicKey, await approvalBatch(connection, launch, issuer.publicKey, [wallets[0]!])).catch((e) => e);
    expect(explainTradeError(twice).title).toBe("Already on the register");

    // A stranger can't approve anyone, and is told why.
    const outsider = Keypair.generate();
    const denied = await prepareTransaction(connection, buyer.publicKey, await approvalBatch(connection, launch, buyer.publicKey, [outsider.publicKey])).catch((e) => e);
    expect(explainTradeError(denied).title).toBe("This wallet can’t change the register");

    // The newly approved holder redeems its wrapper for the security, one for one.
    const p = await prepareBridge(connection, "redeem", launch, strangers[0]!.publicKey, 2n * unit);
    p.transaction.sign([strangers[0]!]);
    const r = await connection.confirmTransaction({ signature: await connection.sendTransaction(p.transaction), blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
    expect(r.value.err).toBeNull();
    const status = await loadBridgeStatus(connection, launch, strangers[0]!.publicKey);
    expect(status.security).toBe(2n * unit);
    expect(status.wrapper).toBe(0n);
  }, 90_000);
});
