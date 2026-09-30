/**
 * The issuer collecting its raise and unsold stock on a local node, with the app's own
 * instructions. Needs a graduated launch left uncollected:
 *   AEGIS_NAME="Aegis Tower B" AEGIS_SYMBOL=TWRB AEGIS_SKIP_CLAIMS=1 yarn localnet:launch
 * Skipped unless AEGIS_LOCALNET=1.
 */
import { readFileSync } from "node:fs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { explainTradeError } from "../lib/txErrors";
import { loadAsset } from "./asset";
import { claimUnsoldInstruction, collectRaiseInstructions } from "./collect";
import { TOKEN_2022_PROGRAM_ID } from "./ids";
import { loadRegistry } from "./registry";
import { prepareTransaction } from "./tx";

describe.runIf(process.env.AEGIS_LOCALNET === "1")("collecting against a live node", () => {
  it("pays the issuer its raise and unsold stock exactly once", async () => {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
    const issuer = Keypair.fromSecretKey(Uint8Array.from(actors.issuer));
    const entry = (await loadRegistry(connection)).entries.find((e) => e.launch.stage === "Graduated" && e.launch.issuerUnsold > 0n);
    expect(entry, "seed a graduated launch with AEGIS_SKIP_CLAIMS=1").toBeDefined();
    const { launch } = entry!;
    const quoteProgram = (await connection.getAccountInfo(launch.quoteMint))!.owner;
    const issuerQuote = getAssociatedTokenAddressSync(launch.quoteMint, issuer.publicKey, false, quoteProgram);
    const issuerReal = getAssociatedTokenAddressSync(launch.realRwaMint, issuer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const bal = async (a: typeof issuerQuote) => BigInt((await connection.getTokenAccountBalance(a).catch(() => null))?.value.amount ?? "0");
    const send = async (ixs: TransactionInstruction[]) => {
      const p = await prepareTransaction(connection, issuer.publicKey, ixs);
      p.transaction.sign([issuer]);
      const sig = await connection.sendTransaction(p.transaction);
      const r = await connection.confirmTransaction({ signature: sig, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
      expect(r.value.err).toBeNull();
    };

    const q0 = await bal(issuerQuote);
    await send(collectRaiseInstructions(launch, issuer.publicKey, quoteProgram));
    expect((await bal(issuerQuote)) - q0).toBe(5_000_000_000n); // 50% of 10,000 USDC

    const owed = launch.issuerUnsold;
    const r0 = await bal(issuerReal);
    await send([claimUnsoldInstruction(launch, issuer.publicKey)]);
    expect((await bal(issuerReal)) - r0).toBe(owed);
    expect((await loadAsset(connection, launch.realRwaMint)).launch.issuerUnsold).toBe(0n);

    // A second collection is refused before anything is signed, with a plain explanation.
    const again = await prepareTransaction(connection, issuer.publicKey, collectRaiseInstructions(launch, issuer.publicKey, quoteProgram)).catch((e) => e);
    expect(explainTradeError(again).title).toBe("Already collected");
  }, 60_000);
});
