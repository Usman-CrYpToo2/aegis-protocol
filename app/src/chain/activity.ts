/**
 * Recent activity for one wallet, rebuilt from its own transactions: what happened to its balance of
 * each registered asset, and which program did it. Nothing is stored anywhere; it is read from the
 * chain each time, like everything else in the app.
 */
import type { Connection, ParsedTransactionWithMeta, PublicKey, TokenBalance } from "@solana/web3.js";
import { DAMM_V2_PROGRAM_ID } from "./damm";
import { AEGIS_PROGRAM_ID, METEORA_DBC_PROGRAM_ID } from "./ids";
import { holderAccounts, type Holding } from "./holdings";

export type ActivityKind = "bought" | "sold" | "redeemed" | "deposited" | "pool-trade" | "received" | "sent" | "approved";

export type Activity = {
  signature: string;
  time: number | null;
  kind: ActivityKind;
  holding: Holding;
  /** Signed change, in atoms, of the token the line is about. Null for approvals. */
  amount: bigint | null;
  /** Which of the asset's two tokens `amount` is in. */
  token: "wrapper" | "security" | null;
};

const PER_ACCOUNT = 12;
const SHOWN = 20;

/** The owner's change in `mint` across the transaction, from the runtime's own balance records. */
function delta(tx: ParsedTransactionWithMeta, owner: string, mint: string): bigint {
  const sum = (list: TokenBalance[] | null | undefined) =>
    (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

function classify(tx: ParsedTransactionWithMeta, owner: string, h: Holding): Omit<Activity, "signature" | "time" | "holding"> | null {
  const programs = new Set(tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()));
  const w = delta(tx, owner, h.entry.launch.crwaMint.toBase58());
  const s = delta(tx, owner, h.entry.launch.realRwaMint.toBase58());
  if (w === 0n && s === 0n) return null;
  if (programs.has(AEGIS_PROGRAM_ID.toBase58()) && w < 0n && s > 0n) return { kind: "redeemed", amount: s, token: "security" };
  if (programs.has(AEGIS_PROGRAM_ID.toBase58()) && s < 0n && w > 0n) return { kind: "deposited", amount: w, token: "wrapper" };
  if (programs.has(METEORA_DBC_PROGRAM_ID.toBase58()) && w !== 0n) return { kind: w > 0n ? "bought" : "sold", amount: w, token: "wrapper" };
  if (programs.has(DAMM_V2_PROGRAM_ID.toBase58()) && w !== 0n) return { kind: "pool-trade", amount: w, token: "wrapper" };
  if (w !== 0n) return { kind: w > 0n ? "received" : "sent", amount: w, token: "wrapper" };
  return { kind: s > 0n ? "received" : "sent", amount: s, token: "security" };
}

export async function loadActivity(connection: Connection, owner: PublicKey, holdings: Holding[]): Promise<Activity[]> {
  const me = owner.toBase58();
  const seen = new Map<string, { time: number | null; holding: Holding; approval: boolean }>();

  await Promise.all(
    holdings.map(async (h) => {
      const a = holderAccounts(h.entry, owner);
      const lists = await Promise.all([
        connection.getSignaturesForAddress(a.security, { limit: PER_ACCOUNT }, "confirmed"),
        a.wrapper ? connection.getSignaturesForAddress(a.wrapper, { limit: PER_ACCOUNT }, "confirmed") : Promise.resolve([]),
        // The approval record is written once, so its oldest transaction is when approval happened.
        h.approved ? connection.getSignaturesForAddress(a.saa, { limit: 5 }, "confirmed") : Promise.resolve([]),
      ]);
      for (const sig of [...lists[0]!, ...lists[1]!]) {
        if (!sig.err && !seen.has(sig.signature)) seen.set(sig.signature, { time: sig.blockTime ?? null, holding: h, approval: false });
      }
      const approval = lists[2]!.filter((x) => !x.err).at(-1);
      if (approval) seen.set(approval.signature, { time: approval.blockTime ?? null, holding: h, approval: true });
    })
  );

  const recent = [...seen.entries()].sort((x, y) => (y[1].time ?? 0) - (x[1].time ?? 0)).slice(0, SHOWN);
  const parsed = await connection.getParsedTransactions(recent.map(([sig]) => sig), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });

  const out: Activity[] = [];
  recent.forEach(([signature, meta], i) => {
    if (meta.approval) {
      out.push({ signature, time: meta.time, kind: "approved", holding: meta.holding, amount: null, token: null });
      return;
    }
    const tx = parsed[i];
    if (!tx || tx.meta?.err) return;
    const line = classify(tx, me, meta.holding);
    if (line) out.push({ signature, time: meta.time, holding: meta.holding, ...line });
  });
  return out;
}
