/**
 * The bridge: exchange the wrapper (cRWA) for the security (Real RWA) and back, one for one.
 *
 * Account order and discriminators come from the program's IDL (bridge_redeem, bridge_deposit),
 * and bridge.test.ts checks them against it. Upside's accounts are read here only to tell a
 * person, before they sign, which of the program's own checks would stop them.
 */
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo, type Connection } from "@solana/web3.js";
import idl from "../idl/aegis.json";
import type { LaunchAccount } from "./aegis";
import { ACCESS_CONTROL_PROGRAM_ID, AEGIS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";
import type { Nonce } from "./nonce";
import { prepareTransaction, type PreparedTx } from "./tx";

export type Direction = "redeem" | "deposit";

const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const discriminator = (name: string) => Uint8Array.from(idl.instructions.find((i) => i.name === name)!.discriminator);
const REDEEM = discriminator("bridge_redeem");
const DEPOSIT = discriminator("bridge_deposit");

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const pda = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const text = (s: string) => new TextEncoder().encode(s);

export function bridgeAddresses(launch: LaunchAccount, user: PublicKey) {
  const mint = launch.realRwaMint;
  const trd = pda([text("trd"), mint.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  const userReal = getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM_ID);
  const rule = (from: bigint, to: bigint) => pda([text("tr"), trd.toBytes(), u64(from), u64(to)], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  return {
    launch: launch.address,
    authority: pda([text("authority"), launch.address.toBytes()], AEGIS_PROGRAM_ID),
    escrowVault: launch.escrowVault,
    userReal,
    userCrwa: getAssociatedTokenAddressSync(launch.crwaMint, user, false, TOKEN_2022_PROGRAM_ID),
    accessControl: pda([text("ac"), mint.toBytes()], ACCESS_CONTROL_PROGRAM_ID),
    trd,
    userSaa: pda([text("saa"), userReal.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID),
    vaultSaa: pda([text("saa"), launch.escrowVault.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID),
    redeemRule: rule(launch.vaultGroup, launch.investorGroup),
    depositRule: rule(launch.investorGroup, launch.vaultGroup),
    extraMetas: pda([text("extra-account-metas"), mint.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID),
  };
}

export function bridgeInstruction(direction: Direction, launch: LaunchAccount, user: PublicKey, amount: bigint): TransactionInstruction {
  const a = bridgeAddresses(launch, user);
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const head = [
    { pubkey: user, isSigner: true, isWritable: true },
    w(a.launch),
    r(launch.realRwaMint),
    w(launch.crwaMint),
    r(a.authority),
    w(a.escrowVault),
    w(a.userReal),
    w(a.userCrwa),
    r(a.accessControl),
    r(a.trd),
  ];
  const keys =
    direction === "redeem"
      ? [...head, r(a.vaultSaa), r(a.userSaa), r(a.redeemRule), r(a.extraMetas), r(TRANSFER_RESTRICTIONS_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId)]
      : [...head, r(a.userSaa), r(a.vaultSaa), r(a.depositRule), r(a.redeemRule), r(a.extraMetas), r(TRANSFER_RESTRICTIONS_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(ATA_PROGRAM_ID), r(SystemProgram.programId)];
  const data = new Uint8Array(16);
  data.set(direction === "redeem" ? REDEEM : DEPOSIT, 0);
  data.set(u64(amount), 8);
  return new TransactionInstruction({ programId: AEGIS_PROGRAM_ID, keys, data: Buffer.from(data) });
}

export const prepareBridge = (connection: Connection, direction: Direction, launch: LaunchAccount, user: PublicKey, amount: bigint, nonce?: Nonce): Promise<PreparedTx> =>
  prepareTransaction(connection, user, [bridgeInstruction(direction, launch, user, amount)], nonce);

// ------------------------------------------------------------------------------------------------
// Eligibility: what would stop this wallet, in the order the program checks it.
// ------------------------------------------------------------------------------------------------

type Info = AccountInfo<Uint8Array> | null | undefined;

const DISC = {
  saa: [68, 169, 137, 56, 226, 21, 69, 124],
  trd: [166, 184, 205, 98, 165, 224, 174, 148],
  rule: [200, 231, 114, 91, 84, 241, 109, 172],
};

function upsideAccount(info: Info, disc: number[], minLength: number): Uint8Array | null {
  if (!info || !info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) || info.data.length < minLength) return null;
  return disc.every((b, i) => info.data[i] === b) ? info.data : null;
}
const readU64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);

/** A token account's amount and frozen flag (same layout under both token programs). */
function tokenAccount(info: Info): { amount: bigint; frozen: boolean } | null {
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID) || info.data.length < 109) return null;
  return { amount: readU64(info.data, 64), frozen: info.data[108] === 2 };
}

export type BridgeBlock =
  | { kind: "not-graduated" }
  | { kind: "paused" }
  | { kind: "not-approved" }
  | { kind: "frozen" }
  | { kind: "vault-unavailable" }
  | { kind: "deposit-closed" }
  | { kind: "deposit-locked"; until: Date };

export type BridgeStatus = {
  /** Security (Real RWA) in the wallet. */
  security: bigint;
  /** Wrapper (cRWA) in the wallet. */
  wrapper: bigint;
  /** Security held in escrow: the most that can be redeemed. */
  escrowed: bigint;
  /** What stops each direction, or null when it is open. The first problem is the one shown. */
  redeem: BridgeBlock | null;
  deposit: BridgeBlock | null;
};

export async function loadBridgeStatus(connection: Connection, launch: LaunchAccount, user: PublicKey): Promise<BridgeStatus> {
  const a = bridgeAddresses(launch, user);
  const [trdInfo, userSaaInfo, vaultInfo, userRealInfo, userCrwaInfo, depositRuleInfo, redeemRuleInfo, vaultSaaInfo] = await connection.getMultipleAccountsInfo(
    [a.trd, a.userSaa, a.escrowVault, a.userReal, a.userCrwa, a.depositRule, a.redeemRule, a.vaultSaa],
    "confirmed"
  );

  const trd = upsideAccount(trdInfo, DISC.trd, 97);
  const userSaa = upsideAccount(userSaaInfo, DISC.saa, 16);
  const vaultSaa = upsideAccount(vaultSaaInfo, DISC.saa, 16);
  const redeemRule = upsideAccount(redeemRuleInfo, DISC.rule, 64);
  const depositRule = upsideAccount(depositRuleInfo, DISC.rule, 64);
  const vault = tokenAccount(vaultInfo);
  const userReal = tokenAccount(userRealInfo);
  const userCrwa = tokenAccount(userCrwaInfo);

  // Shared by both directions, in the order verify_compliance and the handlers check them.
  let shared: BridgeBlock | null = null;
  if (launch.stage !== "Graduated") shared = { kind: "not-graduated" };
  else if (!trd || trd[96] === 1) shared = trd ? { kind: "paused" } : { kind: "vault-unavailable" };
  else if (!userSaa || readU64(userSaa, 8) !== launch.investorGroup) shared = { kind: "not-approved" };
  else if (!vault || vault.frozen || !vaultSaa || readU64(vaultSaa, 8) !== launch.vaultGroup || !redeemRule) shared = { kind: "vault-unavailable" };
  else if (userReal?.frozen) shared = { kind: "frozen" };

  let deposit: BridgeBlock | null = shared;
  if (!deposit) {
    const until = depositRule ? readU64(depositRule, 56) : 0n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (!depositRule || until === 0n) deposit = { kind: "deposit-closed" };
    else if (until > 1n && until > now) deposit = { kind: "deposit-locked", until: new Date(Number(until) * 1000) };
  }

  return {
    security: userReal?.amount ?? 0n,
    wrapper: userCrwa?.amount ?? 0n,
    escrowed: vault?.amount ?? 0n,
    redeem: shared,
    deposit,
  };
}
