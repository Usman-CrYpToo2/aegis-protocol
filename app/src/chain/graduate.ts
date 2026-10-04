/**
 * Graduation: once a sale fills, two permissionless transactions finish it. Anyone may send
 * them; whoever does pays the new accounts' deposits, and who sends them changes nothing else.
 *
 *   1 migrate   Meteora DBC `migration_damm_v2`: the curve's funds become a permanent DAMM v2
 *               pool. Account order follows tests/meteora.ts `migrateDammV2Ix`, which the
 *               program's own lifecycle tests run against the pinned Meteora programs.
 *   2 finalize  Aegis `finalize_graduation`: settles the launch and opens the bridge.
 */
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import aegisIdl from "../idl/aegis.json";
import type { LaunchAccount } from "./aegis";
import { idlInstruction } from "./idlix";
import { METEORA_DBC_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./ids";
import { advanceInstruction, NONCE_UNITS, type Nonce } from "./nonce";
import { issueAddresses } from "./issue";
import type { DbcConfig, DbcPool } from "./meteora";
import { eventAuthority, poolAuthority, tokenVault } from "./trade";

export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/**
 * The Meteora-owned DAMM v2 config a customizable-fee migration builds its pool from (one whose
 * pool creator authority is DBC's pool authority). Mainnet address, cloned onto the local node.
 */
export const DAMM_V2_MIGRATION_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const text = (s: string) => new TextEncoder().encode(s);
const damm = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, DAMM_V2_PROGRAM_ID)[0];

export function dammPoolAddress(tokenA: PublicKey, tokenB: PublicKey, config = DAMM_V2_MIGRATION_CONFIG) {
  const [hi, lo] = Buffer.compare(tokenA.toBuffer(), tokenB.toBuffer()) > 0 ? [tokenA, tokenB] : [tokenB, tokenA];
  return damm([text("pool"), config.toBytes(), hi.toBytes(), lo.toBytes()]);
}

/** sha256("global:migration_damm_v2")[..8]; graduate.test.ts recomputes it. */
export const MIGRATION_DAMM_V2 = Uint8Array.from([156, 169, 230, 103, 53, 228, 80, 64]);

export function migrateInstruction(launch: LaunchAccount, payer: PublicKey, firstNft: PublicKey, secondNft: PublicKey, quoteProgram: PublicKey): TransactionInstruction {
  const base = launch.crwaMint;
  const quote = launch.quoteMint;
  const pool = dammPoolAddress(base, quote);
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const nft = (mint: PublicKey) => [
    { pubkey: mint, isSigner: true, isWritable: true },
    w(damm([text("position_nft_account"), mint.toBytes()])),
    w(damm([text("position"), mint.toBytes()])),
  ];
  return new TransactionInstruction({
    programId: METEORA_DBC_PROGRAM_ID,
    data: Buffer.from(MIGRATION_DAMM_V2),
    keys: [
      w(launch.virtualPool),
      r(METEORA_DBC_PROGRAM_ID), // migration_metadata: deprecated and unread
      r(launch.meteoraConfig),
      w(poolAuthority()),
      w(pool),
      ...nft(firstNft),
      ...nft(secondNft),
      r(damm([text("pool_authority")])),
      r(DAMM_V2_PROGRAM_ID),
      w(base),
      w(quote),
      w(damm([text("token_vault"), base.toBytes(), pool.toBytes()])),
      w(damm([text("token_vault"), quote.toBytes(), pool.toBytes()])),
      w(tokenVault(base, launch.virtualPool)),
      w(tokenVault(quote, launch.virtualPool)),
      { pubkey: payer, isSigner: true, isWritable: true },
      r(TOKEN_2022_PROGRAM_ID),
      r(quoteProgram),
      r(TOKEN_2022_PROGRAM_ID),
      r(damm([text("__event_authority")])),
      r(SystemProgram.programId),
      r(DAMM_V2_MIGRATION_CONFIG), // remaining[0]: the DAMM v2 config
    ],
  });
}

export function finalizeInstruction(launch: LaunchAccount, cranker: PublicKey): TransactionInstruction {
  const a = issueAddresses(launch.realRwaMint, launch.issuer);
  return idlInstruction(aegisIdl, "finalize_graduation", {
    cranker, launch: launch.address, real_rwa_mint: launch.realRwaMint, crwa_mint: launch.crwaMint, aegis_authority: a.authority,
    aegis_crwa_account: getAssociatedTokenAddressSync(launch.crwaMint, a.authority, true, TOKEN_2022_PROGRAM_ID), escrow_vault: launch.escrowVault,
    pool_authority: poolAuthority(), meteora_config: launch.meteoraConfig, virtual_pool: launch.virtualPool,
    base_vault: tokenVault(launch.crwaMint, launch.virtualPool), meteora_event_authority: eventAuthority(), meteora_dbc_program: METEORA_DBC_PROGRAM_ID,
    token_program: TOKEN_2022_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
  });
}

export type GraduationStep = "selling" | "migrate" | "finalize" | "done";

/** Where a launch stands on the way from a filled sale to an open bridge. */
export function graduationStep(launch: LaunchAccount, pool: DbcPool | null | undefined, terms: DbcConfig | null | undefined): GraduationStep {
  if (launch.stage === "Graduated") return "done";
  if (launch.stage !== "Live" || !pool || !terms) return "selling";
  if (pool.isMigrated) return "finalize";
  return pool.quoteReserve >= terms.migrationQuoteThreshold ? "migrate" : "selling";
}

/**
 * Compute budgets for the two graduation transactions when they ride along with the buy that fills
 * the sale. They can't be simulated in advance (they depend on that buy landing), so they carry
 * fixed limits measured on a local node (282k and 86k units used) with headroom.
 */
export const GRADUATION_UNITS = { migrate: 400_000, finalize: 150_000 } as const;
/** What graduating costs whoever sends it: the new pool's and positions' deposits (measured). */
export const GRADUATION_DEPOSIT_LAMPORTS = 35_000_000n;

/**
 * The two graduation transactions, unsigned by the payer, sharing `blockhash` with the buy they
 * follow so a wallet can approve all three at once. With `nonces` (one each, see chain/nonce) they
 * carry those instead, and don't expire while the wallet previews them.
 */
export function graduationTransactions(launch: LaunchAccount, payer: PublicKey, quoteProgram: PublicKey, blockhash: string, nonces?: [Nonce, Nonce]): VersionedTransaction[] {
  const nfts = [Keypair.generate(), Keypair.generate()];
  const tx = (units: number, ix: TransactionInstruction, nonce?: Nonce) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: nonce ? nonce.value : blockhash,
        instructions: nonce
          ? [advanceInstruction(nonce, payer), ComputeBudgetProgram.setComputeUnitLimit({ units: units + NONCE_UNITS }), ix]
          : [ComputeBudgetProgram.setComputeUnitLimit({ units }), ix],
      }).compileToV0Message()
    );
  const migrate = tx(GRADUATION_UNITS.migrate, migrateInstruction(launch, payer, nfts[0]!.publicKey, nfts[1]!.publicKey, quoteProgram), nonces?.[0]);
  migrate.sign(nfts);
  return [migrate, tx(GRADUATION_UNITS.finalize, finalizeInstruction(launch, payer), nonces?.[1])];
}
