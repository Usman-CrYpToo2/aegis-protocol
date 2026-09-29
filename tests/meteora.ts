/**
 * Meteora DBC instruction building.
 *
 * Meteora does not publish an IDL for the bonding-curve program, so the swap is encoded by hand
 * against the pinned source revision (`f552f20`). Account order and argument layout come from
 * `instructions/swap/ix_swap2_with_transfer_hook.rs` and `process_swap.rs`.
 *
 * A cRWA pool carries a transfer hook, so trades must use `swap2_with_transfer_hook` rather than
 * the ordinary `swap`. That variant needs the hook's accounts appended as remaining accounts and
 * described by a slice table, which is the single most common way a hooked launch ends up
 * untradeable.
 */
import { createHash } from "crypto";
import {
  AccountMeta,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { METEORA_DBC_PROGRAM_ID } from "./helpers";

/** Anchor's instruction discriminator: the first eight bytes of sha256("global:<name>"). */
export function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export const SWAP_MODE = {
  /** Spend exactly `amountIn`, receive at least `minimumAmountOut`. */
  ExactIn: 0,
  PartialFill: 1,
  ExactOut: 2,
} as const;

/** Mirrors `AccountsType` in Meteora's `utils/remaining_accounts.rs`. */
export const ACCOUNTS_TYPE = {
  TransferHookBase: 0,
  TransferHookBaseReferral: 1,
} as const;

function u64le(v: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

/**
 * `swap2_with_transfer_hook`.
 *
 * The trailing `[hookProgram, extraAccountMetaList]` pair is what lets Token-2022 resolve and
 * invoke the hook. Meteora finds them through the slice table in the instruction data rather
 * than by position, so the declared length has to match what is actually appended.
 */
export function swapWithTransferHookIx(opts: {
  config: PublicKey;
  pool: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  payer: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
  poolAuthority: PublicKey;
  eventAuthority: PublicKey;
  hookProgram: PublicKey;
  extraAccountMetaList: PublicKey;
  amountIn: bigint | number;
  minimumAmountOut?: bigint | number;
  /**
   * `ExactIn` spends the full amount and fails if the curve cannot absorb it. `PartialFill`
   * takes only what fits, which is what a buy that would tip the curve past its raise target
   * needs — otherwise the last purchase of a sale can never succeed.
   */
  swapMode?: number;
  /** Omit the hook accounts, to prove the transfer genuinely depends on them. */
  omitHookAccounts?: boolean;
}): TransactionInstruction {
  const hookAccounts: AccountMeta[] = opts.omitHookAccounts
    ? []
    : [
        { pubkey: opts.hookProgram, isSigner: false, isWritable: false },
        {
          pubkey: opts.extraAccountMetaList,
          isSigner: false,
          isWritable: false,
        },
      ];

  const slices = opts.omitHookAccounts
    ? []
    : [{ type: ACCOUNTS_TYPE.TransferHookBase, length: hookAccounts.length }];

  // SwapParameters2 { amount_0, amount_1, swap_mode } then
  // TransferHookAccountsInfo { slices: Vec<RemainingAccountsSlice { accounts_type, length }> }
  const sliceBytes = Buffer.alloc(4 + slices.length * 2);
  sliceBytes.writeUInt32LE(slices.length, 0);
  slices.forEach((s, i) => {
    sliceBytes.writeUInt8(s.type, 4 + i * 2);
    sliceBytes.writeUInt8(s.length, 5 + i * 2);
  });

  const data = Buffer.concat([
    anchorDiscriminator("swap2_with_transfer_hook"),
    u64le(opts.amountIn),
    u64le(opts.minimumAmountOut ?? 0),
    Buffer.from([opts.swapMode ?? SWAP_MODE.ExactIn]),
    sliceBytes,
  ]);

  const keys: AccountMeta[] = [
    { pubkey: opts.poolAuthority, isSigner: false, isWritable: false },
    { pubkey: opts.config, isSigner: false, isWritable: false },
    { pubkey: opts.pool, isSigner: false, isWritable: true },
    { pubkey: opts.inputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: opts.outputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: opts.baseVault, isSigner: false, isWritable: true },
    { pubkey: opts.quoteVault, isSigner: false, isWritable: true },
    // Mutable because Meteora revokes the transfer hook from the mint on the swap that
    // completes the curve.
    { pubkey: opts.baseMint, isSigner: false, isWritable: true },
    { pubkey: opts.quoteMint, isSigner: false, isWritable: false },
    { pubkey: opts.payer, isSigner: true, isWritable: false },
    { pubkey: opts.tokenBaseProgram, isSigner: false, isWritable: false },
    { pubkey: opts.tokenQuoteProgram, isSigner: false, isWritable: false },
    // Optional referral account. Anchor reads the program's own id as "None".
    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false },
    // Appended by #[event_cpi].
    { pubkey: opts.eventAuthority, isSigner: false, isWritable: false },
    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false },
    ...hookAccounts,
  ];

  return new TransactionInstruction({
    programId: METEORA_DBC_PROGRAM_ID,
    keys,
    data,
  });
}

export { SYSVAR_INSTRUCTIONS_PUBKEY };

// ======================================================================
// DAMM v2 — the AMM a completed curve migrates into.
// ======================================================================

export const DAMM_V2_PROGRAM_ID = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
);

/**
 * A Meteora-owned "dynamic config" whose pool creator authority is DBC's pool authority.
 *
 * Migration under the customizable fee option routes through `initialize_pool_with_dynamic_config`,
 * which only accepts a config of that type created by Meteora's own operators. Seven such configs
 * exist on mainnet; this is the one with `config_type = 1`.
 */
