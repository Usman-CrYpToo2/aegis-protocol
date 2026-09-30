/**
 * A sale filled by a buyer, then graduated by a third party with the app's own instructions, on a
 * local node. Makes its own launch. Skipped unless AEGIS_LOCALNET=1.
 */
import { readFileSync } from "node:fs";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadAsset } from "./asset";
import { loadBridgeStatus } from "./bridge";
import { finalizeInstruction, graduationStep, migrateInstruction } from "./graduate";
import {
  INVESTOR_GROUP, VAULT_GROUP, createInstructions, fundInstructions, groupInstructions, holderInstructions, issueAddresses,
  loadIssueProgress, nextHolderIdFor, openInstructions, registerInstructions, termsInstructions,
} from "./issue";
import { loadPlatform } from "./platform";
import { loadTradeAccounts, tradeInstructions } from "./trade";
import { prepareTransaction } from "./tx";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");

async function send(signers: Keypair[], ixs: TransactionInstruction[]) {
  const p = await prepareTransaction(connection, signers[0]!.publicKey, ixs);
  p.transaction.sign(signers);
  const sig = await connection.sendTransaction(p.transaction);
  const r = await connection.confirmTransaction({ signature: sig, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
  expect(r.value.err).toBeNull();
}

describe.runIf(process.env.AEGIS_LOCALNET === "1")("graduating against a live node", () => {
  it("lets anyone move a filled sale to its pool and open the bridge", async () => {
    const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
    const admin = Keypair.fromSecretKey(Uint8Array.from(actors.admin));
    const [issuer, buyer, stranger] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await send([admin], [issuer, buyer, stranger].map((k) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: k.publicKey, lamports: 3 * LAMPORTS_PER_SOL })));

    // A small launch: 1,000 USDC at 1.00.
    const platform = await loadPlatform(connection);
    const quote = platform.quotes[0]!;
    const rwa = Keypair.generate();
    const mint = rwa.publicKey;
    const me = issuer.publicKey;
    await send([issuer, rwa], createInstructions(mint, me, platform.config.feeRecipient, { name: "Dockside Mill", symbol: "DOCK", uri: "", decimals: 6, totalSupply: 100_000_000_000n }));
    await send([issuer], registerInstructions(mint, me));
    await send([issuer], groupInstructions(mint, me));
    await send([issuer], holderInstructions(mint, me, issueAddresses(mint, me).authority, VAULT_GROUP, await nextHolderIdFor(connection, mint)));
    await send([issuer], holderInstructions(mint, me, me, INVESTOR_GROUP, await nextHolderIdFor(connection, mint)));
    await send([issuer], fundInstructions(mint, me));
    const d = 10n ** BigInt(quote.decimals);
    const cfg = Keypair.generate();
    await send([issuer, cfg], termsInstructions(mint, me, quote.mint, cfg.publicKey, { quoteAtomsPerToken: d, archetype: "BookBuilding", sqrtBps: 11_000, targetRaise: 1_000n * d, migrationFeePct: 50, permanentPct: 30, vestedPct: 100 - platform.config.aegisLpSharePct - 30, vestingMonths: 12, poolFeeBps: 100 }, 6));
    const crwa = Keypair.generate();
    await send([issuer, crwa], openInstructions((await loadIssueProgress(connection, mint, me)).launch!, me, crwa.publicKey, quote.program, { name: "Wrapped Dockside Mill", symbol: "cDOCK", uri: "" }));

    let entry = await loadAsset(connection, mint);
    expect(graduationStep(entry.launch, entry.detail.pool, entry.detail.terms)).toBe("selling");

    // The buyer fills the sale (asking for more than is left; the curve refunds the rest).
    const buyerQuote = getAssociatedTokenAddressSync(quote.mint, buyer.publicKey, false, quote.program);
    await send([admin], [
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, buyerQuote, buyer.publicKey, quote.mint, quote.program),
      createMintToInstruction(quote.mint, buyerQuote, admin.publicKey, 2_000n * d, [], quote.program),
    ]);
    await send([buyer], tradeInstructions({ launch: entry.launch, pool: entry.detail.pool!, accounts: await loadTradeAccounts(connection, entry.launch), owner: buyer.publicKey, side: "buy", amountIn: 1_200n * d, minimumOut: 0n }));
    entry = await loadAsset(connection, mint);
    expect(graduationStep(entry.launch, entry.detail.pool, entry.detail.terms)).toBe("migrate");

    // A stranger graduates it: two permissionless transactions.
    const before = await connection.getBalance(stranger.publicKey);
    const [first, second] = [Keypair.generate(), Keypair.generate()];
    await send([stranger, first, second], [migrateInstruction(entry.launch, stranger.publicKey, first.publicKey, second.publicKey, quote.program)]);
    entry = await loadAsset(connection, mint);
    expect(graduationStep(entry.launch, entry.detail.pool, entry.detail.terms)).toBe("finalize");
    await send([stranger], [finalizeInstruction(entry.launch, stranger.publicKey)]);
    entry = await loadAsset(connection, mint);
    expect(entry.launch.stage).toBe("Graduated");
    expect(graduationStep(entry.launch, entry.detail.pool, entry.detail.terms)).toBe("done");
    expect(entry.backing.kind).toBe("backed");
    console.log("graduating cost the sender", (before - (await connection.getBalance(stranger.publicKey))) / LAMPORTS_PER_SOL, "SOL");

    // The bridge is open: the issuer, who is approved, sees no blocking reason.
    const status = await loadBridgeStatus(connection, entry.launch, me);
    expect(status.redeem?.kind).not.toBe("not-graduated");
  }, 180_000);
});
