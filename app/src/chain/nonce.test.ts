import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { launchTransactions, STEP_IDS } from "./issue";
import { nonceAddresses, setupInstructions, type Nonce } from "./nonce";
import { TransactionMessage } from "@solana/web3.js";

const key = () => Keypair.generate().publicKey;
const PACKET = 1232; // the most a Solana transaction may be

// The worst case a launch can produce: the longest name, symbol and documents link the form allows.
const plan = (issuer: PublicKey, rwa = Keypair.generate()) => ({
  mint: rwa.publicKey, issuer, feeRecipient: key(),
  create: { keypair: rwa, details: { name: "Logistics Warehouse Income Trust", symbol: "ABCDEFGHI", uri: `https://${"d".repeat(192)}`, decimals: 6, totalSupply: 1_000_000_000_000n } },
  terms: { quoteMint: NATIVE_MINT, terms: { quoteAtomsPerToken: 50_000_000n, archetype: "BookBuilding" as const, sqrtBps: 11_000, targetRaise: 5_000_000_000n, migrationFeePct: 60, permanentPct: 30, vestedPct: 60, vestingMonths: 24, poolFeeBps: 50 } },
  quoteProgram: TOKEN_PROGRAM_ID, decimals: 6, wrapper: { name: "Wrapped Logistics Warehouse", symbol: "cABCDEFGHI", uri: "" },
  firstHolderId: 0n, existing: null,
});

describe("durable nonces", () => {
  it("derives the same eight accounts for a wallet every time, and different ones per wallet", async () => {
    const owner = key();
    const [a, b, c] = await Promise.all([nonceAddresses(owner), nonceAddresses(owner), nonceAddresses(key())]);
    expect(a.map(String)).toEqual(b.map(String));
    expect(new Set(a.map(String)).size).toBe(8);
    expect(a[0]!.equals(c[0]!)).toBe(false);
  });

  it("creates the accounts in setup transactions small enough to send", async () => {
    const owner = key();
    const groups = await setupInstructions(owner, [0, 1, 2, 3, 4, 5, 6, 7], 1_000_000);
    expect(groups).toHaveLength(2);
    for (const ixs of groups) {
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: key().toBase58(), instructions: ixs }).compileToV0Message());
      expect(tx.serialize().length).toBeLessThanOrEqual(PACKET);
    }
  });

  it("starts every launch step with its own nonce advance, and still fits each one in a transaction", async () => {
    const issuer = key();
    const nonces: Nonce[] = (await nonceAddresses(issuer)).map((address) => ({ address, value: key().toBase58() }));
    const plain = launchTransactions(plan(issuer), [...STEP_IDS], key().toBase58());
    const withNonces = launchTransactions(plan(issuer), [...STEP_IDS], key().toBase58(), nonces);
    withNonces.forEach(({ id, tx }, i) => {
      const m = tx.message;
      const first = m.compiledInstructions[0]!;
      expect(m.staticAccountKeys[first.programIdIndex]!.equals(SystemProgram.programId)).toBe(true);
      expect(m.staticAccountKeys[first.accountKeyIndexes[0]!]!.equals(nonces[i]!.address)).toBe(true);
      expect(m.recentBlockhash).toBe(nonces[i]!.value);
      const size = tx.serialize().length;
      console.log(`${id.padEnd(9)} ${String(plain[i]!.tx.serialize().length).padStart(5)} → ${size} bytes`);
      expect(size).toBeLessThanOrEqual(PACKET);
    });
  });
});
