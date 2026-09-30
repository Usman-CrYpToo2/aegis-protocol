/**
 * The compliance setup an issuer performs through Upside, off-chain, between `create_rwa` and
 * `fund_vault`.
 *
 * Aegis deliberately does not do any of this on-chain: transfer groups and rules are regulatory
 * decisions belonging to the issuer of a security, and the issuer can rewrite them afterwards
 * regardless. Aegis only verifies the result at the points where acting on a broken setup would
 * cost someone money.
 *
 * This module is the reference implementation of that setup. The frontend wizard performs the
 * same sequence with the same accounts.
 */
import * as fs from "fs";
import * as path from "path";
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
export const REPO_ROOT = path.resolve(__dirname, "..");

const AC_IDL = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "idls/access_control.json"), "utf8")
);
const TR_IDL = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "idls/transfer_restrictions.json"),
    "utf8"
  )
);

export const ACCESS_CONTROL_PROGRAM_ID = new PublicKey(AC_IDL.address);
export const TRANSFER_RESTRICTIONS_PROGRAM_ID = new PublicKey(TR_IDL.address);

const offlineProvider = {
  publicKey: PublicKey.default,
  connection: {},
} as any;

export const accessControlProgram = new Program(AC_IDL, offlineProvider);
export const transferRestrictionsProgram = new Program(
  TR_IDL,
  offlineProvider
);

/** u64 little-endian, the encoding Upside uses for every numeric seed. */
export function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// ----------------------------------------------------------------------
// PDAs
// ----------------------------------------------------------------------

export const pda = {
  accessControl: (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("ac"), mint.toBuffer()],
      ACCESS_CONTROL_PROGRAM_ID
    )[0],

  walletRole: (mint: PublicKey, wallet: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("wallet_role"), mint.toBuffer(), wallet.toBuffer()],
      ACCESS_CONTROL_PROGRAM_ID
    )[0],

  /** The per-token rule book. */
  transferRestrictionData: (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("trd"), mint.toBuffer()],
      TRANSFER_RESTRICTIONS_PROGRAM_ID
    )[0],

  group: (trd: PublicKey, id: bigint | number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("trg"), trd.toBuffer(), u64le(id)],
      TRANSFER_RESTRICTIONS_PROGRAM_ID
    )[0],

  rule: (trd: PublicKey, from: bigint | number, to: bigint | number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("tr"), trd.toBuffer(), u64le(from), u64le(to)],
      TRANSFER_RESTRICTIONS_PROGRAM_ID
    )[0],

  holder: (trd: PublicKey, id: bigint | number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("trh"), trd.toBuffer(), u64le(id)],
      TRANSFER_RESTRICTIONS_PROGRAM_ID
    )[0],

  holderGroup: (holder: PublicKey, groupId: bigint | number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("trhg"), holder.toBuffer(), u64le(groupId)],
      TRANSFER_RESTRICTIONS_PROGRAM_ID
    )[0],

  /** Per-wallet permission record. Keyed on the token account, not the owner. */
  securityAssociatedAccount: (tokenAccount: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("saa"), tokenAccount.toBuffer()],
      TRANSFER_RESTRICTIONS_PROGRAM_ID
    )[0],

  /**
   * The hook's companion account. Token-2022 resolves the hook's extra accounts through this,
   * so without it every transfer of the token fails.
   */
  extraAccountMetaList: (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.toBuffer()],
      TRANSFER_RESTRICTIONS_PROGRAM_ID
    )[0],
};

export function ataFor(mint: PublicKey, owner: PublicKey): PublicKey {
  // `allowOwnerOffCurve` because the vault's owner is a program-derived address.
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
}

// ----------------------------------------------------------------------
// Instruction builders
// ----------------------------------------------------------------------