export const DAMM_V2_DYNAMIC_CONFIG = new PublicKey(
  "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck"
);

/** DAMM v2 uses the same seed vocabulary as DBC. */
export const dammV2 = {
  poolAuthority: () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("pool_authority")],
      DAMM_V2_PROGRAM_ID
    )[0],

  eventAuthority: () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      DAMM_V2_PROGRAM_ID
    )[0],

  pool: (config: PublicKey, tokenA: PublicKey, tokenB: PublicKey) => {
    const [hi, lo] =
      Buffer.compare(tokenA.toBuffer(), tokenB.toBuffer()) > 0
        ? [tokenA, tokenB]
        : [tokenB, tokenA];
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), config.toBuffer(), hi.toBuffer(), lo.toBuffer()],
      DAMM_V2_PROGRAM_ID
    )[0];
  },

  position: (positionNftMint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), positionNftMint.toBuffer()],
      DAMM_V2_PROGRAM_ID
    )[0],

  positionNftAccount: (positionNftMint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position_nft_account"), positionNftMint.toBuffer()],
      DAMM_V2_PROGRAM_ID
    )[0],

  tokenVault: (mint: PublicKey, pool: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()],
      DAMM_V2_PROGRAM_ID
    )[0],
};

/**
 * `migration_damm_v2` — moves a completed curve into the AMM.
 *
 * Permissionless: the only signers are whoever pays and two fresh keypairs for the liquidity
 * position NFTs. Who calls it does not change who receives the positions — those go to the
 * config's fee claimer and the pool creator regardless.
 */
export function migrateDammV2Ix(opts: {
  virtualPool: PublicKey;
  config: PublicKey;
  dbcPoolAuthority: PublicKey;
  dammPool: PublicKey;
  firstPositionNftMint: PublicKey;
  secondPositionNftMint: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  dbcBaseVault: PublicKey;
  dbcQuoteVault: PublicKey;
  payer: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
  token2022Program: PublicKey;
  dammConfig?: PublicKey;
}): TransactionInstruction {
  const dammConfig = opts.dammConfig ?? DAMM_V2_DYNAMIC_CONFIG;
  const ro = (pubkey: PublicKey): AccountMeta => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  });
  const rw = (pubkey: PublicKey): AccountMeta => ({
    pubkey,
    isSigner: false,
    isWritable: true,
  });

  const keys: AccountMeta[] = [
    rw(opts.virtualPool),
    // `migration_metadata` is deprecated and unread; any account satisfies it.
    ro(METEORA_DBC_PROGRAM_ID),
    ro(opts.config),
    rw(opts.dbcPoolAuthority),
    rw(opts.dammPool),
    { pubkey: opts.firstPositionNftMint, isSigner: true, isWritable: true },
    rw(dammV2.positionNftAccount(opts.firstPositionNftMint)),
    rw(dammV2.position(opts.firstPositionNftMint)),
    { pubkey: opts.secondPositionNftMint, isSigner: true, isWritable: true },
    rw(dammV2.positionNftAccount(opts.secondPositionNftMint)),
    rw(dammV2.position(opts.secondPositionNftMint)),
    ro(dammV2.poolAuthority()),
    ro(DAMM_V2_PROGRAM_ID),
    rw(opts.baseMint),
    rw(opts.quoteMint),
    rw(dammV2.tokenVault(opts.baseMint, opts.dammPool)),
    rw(dammV2.tokenVault(opts.quoteMint, opts.dammPool)),
    rw(opts.dbcBaseVault),
    rw(opts.dbcQuoteVault),
    { pubkey: opts.payer, isSigner: true, isWritable: true },
    ro(opts.tokenBaseProgram),
    ro(opts.tokenQuoteProgram),
    ro(opts.token2022Program),
    ro(dammV2.eventAuthority()),
    ro(SystemProgram.programId),
    // remaining[0]: the DAMM v2 config to build the pool from
    ro(dammConfig),
  ];

  return new TransactionInstruction({
    programId: METEORA_DBC_PROGRAM_ID,
    keys,
    data: anchorDiscriminator("migration_damm_v2"),
  });
}

/**
 * `withdraw_leftover` — releases the wrapper a completed curve never sold.
 *
 * Takes no signer whatsoever: anyone may call it. The destination is forced to be the
 * associated account of the config's recorded leftover receiver, so the tokens can only ever
 * reach that party — but the call sets a one-way flag, and a second call reverts.
 */
export function withdrawLeftoverIx(opts: {
  poolAuthority: PublicKey;
  config: PublicKey;
  virtualPool: PublicKey;
  tokenBaseAccount: PublicKey;
  baseVault: PublicKey;
  baseMint: PublicKey;
  leftoverReceiver: PublicKey;
  tokenBaseProgram: PublicKey;
  eventAuthority: PublicKey;
}): TransactionInstruction {
  const ro = (pubkey: PublicKey): AccountMeta => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  });
  const rw = (pubkey: PublicKey): AccountMeta => ({
    pubkey,
    isSigner: false,
    isWritable: true,
  });

  return new TransactionInstruction({
    programId: METEORA_DBC_PROGRAM_ID,
    keys: [
      ro(opts.poolAuthority),
      ro(opts.config),
      rw(opts.virtualPool),
      rw(opts.tokenBaseAccount),
      rw(opts.baseVault),
      ro(opts.baseMint),
      ro(opts.leftoverReceiver),
      ro(opts.tokenBaseProgram),
      // appended by #[event_cpi]
      ro(opts.eventAuthority),
      ro(METEORA_DBC_PROGRAM_ID),
    ],
    data: anchorDiscriminator("withdraw_leftover"),
  });
}
