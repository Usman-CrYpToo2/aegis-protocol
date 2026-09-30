/**
 * A brand-new issuer launching an asset end to end on a local node with the app's own
 * instructions, then a second launch cancelled before its sale opens. Needs the platform set up
 * (any yarn localnet:launch). Skipped unless AEGIS_LOCALNET=1.
 */
import { readFileSync } from "node:fs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { planCurve, priceToSqrt, type Terms } from "../lib/terms";
import { ISSUE_ERRORS, explainTradeError } from "../lib/txErrors";
import { TOKEN_2022_PROGRAM_ID } from "./ids";
import {
  INVESTOR_GROUP, VAULT_GROUP, abortInstructions, createInstructions, fundInstructions, groupInstructions, holderInstructions, issueAddresses,
  loadIssueProgress, nextHolderIdFor, openInstructions, registerInstructions, termsInstructions,
} from "./issue";
import { decodeDbcConfig } from "./meteora";
import { loadPlatform } from "./platform";
import { prepareTransaction } from "./tx";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const unit = 1_000_000n;

async function send(signers: Keypair[], ixs: TransactionInstruction[]) {
  const p = await prepareTransaction(connection, signers[0]!.publicKey, ixs);
  p.transaction.sign(signers);
  const sig = await connection.sendTransaction(p.transaction);
  const r = await connection.confirmTransaction({ signature: sig, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
  expect(r.value.err).toBeNull();
}

async function newIssuer() {
  const actors = JSON.parse(readFileSync("../.localnet/actors.json", "utf8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(actors.admin));
  const issuer = Keypair.generate();
  await send([admin], [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: issuer.publicKey, lamports: 5 * LAMPORTS_PER_SOL })]);
  return issuer;
}

/** Steps 1 to 6, each checked against the progress the app reads back. */
async function prepare(issuer: Keypair, name: string, symbol: string) {
  const platform = await loadPlatform(connection);
  const rwa = Keypair.generate();
  const mint = rwa.publicKey;
  const me = issuer.publicKey;
  const progress = async () => (await loadIssueProgress(connection, mint, me)).next;
  expect(await progress()).toBe("create");
  await send([issuer, rwa], createInstructions(mint, me, platform.config.feeRecipient, { name, symbol, uri: "", decimals: 6, totalSupply: 1_000_000n * unit }));
  expect(await progress()).toBe("register");
  await send([issuer], registerInstructions(mint, me));
  expect(await progress()).toBe("groups");
  await send([issuer], groupInstructions(mint, me));
  expect(await progress()).toBe("vault");
  const a = issueAddresses(mint, me);
  await send([issuer], holderInstructions(mint, me, a.authority, VAULT_GROUP, await nextHolderIdFor(connection, mint)));
  expect(await progress()).toBe("yourself");
  await send([issuer], holderInstructions(mint, me, me, INVESTOR_GROUP, await nextHolderIdFor(connection, mint)));
  expect(await progress()).toBe("fund");
  await send([issuer], fundInstructions(mint, me));
  expect(await progress()).toBe("terms");
  return { platform, mint };
}

describe.runIf(process.env.AEGIS_LOCALNET === "1")("issuing against a live node", () => {
  it("takes a new issuer from nothing to an open sale in eight transactions", async () => {
    const issuer = await newIssuer();
    const { platform, mint } = await prepare(issuer, "Harbour Lofts", "HRBR");
    const quote = platform.quotes[0]!;
    const terms: Terms = { quoteAtomsPerToken: 2n * 10n ** BigInt(quote.decimals), archetype: "BookBuilding", sqrtBps: 11_000, targetRaise: 20_000n * 10n ** BigInt(quote.decimals), migrationFeePct: 40, permanentPct: 30, vestedPct: 100 - platform.config.aegisLpSharePct - 30, vestingMonths: 12, poolFeeBps: 100 };

    const config = Keypair.generate();
    await send([issuer, config], termsInstructions(mint, issuer.publicKey, quote.mint, config.publicKey, terms, 6));
    const progress = await loadIssueProgress(connection, mint, issuer.publicKey);
    expect(progress.next).toBe("open");

    // What the app previewed is exactly what Meteora stored.
    const stored = decodeDbcConfig((await connection.getAccountInfo(config.publicKey))!);
    const plan = planCurve(priceToSqrt(terms.quoteAtomsPerToken, 6), terms.sqrtBps, terms.targetRaise, terms.archetype, 1_000_000n * unit);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(stored.sqrtStartPrice).toBe(plan.plan.sqrtStart);
    expect(stored.migrationSqrtPrice).toBe(plan.plan.migrationSqrt);
    expect(stored.curve[0]).toEqual({ sqrtPrice: plan.plan.sqrtEnd, liquidity: plan.plan.liquidity });
    expect(stored.migrationQuoteThreshold).toBe(terms.targetRaise);

    const crwa = Keypair.generate();
    await send([issuer, crwa], openInstructions(progress.launch!, issuer.publicKey, crwa.publicKey, quote.program, { name: "Wrapped Harbour Lofts", symbol: "cHRBR", uri: "" }));
    const live = await loadIssueProgress(connection, mint, issuer.publicKey);
    expect(live.next).toBeNull();
    expect(live.launch!.stage).toBe("Live");
    expect(live.launch!.crwaMint.equals(crwa.publicKey)).toBe(true);
  }, 120_000);

  it("refuses terms the supply can't cover with a plain reason, and cancels a launch back to the issuer", async () => {
    const issuer = await newIssuer();
    const { platform, mint } = await prepare(issuer, "Quay Warehouse", "QUAY");
    const quote = platform.quotes[0]!;
    const d = 10n ** BigInt(quote.decimals);
    // 0.001 per token for a 10,000 raise needs ~10 million tokens; there are 1 million.
    const tooBig: Terms = { quoteAtomsPerToken: d / 1000n, archetype: "BookBuilding", sqrtBps: 11_000, targetRaise: 10_000n * d, migrationFeePct: 50, permanentPct: 30, vestedPct: 100 - platform.config.aegisLpSharePct - 30, vestingMonths: 12, poolFeeBps: 100 };
    const refused = await prepareTransaction(connection, issuer.publicKey, termsInstructions(mint, issuer.publicKey, quote.mint, Keypair.generate().publicKey, tooBig, 6)).catch((e) => e);
    expect(explainTradeError(refused, ISSUE_ERRORS).title).toBe("Your supply is too small for these terms");

    const { launch } = await loadIssueProgress(connection, mint, issuer.publicKey);
    await send([issuer], abortInstructions(launch!, issuer.publicKey));
    const after = await loadIssueProgress(connection, mint, issuer.publicKey);
    expect(after.aborted).toBe(true);
    const back = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, issuer.publicKey, false, TOKEN_2022_PROGRAM_ID));
    expect(BigInt(back.value.amount)).toBe(1_000_000n * unit);
  }, 120_000);
});