export const ix = {
  async initRuleBook(
    mint: PublicKey,
    authority: PublicKey,
    maxHolders: bigint | number
  ): Promise<TransactionInstruction> {
    const trd = pda.transferRestrictionData(mint);
    return transferRestrictionsProgram.methods
      .initializeTransferRestrictionsData(bn(maxHolders))
      .accountsPartial({
        transferRestrictionData: trd,
        // group 0 is created implicitly alongside the rule book
        zeroTransferRestrictionGroup: pda.group(trd, 0),
        mint,
        accessControlAccount: pda.accessControl(mint),
        authorityWalletRole: pda.walletRole(mint, authority),
        payer: authority,
        authority,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  },

  async initHookMetas(
    mint: PublicKey,
    authority: PublicKey
  ): Promise<TransactionInstruction> {
    return transferRestrictionsProgram.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        extraMetasAccount: pda.extraAccountMetaList(mint),
        securityMint: mint,
        authorityWalletRole: pda.walletRole(mint, authority),
        accessControl: pda.accessControl(mint),
        payer: authority,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  },

  async initGroup(
    mint: PublicKey,
    authority: PublicKey,
    id: bigint | number
  ): Promise<TransactionInstruction> {
    const trd = pda.transferRestrictionData(mint);
    return transferRestrictionsProgram.methods
      .initializeTransferRestrictionGroup(bn(id))
      .accountsPartial({
        transferRestrictionGroup: pda.group(trd, id),
        transferRestrictionData: trd,
        accessControlAccount: pda.accessControl(mint),
        authorityWalletRole: pda.walletRole(mint, authority),
        authority,
        payer: authority,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  },

  /**
   * `lockUntil` is a sentinel: 0 forbids the transfer, 1 allows it immediately, anything larger
   * is a unix timestamp the transfer must wait for.
   */
  async initRule(
    mint: PublicKey,
    authority: PublicKey,
    from: bigint | number,
    to: bigint | number,
    lockUntil: bigint | number
  ): Promise<TransactionInstruction> {
    const trd = pda.transferRestrictionData(mint);
    return transferRestrictionsProgram.methods
      .initializeTransferRule(bn(from), bn(to), bn(lockUntil))
      .accountsPartial({
        transferRule: pda.rule(trd, from, to),
        transferRestrictionData: trd,
        transferRestrictionGroupFrom: pda.group(trd, from),
        transferRestrictionGroupTo: pda.group(trd, to),
        accessControlAccount: pda.accessControl(mint),
        authorityWalletRole: pda.walletRole(mint, authority),
        authority,
        payer: authority,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  },

  async setRule(
    mint: PublicKey,
    authority: PublicKey,
    from: bigint | number,
    to: bigint | number,
    lockUntil: bigint | number
  ): Promise<TransactionInstruction> {
    const trd = pda.transferRestrictionData(mint);
    return transferRestrictionsProgram.methods
      .setAllowTransferRule(bn(from), bn(to), bn(lockUntil))
      .accountsPartial({
        transferRule: pda.rule(trd, from, to),
        transferRestrictionData: trd,
        transferRestrictionGroupFrom: pda.group(trd, from),
        transferRestrictionGroupTo: pda.group(trd, to),
        accessControlAccount: pda.accessControl(mint),
        authorityWalletRole: pda.walletRole(mint, authority),
        authority,
        payer: authority,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  },

  async pause(
    mint: PublicKey,
    authority: PublicKey,
    paused: boolean
  ): Promise<TransactionInstruction> {
    return transferRestrictionsProgram.methods
      .pause(paused)
      .accountsPartial({
        securityMint: mint,
        transferRestrictionData: pda.transferRestrictionData(mint),
        accessControlAccount: pda.accessControl(mint),
        authorityWalletRole: pda.walletRole(mint, authority),
        payer: authority,
      })
      .instruction();
  },

  /** Raises the supply cap. Upside only ever lets it go up, never down. ReserveAdmin only. */
  async setMaxTotalSupply(
    mint: PublicKey,
    authority: PublicKey,
    maxTotalSupply: bigint
  ): Promise<TransactionInstruction> {
    return accessControlProgram.methods
      .setMaxTotalSupply(bn(maxTotalSupply))
      .accountsPartial({
        accessControlAccount: pda.accessControl(mint),
        mint,
        authorityWalletRole: pda.walletRole(mint, authority),
        payer: authority,
      })
      .instruction();
  },

  async initHolder(
    mint: PublicKey,
    authority: PublicKey,
    holderId: bigint | number
  ): Promise<TransactionInstruction> {
    const trd = pda.transferRestrictionData(mint);
    return transferRestrictionsProgram.methods
      .initializeTransferRestrictionHolder(bn(holderId))
      .accountsPartial({
        transferRestrictionHolder: pda.holder(trd, holderId),
        transferRestrictionData: trd,
        accessControlAccount: pda.accessControl(mint),
        authorityWalletRole: pda.walletRole(mint, authority),
        authority,
        payer: authority,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  },

  async initHolderGroup(
    mint: PublicKey,
    authority: PublicKey,
    holderId: bigint | number,
    groupId: bigint | number
  ): Promise<TransactionInstruction> {
    const trd = pda.transferRestrictionData(mint);
    const holder = pda.holder(trd, holderId);
    return transferRestrictionsProgram.methods
      .initializeHolderGroup()
      .accountsPartial({
        holderGroup: pda.holderGroup(holder, groupId),
        transferRestrictionData: trd,
        group: pda.group(trd, groupId),
        holder,
        authorityWalletRole: pda.walletRole(mint, authority),
        authority,
        payer: authority,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  },

  /** Registers one token account as a permitted holder, in a given group. */
  async initSaa(
    mint: PublicKey,
    authority: PublicKey,
    walletOwner: PublicKey,
    groupId: bigint | number,
    holderId: bigint | number
  ): Promise<TransactionInstruction> {
    const trd = pda.transferRestrictionData(mint);
    const holder = pda.holder(trd, holderId);
    const ata = ataFor(mint, walletOwner);
    return transferRestrictionsProgram.methods
      .initializeSecurityAssociatedAccount(bn(groupId), bn(holderId))
      .accountsPartial({
        securityAssociatedAccount: pda.securityAssociatedAccount(ata),
        group: pda.group(trd, groupId),
        holder,
        holderGroup: pda.holderGroup(holder, groupId),
        securityToken: mint,
        transferRestrictionData: trd,
        userWallet: walletOwner,
        associatedTokenAccount: ata,
        authorityWalletRole: pda.walletRole(mint, authority),
        authority,
        payer: authority,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  },

  createAta(
    payer: PublicKey,
    mint: PublicKey,
    owner: PublicKey
  ): TransactionInstruction {
    return createAssociatedTokenAccountInstruction(
      payer,
      ataFor(mint, owner),
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  },
};

export type ComplianceLayout = {
  investorGroup: number;
  vaultGroup: number;
  maxHolders: number;
  /** Must be assigned sequentially from 0; Upside rejects ids beyond the next one. */
  vaultHolderId: number;
};

export const DEFAULT_LAYOUT: ComplianceLayout = {
  investorGroup: 1,
  vaultGroup: 2,
  // NOT unlimited. Upside checks `current_holders_count >= max_holders`, so 0 means no holder
  // may ever be registered — including our vault. The docs describe 0 as unlimited; the code
  // does not agree. Pick a real ceiling.
  maxHolders: 10_000,
  // Holder ids must be assigned sequentially from zero: `initialize_holder` rejects any id
  // greater than the registry's running `holder_ids` counter, which starts at 0.
  vaultHolderId: 0,
};

function bn(v: bigint | number) {
  const BN = require("bn.js");
  return new BN(v.toString());
}

/**
 * A raw Token-2022 `transfer_checked` for the Real RWA, with Upside's hook accounts appended.
 *
 * Order is dictated by `spl-transfer-hook-interface`: the four transfer accounts, then the
 * accounts the validation list resolves to, then the validation account, then the hook program.
 *
 * This is what any approved holder can do without involving Aegis at all — including sending
 * tokens straight into the escrow vault.
 */
export function transferRealRwaIx(opts: {
  mint: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
  fromGroup: bigint | number;
  toGroup: bigint | number;
}): TransactionInstruction {
  const trd = pda.transferRestrictionData(opts.mint);
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // TransferChecked
  data.writeBigUInt64LE(opts.amount, 1);
  data.writeUInt8(opts.decimals, 9);

  const ro = (pubkey: PublicKey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  });

  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: opts.source, isSigner: false, isWritable: true },
      ro(opts.mint),
      { pubkey: opts.destination, isSigner: false, isWritable: true },
      { pubkey: opts.owner, isSigner: true, isWritable: false },
      ro(trd),
      ro(pda.securityAssociatedAccount(opts.source)),
      ro(pda.securityAssociatedAccount(opts.destination)),
      ro(pda.rule(trd, opts.fromGroup, opts.toGroup)),
      ro(pda.extraAccountMetaList(opts.mint)),
      ro(TRANSFER_RESTRICTIONS_PROGRAM_ID),
    ],
    data,
  });
}
