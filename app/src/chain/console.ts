/**
 * Everything the issuer console shows, for the launches one wallet issued. Read-only.
 */
import { largestTokenAccounts } from "./indexRpc";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { creatorMigrationFee } from "../lib/money";
import { isSet } from "./aegis";
import { graduationStep } from "./graduate";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";
import { holderAccounts, saaAddress } from "./holdings";
import { CREATOR_MIGRATION_FEE_MASK } from "./meteora";
import type { Registry, RegistryEntry } from "./registry";

export type PayoutStatus = "collected" | "ready" | "at-graduation" | "none";

export type ConsoleLaunch = {
  entry: RegistryEntry;
  /** The issuer's share of the raise and where it stands. */
  payout: { amount: bigint; status: PayoutStatus };
  /** Security owed back to the issuer, sitting in escrow (after graduation). */
  unsold: bigint;
  /** The issuer's own wallet is on the register, so it can receive the security. */
  issuerApproved: boolean;
  /** Wallets holding the wrapper that the issuer has not approved. */
  waiting: { owner: PublicKey; wrapper: bigint }[];
};

const SAA = [68, 169, 137, 56, 226, 21, 69, 124];

function saaGroup(info: AccountInfo<Uint8Array> | null | undefined): bigint | null {
  if (!info || !info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) || info.data.length < 16) return null;
  if (!SAA.every((b, i) => info.data[i] === b)) return null;
  return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(8, true);
}

async function readMany(connection: Connection, keys: PublicKey[]) {
  const out: (AccountInfo<Uint8Array> | null)[] = [];
  for (let i = 0; i < keys.length; i += 99) out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 99), "confirmed")));
  return out;
}

/**
 * Wrapper holders who are people rather than programs (pools, escrow, vaults are program-derived
 * and so off the curve), and who have no approval on the issuer's register.
 */
async function waitingHolders(connection: Connection, entry: RegistryEntry): Promise<ConsoleLaunch["waiting"]> {
  const { launch } = entry;
  const accounts = await largestTokenAccounts(connection, launch.crwaMint);
  const holders = new Map<string, { owner: PublicKey; wrapper: bigint }>();
  for (const { pubkey, account } of accounts) {
    try {
      const a = unpackAccount(pubkey, { ...account, data: Buffer.from(account.data) }, TOKEN_2022_PROGRAM_ID);
      if (a.amount === 0n || !a.mint.equals(launch.crwaMint) || !PublicKey.isOnCurve(a.owner.toBytes())) continue;
      const prev = holders.get(a.owner.toBase58());
      holders.set(a.owner.toBase58(), { owner: a.owner, wrapper: (prev?.wrapper ?? 0n) + a.amount });
    } catch {
      // not a token account for this mint
    }
  }
  const list = [...holders.values()];
  const saas = await readMany(
    connection,
    list.map((h) => saaAddress(getAssociatedTokenAddressSync(launch.realRwaMint, h.owner, false, TOKEN_2022_PROGRAM_ID)))
  );
  return list.filter((_, i) => saaGroup(saas[i]) !== launch.investorGroup).sort((a, b) => (b.wrapper > a.wrapper ? 1 : -1));
}

export async function loadConsole(connection: Connection, registry: Registry, issuer: PublicKey): Promise<ConsoleLaunch[]> {
  const mine = registry.entries.filter((e) => e.launch.issuer.equals(issuer));
  const issuerSaas = await readMany(connection, mine.map((e) => holderAccounts(e, issuer).saa));

  return Promise.all(
    mine.map(async (entry, i): Promise<ConsoleLaunch> => {
      const { launch, detail } = entry;
      const terms = detail.terms;
      let payout: ConsoleLaunch["payout"] = { amount: 0n, status: "none" };
      if (terms && (launch.stage === "Live" || launch.stage === "Graduated")) {
        const amount = creatorMigrationFee(terms.migrationQuoteThreshold, terms.migrationFeePct, terms.creatorMigrationFeePct);
        const pool = detail.pool;
        // Only the pool's creator can collect; if the pool names someone else, show nothing claimable.
        const mineToCollect = pool ? pool.creator.equals(issuer) : false;
        const status: PayoutStatus =
          amount === 0n || !mineToCollect
            ? "none"
            : (pool!.migrationFeeStatus & CREATOR_MIGRATION_FEE_MASK) !== 0
              ? "collected"
              : pool!.quoteReserve >= terms.migrationQuoteThreshold
                ? "ready"
                : "at-graduation";
        payout = { amount, status };
      }
      const live = launch.stage === "Live" || launch.stage === "Graduated";
      return {
        entry,
        payout,
        unsold: launch.stage === "Graduated" ? launch.issuerUnsold : 0n,
        issuerApproved: saaGroup(issuerSaas[i]) === launch.investorGroup,
        waiting: live && isSet(launch.crwaMint) ? await waitingHolders(connection, entry).catch(() => []) : [],
      };
    })
  );
}

export type Attention =
  | { kind: "unsold-blocked"; launch: ConsoleLaunch }
  | { kind: "raise-ready"; launch: ConsoleLaunch }
  | { kind: "graduate"; launch: ConsoleLaunch }
  | { kind: "waiting"; launch: ConsoleLaunch; count: number }
  | { kind: "unfinished"; launch: ConsoleLaunch };

/** What needs the issuer, most urgent first. */
export function attentionItems(launches: ConsoleLaunch[]): Attention[] {
  const items: Attention[] = [];
  for (const l of launches) {
    const g = graduationStep(l.entry.launch, l.entry.detail.pool, l.entry.detail.terms);
    if (g === "migrate" || g === "finalize") items.push({ kind: "graduate", launch: l });
  }
  for (const l of launches) if (l.payout.status === "ready") items.push({ kind: "raise-ready", launch: l });
  for (const l of launches) if (l.unsold > 0n && !l.issuerApproved) items.push({ kind: "unsold-blocked", launch: l });
  for (const l of launches) if (l.waiting.length > 0) items.push({ kind: "waiting", launch: l, count: l.waiting.length });
  for (const l of launches) {
    const s = l.entry.launch.stage;
    if (s === "TokenCreated" || s === "Funded" || s === "Configured") items.push({ kind: "unfinished", launch: l });
  }
  return items;
}
