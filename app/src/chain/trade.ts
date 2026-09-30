/**
 * Builds a buy or sell on an open Aegis offering: Meteora DBC `swap2_with_transfer_hook`.
 *
 * Account order and data layout match the pinned DBC source (ix_swap2_with_transfer_hook.rs) and
 * the builder the program's test suite trades with (tests/meteora.ts). Every account the
 * instruction touches is either derived here or checked against what the pool records, so a
 * tampered pool account cannot redirect funds.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getTransferHook,
  unpackMint,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";
import type { LaunchAccount } from "./aegis";
import { METEORA_DBC_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./ids";
import type { DbcPool } from "./meteora";

export type Side = "buy" | "sell";

/** DBC SwapMode. Buys use PartialFill so the one that completes the sale still succeeds. */
const SWAP_MODE = { ExactIn: 0, PartialFill: 1 } as const;
/** DBC AccountsType::TransferHookBase. */
const TRANSFER_HOOK_BASE = 0;

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const poolAuthority = () => pda([Buffer.from("pool_authority")], METEORA_DBC_PROGRAM_ID);
export const eventAuthority = () => pda([Buffer.from("__event_authority")], METEORA_DBC_PROGRAM_ID);
export const tokenVault = (mint: PublicKey, pool: PublicKey) => pda([Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()], METEORA_DBC_PROGRAM_ID);

/** sha256("global:swap2_with_transfer_hook")[..8], precomputed so the browser needs no hashing.
 *  trade.test.ts recomputes it. */
export const SWAP2_WITH_TRANSFER_HOOK = Uint8Array.from([0xb7, 0x5d, 0x99, 0x28, 0x18, 0xe6, 0xc2, 0x97]);

function u64(value: bigint) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, value, true);
  return b;
}

export type TradeAccounts = {
  quoteProgram: PublicKey;
  hookProgram: PublicKey;
  extraAccountMetaList: PublicKey;
};

/**
 * Reads what the swap needs beyond the launch itself: which token program the quote mint uses and
 * which hook program the wrapper carries. The hook is read from the mint, not assumed.
 */
export async function loadTradeAccounts(connection: Connection, launch: LaunchAccount): Promise<TradeAccounts> {
  const [crwaInfo, quoteInfo] = await connection.getMultipleAccountsInfo([launch.crwaMint, launch.quoteMint], "confirmed");
  if (!crwaInfo || !quoteInfo) throw new Error("The token accounts for this sale could not be read.");
  const crwa = unpackMint(launch.crwaMint, crwaInfo as AccountInfo<Buffer>, TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(crwa);
  if (!hook || hook.programId.equals(PublicKey.default)) {
    throw new Error("This sale has closed: the wrapper no longer carries its sale-time transfer hook.");
  }
  return {
    quoteProgram: quoteInfo.owner,
    hookProgram: hook.programId,
    extraAccountMetaList: pda([Buffer.from("extra-account-metas"), launch.crwaMint.toBuffer()], hook.programId),
  };
}

export type TradeRequest = {
  launch: LaunchAccount;
  pool: DbcPool;
  accounts: TradeAccounts;
  owner: PublicKey;
  side: Side;
  /** Atoms of what is paid in: quote for a buy, wrapper for a sell. */
  amountIn: bigint;
  /** The least the user accepts to receive, after slippage. */
  minimumOut: bigint;
};

export function tradeInstructions({ launch, pool, accounts, owner, side, amountIn, minimumOut }: TradeRequest): TransactionInstruction[] {
  const baseVault = tokenVault(launch.crwaMint, launch.virtualPool);
  const quoteVault = tokenVault(launch.quoteMint, launch.virtualPool);
  if (!pool.baseVault.equals(baseVault) || !pool.quoteVault.equals(quoteVault)) {
    throw new Error("The pool's vaults don't match Meteora's addresses for this sale. Refusing to trade.");
  }

  const userQuote = getAssociatedTokenAddressSync(launch.quoteMint, owner, false, accounts.quoteProgram);
  const userBase = getAssociatedTokenAddressSync(launch.crwaMint, owner, false, TOKEN_2022_PROGRAM_ID);
  const [input, output] = side === "buy" ? [userQuote, userBase] : [userBase, userQuote];

  // The receiving account may not exist yet; creating it is a no-op when it does.
  const createOutput =
    side === "buy"
      ? createAssociatedTokenAccountIdempotentInstruction(owner, userBase, owner, launch.crwaMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
      : createAssociatedTokenAccountIdempotentInstruction(owner, userQuote, owner, launch.quoteMint, accounts.quoteProgram, ASSOCIATED_TOKEN_PROGRAM_ID);

  // SwapParameters2 { amount_0, amount_1, swap_mode } + TransferHookAccountsInfo { slices }.
  const data = new Uint8Array(8 + 8 + 8 + 1 + 4 + 2);
  data.set(SWAP2_WITH_TRANSFER_HOOK, 0);
  data.set(u64(amountIn), 8);
  data.set(u64(minimumOut), 16);
  data[24] = side === "buy" ? SWAP_MODE.PartialFill : SWAP_MODE.ExactIn;
  new DataView(data.buffer).setUint32(25, 1, true); // one slice
  data[29] = TRANSFER_HOOK_BASE;
  data[30] = 2; // [hook program, extra account meta list]

  const swap = new TransactionInstruction({
    programId: METEORA_DBC_PROGRAM_ID,
    data: Buffer.from(data),
    keys: [
      { pubkey: poolAuthority(), isSigner: false, isWritable: false },
      { pubkey: launch.meteoraConfig, isSigner: false, isWritable: false },
      { pubkey: launch.virtualPool, isSigner: false, isWritable: true },
      { pubkey: input, isSigner: false, isWritable: true },
      { pubkey: output, isSigner: false, isWritable: true },
      { pubkey: baseVault, isSigner: false, isWritable: true },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      // Writable: Meteora revokes the transfer hook on the swap that completes the curve.
      { pubkey: launch.crwaMint, isSigner: false, isWritable: true },
      { pubkey: launch.quoteMint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: accounts.quoteProgram, isSigner: false, isWritable: false },
      // No referral: Anchor reads the program's own id as None.
      { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority(), isSigner: false, isWritable: false },
      { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: accounts.hookProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.extraAccountMetaList, isSigner: false, isWritable: false },
    ],
  });

  return [createOutput, swap];
}

export type PreparedTrade = { transaction: VersionedTransaction; blockhash: string; lastValidBlockHeight: number };

export class SimulationError extends Error {
  constructor(public readonly logs: string[], message: string) {
    super(message);
  }
}

/**
 * Simulates first, so a trade that would fail is explained before the wallet is ever opened, and
 * so the compute limit can be sized to what the swap really uses (plus headroom).
 */
export async function prepareTrade(connection: Connection, request: TradeRequest): Promise<PreparedTrade> {
  const instructions = tradeInstructions(request);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const build = (units: number) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: request.owner,
        recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions],
      }).compileToV0Message()
    );

  const sim = await connection.simulateTransaction(build(1_400_000), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  if (sim.value.err) {
    throw new SimulationError(sim.value.logs ?? [], typeof sim.value.err === "string" ? sim.value.err : JSON.stringify(sim.value.err));
  }
  const used = sim.value.unitsConsumed ?? 400_000;
  return { transaction: build(Math.min(1_400_000, Math.ceil(used * 1.2) + 10_000)), blockhash, lastValidBlockHeight };
}
