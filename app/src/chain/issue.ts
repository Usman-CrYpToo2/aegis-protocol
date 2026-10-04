/**
 * Issuing an asset: the eight transactions scripts/localnet-launch.ts sends, in the same order,
 * built from the IDLs (idlInstruction), and where a launch has got to, read back from the chain.
 *
 *   1 create     Aegis create_rwa: the security, its Upside access control, the launch record
 *   2 register   Upside: the holder register and the transfer-hook accounts
 *   3 groups     Upside: the Investors and Escrow groups, and the rules between them
 *   4 vault      Upside: the escrow vault as a holder, in the Escrow group
 *   5 yourself   Upside: the issuer as a holder, in the Investors group
 *   6 fund       Aegis fund_vault: the whole supply minted into escrow
 *   7 terms      Aegis create_rwa_config: the sale terms, fixed with Meteora
 *   8 open       Aegis launch_pool: the wrapper and the sale
 *
 * Each step is recorded on-chain as soon as it lands, so progress is read, never remembered.
 */
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import aegisIdl from "../idl/aegis.json";
import trIdl from "../idl/transfer_restrictions.json";
import type { Terms } from "../lib/terms";
import { termsArgs } from "../lib/terms";
import { decodeLaunch, type LaunchAccount } from "./aegis";
import { borsh, idlInstruction } from "./idlix";
import { ACCESS_CONTROL_PROGRAM_ID, AEGIS_HOOK_PROGRAM_ID, AEGIS_PROGRAM_ID, METEORA_DBC_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";
import { advanceInstruction, NONCE_UNITS, type Nonce } from "./nonce";
import { platformConfigAddress, quoteTokenAddress } from "./platform";
import { eventAuthority, poolAuthority, tokenVault } from "./trade";

/** Aegis's group convention (programs/aegis/src/constants.rs). */
export const INVESTOR_GROUP = 1n;
export const VAULT_GROUP = 2n;
/** Upside counts `current_holders_count >= max_holders`, so 0 would allow nobody. */
export const MAX_HOLDERS = 10_000n;
/** `locked_until` = 1: allowed immediately. */
const ALLOW_NOW = 1n;

const text = (s: string) => new TextEncoder().encode(s);
const pda = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const u64 = borsh.u64;

export function issueAddresses(mint: PublicKey, issuer: PublicKey) {
  const launch = pda([text("launch"), mint.toBytes()], AEGIS_PROGRAM_ID);
  const authority = pda([text("authority"), launch.toBytes()], AEGIS_PROGRAM_ID);
  const trd = pda([text("trd"), mint.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  const escrowVault = getAssociatedTokenAddressSync(mint, authority, true, TOKEN_2022_PROGRAM_ID);
  const issuerAccount = getAssociatedTokenAddressSync(mint, issuer, false, TOKEN_2022_PROGRAM_ID);
  const group = (id: bigint) => pda([text("trg"), trd.toBytes(), u64(id)], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  const rule = (from: bigint, to: bigint) => pda([text("tr"), trd.toBytes(), u64(from), u64(to)], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  return {
    mint,
    launch,
    authority,
    trd,
    escrowVault,
    issuerAccount,
    group,
    rule,
    accessControl: pda([text("ac"), mint.toBytes()], ACCESS_CONTROL_PROGRAM_ID),
    issuerRole: pda([text("wallet_role"), mint.toBytes(), issuer.toBytes()], ACCESS_CONTROL_PROGRAM_ID),
    extraMetas: pda([text("extra-account-metas"), mint.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID),
    vaultSaa: pda([text("saa"), escrowVault.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID),
    issuerSaa: pda([text("saa"), issuerAccount.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID),
    redeemRule: rule(VAULT_GROUP, INVESTOR_GROUP),
    depositRule: rule(INVESTOR_GROUP, VAULT_GROUP),
  };
}

export type AssetDetails = { name: string; symbol: string; uri: string; decimals: number; totalSupply: bigint };

// ------------------------------------------------------------------------------------------------
// Step instructions
// ------------------------------------------------------------------------------------------------

export function createInstructions(mint: PublicKey, issuer: PublicKey, feeRecipient: PublicKey, d: AssetDetails): TransactionInstruction[] {
  const a = issueAddresses(mint, issuer);
  return [
    idlInstruction(aegisIdl, "create_rwa", {
      issuer, platform_config: platformConfigAddress(), fee_recipient: feeRecipient, real_rwa_mint: mint, launch: a.launch,
      access_control: a.accessControl, issuer_wallet_role: a.issuerRole, access_control_program: ACCESS_CONTROL_PROGRAM_ID,
      token_program: TOKEN_2022_PROGRAM_ID, system_program: SystemProgram.programId,
    }, borsh.concat(borsh.u8(d.decimals), u64(d.totalSupply), borsh.string(d.name), borsh.string(d.symbol), borsh.string(d.uri))),
  ];
}

export function registerInstructions(mint: PublicKey, issuer: PublicKey): TransactionInstruction[] {
  const a = issueAddresses(mint, issuer);
  return [
    idlInstruction(trIdl, "initialize_transfer_restrictions_data", {
      transfer_restriction_data: a.trd, zero_transfer_restriction_group: a.group(0n), mint, access_control_account: a.accessControl,
      authority_wallet_role: a.issuerRole, payer: issuer, authority: issuer, system_program: SystemProgram.programId, token_program: TOKEN_2022_PROGRAM_ID,
    }, u64(MAX_HOLDERS)),
    idlInstruction(trIdl, "initialize_extra_account_meta_list", {
      extra_metas_account: a.extraMetas, security_mint: mint, authority_wallet_role: a.issuerRole, access_control: a.accessControl,
      payer: issuer, system_program: SystemProgram.programId,
    }),
  ];
}

export function groupInstructions(mint: PublicKey, issuer: PublicKey): TransactionInstruction[] {
  const a = issueAddresses(mint, issuer);
  const common = { transfer_restriction_data: a.trd, access_control_account: a.accessControl, authority_wallet_role: a.issuerRole, authority: issuer, payer: issuer, system_program: SystemProgram.programId };
  const group = (id: bigint) => idlInstruction(trIdl, "initialize_transfer_restriction_group", { ...common, transfer_restriction_group: a.group(id) }, u64(id));
  const rule = (from: bigint, to: bigint) =>
    idlInstruction(trIdl, "initialize_transfer_rule", { ...common, transfer_rule: a.rule(from, to), transfer_restriction_group_from: a.group(from), transfer_restriction_group_to: a.group(to) }, borsh.concat(u64(from), u64(to), u64(ALLOW_NOW)));
  return [group(INVESTOR_GROUP), group(VAULT_GROUP), rule(VAULT_GROUP, INVESTOR_GROUP), rule(INVESTOR_GROUP, VAULT_GROUP)];
}

/**
 * Puts `wallet` on the register in `groupId` as holder `holderId`: its security account, a holder,
 * the holder's group membership, and the approval record. Program-owned wallets (the escrow's
 * authority) are allowed.
 */
export function holderInstructions(mint: PublicKey, issuer: PublicKey, wallet: PublicKey, groupId: bigint, holderId: bigint): TransactionInstruction[] {
  const a = issueAddresses(mint, issuer);
  const tokenAccount = getAssociatedTokenAddressSync(mint, wallet, true, TOKEN_2022_PROGRAM_ID);
  const holder = pda([text("trh"), a.trd.toBytes(), u64(holderId)], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  const holderGroup = pda([text("trhg"), holder.toBytes(), u64(groupId)], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  const common = { authority_wallet_role: a.issuerRole, authority: issuer, payer: issuer, system_program: SystemProgram.programId };
  return [
    createAssociatedTokenAccountIdempotentInstruction(issuer, tokenAccount, wallet, mint, TOKEN_2022_PROGRAM_ID),
    idlInstruction(trIdl, "initialize_transfer_restriction_holder", { ...common, transfer_restriction_holder: holder, transfer_restriction_data: a.trd, access_control_account: a.accessControl }, u64(holderId)),
    idlInstruction(trIdl, "initialize_holder_group", { ...common, holder_group: holderGroup, transfer_restriction_data: a.trd, group: a.group(groupId), holder }),
    idlInstruction(trIdl, "initialize_security_associated_account", {
      ...common, security_associated_account: pda([text("saa"), tokenAccount.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID), group: a.group(groupId), holder, holder_group: holderGroup,
      security_token: mint, transfer_restriction_data: a.trd, user_wallet: wallet, associated_token_account: tokenAccount,
    }, borsh.concat(u64(groupId), u64(holderId))),
  ];
}

export function fundInstructions(mint: PublicKey, issuer: PublicKey): TransactionInstruction[] {
  const a = issueAddresses(mint, issuer);
  return [
    idlInstruction(aegisIdl, "fund_vault", {
      issuer, launch: a.launch, real_rwa_mint: mint, aegis_authority: a.authority, escrow_vault: a.escrowVault, access_control: a.accessControl,
      issuer_wallet_role: a.issuerRole, transfer_restriction_data: a.trd, vault_saa: a.vaultSaa, redeem_rule: a.redeemRule,
      access_control_program: ACCESS_CONTROL_PROGRAM_ID, token_program: TOKEN_2022_PROGRAM_ID,
    }, u64(INVESTOR_GROUP)),
  ];
}

export function termsInstructions(mint: PublicKey, issuer: PublicKey, quoteMint: PublicKey, meteoraConfig: PublicKey, terms: Terms, decimals: number): TransactionInstruction[] {
  const a = issueAddresses(mint, issuer);
  const t = termsArgs(terms, decimals);
  return [
    idlInstruction(aegisIdl, "create_rwa_config", {
      issuer, platform_config: platformConfigAddress(), launch: a.launch, quote_mint: quoteMint, quote_token: quoteTokenAddress(quoteMint),
      aegis_authority: a.authority, meteora_config: meteoraConfig, meteora_dbc_program: METEORA_DBC_PROGRAM_ID, meteora_event_authority: eventAuthority(),
      aegis_hook_program: AEGIS_HOOK_PROGRAM_ID, system_program: SystemProgram.programId,
    }, borsh.concat(
      borsh.u128(t.sqrtStartPrice), borsh.u32(t.sqrtExpansionBps), u64(t.targetRaise), borsh.u8(t.archetype), borsh.u8(t.migrationFeePct),
      borsh.u8(t.issuerPermanentLockPct), borsh.u8(t.issuerVestedPct), borsh.u16(t.vestingMonths), borsh.u16(t.poolFeeBps),
    )),
  ];
}

export function meteoraPoolAddress(config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey) {
  const [hi, lo] = Buffer.compare(baseMint.toBuffer(), quoteMint.toBuffer()) > 0 ? [baseMint, quoteMint] : [quoteMint, baseMint];
  return pda([text("pool"), config.toBytes(), hi.toBytes(), lo.toBytes()], METEORA_DBC_PROGRAM_ID);
}

/** What opening the sale needs to know about a launch, before or after its terms are on-chain. */
export type OpenTarget = Pick<LaunchAccount, "realRwaMint" | "meteoraConfig" | "quoteMint" | "escrowVault" | "vaultGroup" | "investorGroup">;

export function openInstructions(launch: OpenTarget, issuer: PublicKey, crwaMint: PublicKey, quoteProgram: PublicKey, wrapper: { name: string; symbol: string; uri: string }): TransactionInstruction[] {
  const a = issueAddresses(launch.realRwaMint, issuer);
  const pool = meteoraPoolAddress(launch.meteoraConfig, crwaMint, launch.quoteMint);
  return [
    idlInstruction(aegisIdl, "launch_pool", {
      issuer, platform_config: platformConfigAddress(), launch: a.launch, real_rwa_mint: launch.realRwaMint, aegis_authority: a.authority,
      escrow_vault: launch.escrowVault, access_control: a.accessControl, transfer_restriction_data: a.trd, vault_saa: a.vaultSaa,
      redeem_rule: a.rule(launch.vaultGroup, launch.investorGroup), meteora_config: launch.meteoraConfig, pool_authority: poolAuthority(),
      crwa_mint: crwaMint, quote_mint: launch.quoteMint, pool, base_vault: tokenVault(crwaMint, pool), quote_vault: tokenVault(launch.quoteMint, pool),
      meteora_event_authority: eventAuthority(), meteora_dbc_program: METEORA_DBC_PROGRAM_ID, aegis_hook_program: AEGIS_HOOK_PROGRAM_ID,
      extra_account_meta_list: pda([text("extra-account-metas"), crwaMint.toBytes()], AEGIS_HOOK_PROGRAM_ID),
      token_quote_program: quoteProgram, token_program: TOKEN_2022_PROGRAM_ID, system_program: SystemProgram.programId,
    }, borsh.concat(borsh.string(wrapper.name), borsh.string(wrapper.symbol), borsh.string(wrapper.uri))),
  ];
}

/** Cancels a launch before its sale opens, returning the whole escrow to the issuer. */
export function abortInstructions(launch: LaunchAccount, issuer: PublicKey): TransactionInstruction[] {
  const a = issueAddresses(launch.realRwaMint, issuer);
  return [
    idlInstruction(aegisIdl, "abort_launch", {
      issuer, launch: a.launch, real_rwa_mint: launch.realRwaMint, aegis_authority: a.authority, escrow_vault: launch.escrowVault,
      issuer_real_rwa_account: a.issuerAccount, access_control: a.accessControl, transfer_restriction_data: a.trd, vault_saa: a.vaultSaa,
      issuer_saa: a.issuerSaa, redeem_rule: a.rule(launch.vaultGroup, launch.investorGroup), real_rwa_extra_metas: a.extraMetas,
      transfer_restrictions_program: TRANSFER_RESTRICTIONS_PROGRAM_ID, token_program: TOKEN_2022_PROGRAM_ID,
    }),
  ];
}

/** Upside's `holder_ids` counter: the next holder number it will accept. */
export async function nextHolderIdFor(connection: Connection, mint: PublicKey): Promise<bigint> {
  const trd = pda([text("trd"), mint.toBytes()], TRANSFER_RESTRICTIONS_PROGRAM_ID);
  const info = await connection.getAccountInfo(trd, "confirmed");
  if (!info || !info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) || info.data.length < 88) throw new Error("The holder register couldn’t be read.");
  return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(80, true);
}

// ------------------------------------------------------------------------------------------------
// Progress
// ------------------------------------------------------------------------------------------------

export const STEP_IDS = ["create", "register", "groups", "vault", "yourself", "fund", "terms", "open"] as const;
export type StepId = (typeof STEP_IDS)[number];

export type IssueProgress = { launch: LaunchAccount | null; done: Record<StepId, boolean>; next: StepId | null; aborted: boolean };

const STAGE_RANK = { TokenCreated: 0, Funded: 1, Configured: 2, Live: 3, Graduated: 4, Aborted: -1 } as const;

export async function loadIssueProgress(connection: Connection, mint: PublicKey, issuer: PublicKey): Promise<IssueProgress> {
  const a = issueAddresses(mint, issuer);
  const keys = [a.launch, a.trd, a.extraMetas, a.group(INVESTOR_GROUP), a.group(VAULT_GROUP), a.redeemRule, a.depositRule, a.vaultSaa, a.issuerSaa];
  const [launchInfo, trd, metas, g1, g2, r1, r2, vaultSaa, issuerSaa] = await connection.getMultipleAccountsInfo(keys, "confirmed");
  const upside = (i: typeof trd) => Boolean(i && i.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID));
  const launch = launchInfo && launchInfo.owner.equals(AEGIS_PROGRAM_ID) ? decodeLaunch(a.launch, launchInfo.data) : null;
  const rank = launch ? STAGE_RANK[launch.stage] : -1;
  const done: Record<StepId, boolean> = {
    create: Boolean(launch),
    register: upside(trd) && upside(metas),
    groups: upside(g1) && upside(g2) && upside(r1) && upside(r2),
    vault: upside(vaultSaa),
    yourself: upside(issuerSaa),
    fund: rank >= 1,
    terms: rank >= 2,
    open: rank >= 3,
  };
  return { launch, done, next: STEP_IDS.find((s) => !done[s]) ?? null, aborted: launch?.stage === "Aborted" };
}

// ------------------------------------------------------------------------------------------------
// One approval for the whole launch
// ------------------------------------------------------------------------------------------------

/**
 * Compute budgets per step when they are signed together. Only the first can be simulated (the rest
 * depend on it landing), so each carries a fixed limit: measured use on a local node x ~1.5.
 * Measured: create 99.7k, register 27k, groups 51.7k, vault 71.8k, yourself 67k, fund 71.4k,
 * terms 77.2k, open 136.2k.
 */
export const STEP_UNITS: Record<StepId, number> = {
  create: 150_000, register: 60_000, groups: 100_000, vault: 120_000, yourself: 120_000, fund: 120_000, terms: 150_000, open: 220_000,
};

export type LaunchPlan = {
  mint: PublicKey;
  issuer: PublicKey;
  feeRecipient: PublicKey;
  /** Needed only if the security isn't created yet. */
  create?: { keypair: Keypair; details: AssetDetails };
  /** Needed only if the terms aren't fixed yet. */
  terms?: { quoteMint: PublicKey; terms: Terms };
  quoteProgram: PublicKey;
  decimals: number;
  wrapper: { name: string; symbol: string; uri: string };
  /** The next holder number Upside will accept; 0 before the register exists. */
  firstHolderId: bigint;
  /** On-chain facts once they exist; otherwise derived for this plan. */
  existing: { meteoraConfig: PublicKey; quoteMint: PublicKey } | null;
};

/**
 * Every step still to do, as signed-by-keypairs transactions sharing one blockhash, in order.
 * The wallet signs them all at once; they are then sent one after another.
 */
/**
 * The launch's transactions, in order. With `nonces`, step i starts by advancing nonces[i] and uses
 * its value in place of a blockhash, so the batch doesn't expire while a wallet previews it; see
 * chain/nonce. Without them it uses `blockhash`, which lasts about a minute.
 */
export function launchTransactions(plan: LaunchPlan, remaining: StepId[], blockhash: string, nonces?: Nonce[]): { id: StepId; tx: VersionedTransaction }[] {
  const { mint, issuer } = plan;
  const a = issueAddresses(mint, issuer);
  const config = plan.terms ? Keypair.generate() : null;
  const crwa = Keypair.generate();
  const target: OpenTarget = {
    realRwaMint: mint,
    escrowVault: a.escrowVault,
    vaultGroup: VAULT_GROUP,
    investorGroup: INVESTOR_GROUP,
    meteoraConfig: plan.existing?.meteoraConfig ?? config?.publicKey ?? PublicKey.default,
    quoteMint: plan.existing?.quoteMint ?? plan.terms?.quoteMint ?? PublicKey.default,
  };
  let holder = plan.firstHolderId;
  const build = (id: StepId): { ixs: TransactionInstruction[]; signers: Keypair[] } => {
    switch (id) {
      case "create": return { ixs: createInstructions(mint, issuer, plan.feeRecipient, plan.create!.details), signers: [plan.create!.keypair] };
      case "register": return { ixs: registerInstructions(mint, issuer), signers: [] };
      case "groups": return { ixs: groupInstructions(mint, issuer), signers: [] };
      case "vault": return { ixs: holderInstructions(mint, issuer, a.authority, VAULT_GROUP, holder++), signers: [] };
      case "yourself": return { ixs: holderInstructions(mint, issuer, issuer, INVESTOR_GROUP, holder++), signers: [] };
      case "fund": return { ixs: fundInstructions(mint, issuer), signers: [] };
      case "terms": return { ixs: termsInstructions(mint, issuer, plan.terms!.quoteMint, config!.publicKey, plan.terms!.terms, plan.decimals), signers: [config!] };
      case "open": return { ixs: openInstructions(target, issuer, crwa.publicKey, plan.quoteProgram, plan.wrapper), signers: [crwa] };
    }
  };
  return remaining.map((id, i) => {
    const { ixs, signers } = build(id);
    const nonce = nonces?.[i];
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: STEP_UNITS[id] + (nonce ? NONCE_UNITS : 0) }), ...ixs];
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: issuer,
        recentBlockhash: nonce ? nonce.value : blockhash,
        // The nonce advance has to be the very first instruction.
        instructions: nonce ? [advanceInstruction(nonce, issuer), ...instructions] : instructions,
      }).compileToV0Message()
    );
    if (signers.length) tx.sign(signers);
    return { id, tx };
  });
}
