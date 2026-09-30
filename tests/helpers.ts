/**
 * Shared LiteSVM harness for the Aegis test suite.
 *
 * Upside's Access Control and Transfer Restrictions programs are mainnet-only, so tests run
 * against the real mainnet binaries dumped into `programs/aegis/tests/fixtures`. That has a
 * useful side effect: our CPI bindings are generated from the IDLs in `idls/`, so if those ever
 * drift from the deployed code, these tests fail rather than the discrepancy reaching mainnet.
 */
import * as fs from "fs";
import * as path from "path";
import { Program } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import {
  Clock,
  FailedTransactionMetadata,
  LiteSVM,
  TransactionMetadata,
} from "litesvm";
import * as upside from "./upside";

export {
  ACCESS_CONTROL_PROGRAM_ID,
  REPO_ROOT,
  TRANSFER_RESTRICTIONS_PROGRAM_ID,
} from "./upside";

const REPO_ROOT = upside.REPO_ROOT;
const ACCESS_CONTROL_PROGRAM_ID = upside.ACCESS_CONTROL_PROGRAM_ID;
const TRANSFER_RESTRICTIONS_PROGRAM_ID = upside.TRANSFER_RESTRICTIONS_PROGRAM_ID;

export const SOL = 1_000_000_000n;

/**
 * LiteSVM starts its clock at zero. Several checks are time-sensitive — Upside's `locked_until`
 * is a unix timestamp — so tests run at a fixed, realistic point in time instead. Fixed rather
 * than `Date.now()` so failures reproduce exactly.
 */
export const TEST_UNIX_TIME = 1_800_000_000n; // 2027-01-15T08:00:00Z

export const AEGIS_IDL = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "target/idl/aegis.json"), "utf8")
);

export const AEGIS_PROGRAM_ID = new PublicKey(AEGIS_IDL.address);

export const AEGIS_HOOK_IDL = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "target/idl/aegis_hook.json"), "utf8")
);
export const AEGIS_HOOK_PROGRAM_ID = new PublicKey(AEGIS_HOOK_IDL.address);

/** Meteora Dynamic Bonding Curve, mainnet. */
export const METEORA_DBC_PROGRAM_ID = new PublicKey(
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
);

/** Upside role bitmask, mirroring `access_control::Roles`. */
export const ROLE = {
  CONTRACT_ADMIN: 1,
  RESERVE_ADMIN: 2,
  WALLETS_ADMIN: 4,
  TRANSFER_ADMIN: 8,
} as const;
export const ALL_ROLES =
  ROLE.CONTRACT_ADMIN |
  ROLE.RESERVE_ADMIN |
  ROLE.WALLETS_ADMIN |
  ROLE.TRANSFER_ADMIN;

/** Archetypes, as Anchor encodes a Rust enum in TypeScript. */
export const ARCHETYPE = {
  fixedPar: { fixedPar: {} },
  bookBuilding: { bookBuilding: {} },
  growthCapital: { growthCapital: {} },
} as const;

/** Sqrt price for 1.0, i.e. one quote atom per base atom. */
export const SQRT_PRICE_ONE = 1n << 64n;

export type CreateRwaConfigArgs = {
  sqrtStartPrice: bigint;
  sqrtExpansionBps: number;
  targetRaise: bigint | number;
  archetype: any;
  migrationFeePct: number;
  issuerPermanentLockPct: number;
  issuerVestedPct: number;
  vestingMonths: number;
  poolFeeBps: number;
};

export function defaultConfigArgs(
  overrides: Partial<CreateRwaConfigArgs> = {}
): CreateRwaConfigArgs {
  return {
    sqrtStartPrice: SQRT_PRICE_ONE,
    sqrtExpansionBps: 11_000, // ~1.21x price
    targetRaise: 100_000_000_000, // 100,000 USDC at 6dp
    archetype: ARCHETYPE.bookBuilding,
    migrationFeePct: 50,
    // The issuer's share of graduated liquidity is 100 - aegisLpSharePct, which defaults to 90.
    // These two must account for exactly that.
    issuerPermanentLockPct: 30,
    issuerVestedPct: 60,
    vestingMonths: 12,
    poolFeeBps: 100,
    ...overrides,
  };
}

export type CreateRwaArgs = {
  decimals: number;
  totalSupply: bigint | number;
  name: string;
  symbol: string;
  uri: string;
};

export function defaultRwaArgs(
  overrides: Partial<CreateRwaArgs> = {}
): CreateRwaArgs {
  return {
    decimals: 6,
    totalSupply: 1_000_000_000_000, // 1,000,000 tokens at 6 decimals
    name: "Aegis Tower A",
    symbol: "TWRA",
    uri: "https://aegis.test/twra.json",
    ...overrides,
  };
}

export class Env {
  svm: LiteSVM;
  program: Program<any>;
  admin: Keypair;
  issuer: Keypair;
  treasury: Keypair;
  outsider: Keypair;

  private constructor() {
    this.svm = new LiteSVM();

    const load = (id: PublicKey, p: string) => {
      const full = path.join(REPO_ROOT, p);
      if (!fs.existsSync(full)) {
        throw new Error(`missing ${p} — run \`anchor build\` first`);
      }
      this.svm.addProgramFromFile(id, full);
    };

    load(AEGIS_PROGRAM_ID, "target/deploy/aegis.so");
    load(
      ACCESS_CONTROL_PROGRAM_ID,
      "programs/aegis/tests/fixtures/access_control.so"
    );
    load(
      TRANSFER_RESTRICTIONS_PROGRAM_ID,
      "programs/aegis/tests/fixtures/transfer_restrictions.so"
    );
    load(AEGIS_HOOK_PROGRAM_ID, "target/deploy/aegis_hook.so");
    load(METEORA_DBC_PROGRAM_ID, "programs/aegis/tests/fixtures/meteora_dbc.so");
    load(
      new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"),
      "tests/fixtures/damm_v2.so"
    );

    // Migration builds the graduated pool from a Meteora-owned config account. Only their
    // operators can create one, so a real mainnet config is loaded rather than fabricated.
    const dammConfigs = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "tests/fixtures/damm_v2_configs.json"),
        "utf8"
      )
    ) as Record<string, any>;
    for (const [address, acc] of Object.entries(dammConfigs)) {
      this.svm.setAccount(new PublicKey(address), {
        lamports: acc.lamports,
        data: Buffer.from(acc.data, "base64"),
        owner: new PublicKey(acc.owner),
        executable: acc.executable,
        rentEpoch: 0,
      } as any);
    }

    // Anchor only needs the provider to build instructions offline here — no RPC is used,
    // because every transaction is handed straight to LiteSVM.
    this.program = new Program(AEGIS_IDL, {
      publicKey: PublicKey.default,
      connection: {},
    } as any);

    this.svm.setClock(new Clock(1n, 0n, 0n, 0n, TEST_UNIX_TIME));

    this.admin = Keypair.generate();
    this.issuer = Keypair.generate();
    this.treasury = Keypair.generate();
    this.outsider = Keypair.generate();

    for (const kp of [this.admin, this.issuer, this.outsider]) {
      this.svm.airdrop(kp.publicKey, 500n * SOL);
    }
    // The treasury must already exist and be rent-exempt to receive the creation fee.
    this.svm.airdrop(this.treasury.publicKey, SOL);

    // Meteora's migration pays the new pool's rent out of its own pool-authority PDA and only
    // reimburses it from the caller afterwards, so that account must hold the rent *before* the
    // call even though it ends the transaction square. Measured at roughly 0.033 SOL; the
    // `FLASH_RENT_FUND = 1 SOL` constant in Meteora's source is declared but never used.
    //
    // On mainnet the account is long-lived and holds tens of SOL. A fresh VM starts it at zero,
    // which would fail for want of money it is about to be repaid.
    this.svm.airdrop(Env.meteoraPoolAuthority(), 5n * SOL);
  }

  static create(): Env {
    return new Env();
  }

  /** Boots the platform and points the fee recipient at a distinct treasury account. */
  static async booted(): Promise<Env> {
    const env = Env.create();
    await env.initPlatform();
    return env;
  }

  // ------------------------------------------------------------------
  // transaction plumbing
  // ------------------------------------------------------------------

  send(
    ixs: TransactionInstruction[],
    signers: Keypair[]
  ): TransactionMetadata | FailedTransactionMetadata {
    // Some tests send byte-identical transactions more than once; expiring the blockhash keeps
    // the signatures distinct so LiteSVM's history dedup does not reject the second one.
    this.svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    return this.svm.sendTransaction(tx);
  }

  sendOk(ixs: TransactionInstruction[], signers: Keypair[]): TransactionMetadata {
    const res = this.send(ixs, signers);
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(
        `transaction failed: ${res.err()}\n${res.meta().logs().join("\n")}`
      );
    }
    return res;
  }

  // ------------------------------------------------------------------
  // PDAs
  // ------------------------------------------------------------------

  static platformConfigPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("platform_config")],
      AEGIS_PROGRAM_ID
    )[0];
  }

  static launchPda(realRwaMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("launch"), realRwaMint.toBuffer()],
      AEGIS_PROGRAM_ID
    )[0];
  }

  static accessControlPda(mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("ac"), mint.toBuffer()],
      ACCESS_CONTROL_PROGRAM_ID
    )[0];
  }

  /** Signer-only PDA that owns the escrow vault. One per launch. */
  static aegisAuthorityPda(realRwaMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), Env.launchPda(realRwaMint).toBuffer()],
      AEGIS_PROGRAM_ID
    )[0];
  }

  /** Admin-approved quote token. Existence of this account is the whitelist. */
  static quoteTokenPda(quoteMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("quote_token"), quoteMint.toBuffer()],
      AEGIS_PROGRAM_ID
    )[0];
  }

  /** Meteora's global pool authority — a compile-time constant in their program. */
  static meteoraPoolAuthority(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool_authority")],
      METEORA_DBC_PROGRAM_ID
    )[0];
  }

  /** Meteora derives the pool from the config and both mints, ordered by raw bytes. */
  static meteoraPool(
    config: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): PublicKey {
    const [hi, lo] =
      Buffer.compare(baseMint.toBuffer(), quoteMint.toBuffer()) > 0
        ? [baseMint, quoteMint]
        : [quoteMint, baseMint];
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), config.toBuffer(), hi.toBuffer(), lo.toBuffer()],
      METEORA_DBC_PROGRAM_ID
    )[0];
  }

  static meteoraTokenVault(mint: PublicKey, pool: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()],
      METEORA_DBC_PROGRAM_ID
    )[0];
  }

  /** The hook's companion account. Without it, every transfer of the mint fails. */
  static extraAccountMetaList(mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.toBuffer()],
      AEGIS_HOOK_PROGRAM_ID
    )[0];
  }

  /** Meteora's own event-authority PDA. */
  static meteoraEventAuthority(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      METEORA_DBC_PROGRAM_ID
    )[0];
  }

  static walletRolePda(mint: PublicKey, wallet: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("wallet_role"), mint.toBuffer(), wallet.toBuffer()],
      ACCESS_CONTROL_PROGRAM_ID
    )[0];
  }

  // ------------------------------------------------------------------
  // instruction builders
  // ------------------------------------------------------------------

  async initializePlatformIx(): Promise<TransactionInstruction> {
    return this.program.methods
      .initializePlatform()
      .accountsPartial({
        admin: this.admin.publicKey,
        platformConfig: Env.platformConfigPda(),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async updatePlatformConfigIx(params: {
    admin?: PublicKey | null;
    creationFeeLamports?: bigint | number | null;
    isPaused?: boolean | null;
    aegisLpSharePct?: number | null;
    minMigrationFeePct?: number | null;
    maxMigrationFeePct?: number | null;
    curveFeeBps?: number | null;
    issuerCurveFeeSharePct?: number | null;
    aegisMigrationFeeSharePct?: number | null;
    minIssuerPermanentPct?: number | null;
    minVestingMonths?: number | null;
    maxVestingMonths?: number | null;
    minPoolFeeBps?: number | null;
    maxPoolFeeBps?: number | null;
    /** Supplied as an account so its owner can be checked on-chain. */
    newFeeRecipient?: PublicKey | null;
  }): Promise<TransactionInstruction> {
    const args = {
      admin: params.admin ?? null,
      creationFeeLamports: params.creationFeeLamports ?? null,
      isPaused: params.isPaused ?? null,
      aegisLpSharePct: params.aegisLpSharePct ?? null,
      minMigrationFeePct: params.minMigrationFeePct ?? null,
      maxMigrationFeePct: params.maxMigrationFeePct ?? null,
      curveFeeBps: params.curveFeeBps ?? null,
      issuerCurveFeeSharePct: params.issuerCurveFeeSharePct ?? null,
      aegisMigrationFeeSharePct: params.aegisMigrationFeeSharePct ?? null,
      minIssuerPermanentPct: params.minIssuerPermanentPct ?? null,
      minVestingMonths: params.minVestingMonths ?? null,
      maxVestingMonths: params.maxVestingMonths ?? null,
      minPoolFeeBps: params.minPoolFeeBps ?? null,
      maxPoolFeeBps: params.maxPoolFeeBps ?? null,
    };
    return this.program.methods
      .updatePlatformConfig(args as any)
      .accountsPartial({
        platformConfig: Env.platformConfigPda(),
        admin: this.admin.publicKey,
        newFeeRecipient: params.newFeeRecipient ?? null,
      })
      .instruction();
  }

  /**
   * Every account is passed explicitly rather than relying on Anchor's PDA resolution, so a
   * test can substitute a wrong account and prove the on-chain constraint rejects it.
   */
  async createRwaIx(opts: {
    issuer: PublicKey;
    realRwaMint: PublicKey;
    feeRecipient: PublicKey;
    args: CreateRwaArgs;
    launch?: PublicKey;
    accessControl?: PublicKey;
    issuerWalletRole?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { issuer, realRwaMint, feeRecipient, args } = opts;
    return this.program.methods
      .createRwa({
        decimals: args.decimals,
        totalSupply: toBn(args.totalSupply),
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
      } as any)
      .accountsPartial({
        issuer,
        platformConfig: Env.platformConfigPda(),
        feeRecipient,
        realRwaMint,
        launch: opts.launch ?? Env.launchPda(realRwaMint),
        accessControl: opts.accessControl ?? Env.accessControlPda(realRwaMint),
        issuerWalletRole:
          opts.issuerWalletRole ?? Env.walletRolePda(realRwaMint, issuer),
        accessControlProgram: ACCESS_CONTROL_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async whitelistQuoteTokenIx(
    quoteMint: PublicKey,
    admin?: PublicKey,
    minRaise: bigint | number = 0
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .whitelistQuoteToken(bnOf(minRaise))
      .accountsPartial({
        admin: admin ?? this.admin.publicKey,
        platformConfig: Env.platformConfigPda(),
        quoteMint,
        quoteToken: Env.quoteTokenPda(quoteMint),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async updateQuoteTokenIx(
    quoteMint: PublicKey,
    isActive: boolean | null,
    minRaise: bigint | number | null = null,
    admin?: PublicKey
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .updateQuoteToken(isActive, minRaise === null ? null : bnOf(minRaise))
      .accountsPartial({
        admin: admin ?? this.admin.publicKey,
        platformConfig: Env.platformConfigPda(),
        quoteToken: Env.quoteTokenPda(quoteMint),
      })
      .instruction();
  }

  async fundVaultIx(opts: {
    issuer: PublicKey;
    realRwaMint: PublicKey;
    investorGroup: number;
    vaultGroup: number;
    escrowVault?: PublicKey;
    redeemRule?: PublicKey;
    vaultSaa?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { issuer, realRwaMint, investorGroup, vaultGroup } = opts;
    const authority = Env.aegisAuthorityPda(realRwaMint);
    const vault = opts.escrowVault ?? upside.ataFor(realRwaMint, authority);
    const trd = upside.pda.transferRestrictionData(realRwaMint);

    return this.program.methods
      .fundVault({ investorGroup: bnOf(investorGroup) } as any)
      .accountsPartial({
        issuer,
        launch: Env.launchPda(realRwaMint),
        realRwaMint,
        aegisAuthority: authority,
        escrowVault: vault,
        accessControl: upside.pda.accessControl(realRwaMint),
        issuerWalletRole: upside.pda.walletRole(realRwaMint, issuer),
        transferRestrictionData: trd,
        vaultSaa: opts.vaultSaa ?? upside.pda.securityAssociatedAccount(vault),
        redeemRule:
          opts.redeemRule ?? upside.pda.rule(trd, vaultGroup, investorGroup),
        accessControlProgram: ACCESS_CONTROL_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  async createRwaConfigIx(opts: {
    issuer: PublicKey;
    realRwaMint: PublicKey;
    quoteMint: PublicKey;
    meteoraConfig: PublicKey;
    args: CreateRwaConfigArgs;
    dbcProgram?: PublicKey;
    hookProgram?: PublicKey;
    quoteToken?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { issuer, realRwaMint, quoteMint, meteoraConfig, args } = opts;
    return this.program.methods
      .createRwaConfig({
        sqrtStartPrice: bnOf(args.sqrtStartPrice),
        sqrtExpansionBps: args.sqrtExpansionBps,
        targetRaise: bnOf(args.targetRaise),
        archetype: args.archetype,
        migrationFeePct: args.migrationFeePct,
        issuerPermanentLockPct: args.issuerPermanentLockPct,
        issuerVestedPct: args.issuerVestedPct,
        vestingMonths: args.vestingMonths,
        poolFeeBps: args.poolFeeBps,
      } as any)
      .accountsPartial({
        issuer,
        platformConfig: Env.platformConfigPda(),
        launch: Env.launchPda(realRwaMint),
        quoteMint,
        quoteToken: opts.quoteToken ?? Env.quoteTokenPda(quoteMint),
        aegisAuthority: Env.aegisAuthorityPda(realRwaMint),
        meteoraConfig,
        meteoraDbcProgram: opts.dbcProgram ?? METEORA_DBC_PROGRAM_ID,
        meteoraEventAuthority: Env.meteoraEventAuthority(),
        aegisHookProgram: opts.hookProgram ?? AEGIS_HOOK_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async launchPoolIx(opts: {
    issuer: PublicKey;
    realRwaMint: PublicKey;
    quoteMint: PublicKey;
    meteoraConfig: PublicKey;
    crwaMint: PublicKey;
    args?: { name: string; symbol: string; uri: string };
    dbcProgram?: PublicKey;
    hookProgram?: PublicKey;
    poolAuthority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const {
      issuer,
      realRwaMint,
      quoteMint,
      meteoraConfig,
      crwaMint,
    } = opts;
    const launch = Env.launchPda(realRwaMint);
    const authority = Env.aegisAuthorityPda(realRwaMint);
    const trd = upside.pda.transferRestrictionData(realRwaMint);
    const vault = upside.ataFor(realRwaMint, authority);
    const l = this.launch(realRwaMint);
    const pool = Env.meteoraPool(meteoraConfig, crwaMint, quoteMint);

    return this.program.methods
      .launchPool(
        opts.args ?? {
          name: "Wrapped Tower A",
          symbol: "cTWRA",
          uri: "https://aegis.test/ctwra.json",
        }
      )
      .accountsPartial({
        issuer,
        platformConfig: Env.platformConfigPda(),
        launch,
        realRwaMint,
        aegisAuthority: authority,
        escrowVault: vault,
        accessControl: upside.pda.accessControl(realRwaMint),
        transferRestrictionData: trd,
        vaultSaa: upside.pda.securityAssociatedAccount(vault),
        redeemRule: upside.pda.rule(
          trd,
          BigInt(l.vaultGroup.toString()),
          BigInt(l.investorGroup.toString())
        ),
        meteoraConfig,
        poolAuthority: opts.poolAuthority ?? Env.meteoraPoolAuthority(),
        crwaMint,
        quoteMint,
        pool,
        baseVault: Env.meteoraTokenVault(crwaMint, pool),
        quoteVault: Env.meteoraTokenVault(quoteMint, pool),
        meteoraEventAuthority: Env.meteoraEventAuthority(),
        meteoraDbcProgram: opts.dbcProgram ?? METEORA_DBC_PROGRAM_ID,
        aegisHookProgram: opts.hookProgram ?? AEGIS_HOOK_PROGRAM_ID,
        extraAccountMetaList: Env.extraAccountMetaList(crwaMint),
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async finalizeGraduationIx(opts: {
    cranker: PublicKey;
    realRwaMint: PublicKey;
    crwaMint: PublicKey;
    quoteMint: PublicKey;
    meteoraConfig: PublicKey;
  }): Promise<TransactionInstruction> {
    const { cranker, realRwaMint, crwaMint, quoteMint, meteoraConfig } = opts;
    const authority = Env.aegisAuthorityPda(realRwaMint);
    const pool = Env.meteoraPool(meteoraConfig, crwaMint, quoteMint);

    // No Upside accounts and no issuer: settlement moves no Real RWA, so none are needed.
    return this.program.methods
      .finalizeGraduation()
      .accountsPartial({
        cranker,
        launch: Env.launchPda(realRwaMint),
        realRwaMint,
        crwaMint,
        aegisAuthority: authority,
        aegisCrwaAccount: upside.ataFor(crwaMint, authority),
        escrowVault: upside.ataFor(realRwaMint, authority),
        poolAuthority: Env.meteoraPoolAuthority(),
        meteoraConfig,
        virtualPool: pool,
        baseVault: Env.meteoraTokenVault(crwaMint, pool),
        meteoraEventAuthority: Env.meteoraEventAuthority(),
        meteoraDbcProgram: METEORA_DBC_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: new PublicKey(
          "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        ),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async bridgeDepositIx(opts: {
    user: PublicKey;
    realRwaMint: PublicKey;
    crwaMint: PublicKey;
    amount: bigint | number;
  }): Promise<TransactionInstruction> {
    return this.bridgeIx("bridgeDeposit", opts);
  }

  async bridgeRedeemIx(opts: {
    user: PublicKey;
    realRwaMint: PublicKey;
    crwaMint: PublicKey;
    amount: bigint | number;
  }): Promise<TransactionInstruction> {
    return this.bridgeIx("bridgeRedeem", opts);
  }

  private async bridgeIx(
    method: "bridgeDeposit" | "bridgeRedeem",
    opts: {
      user: PublicKey;
      realRwaMint: PublicKey;
      crwaMint: PublicKey;
      amount: bigint | number;
    }
  ): Promise<TransactionInstruction> {
    const { user, realRwaMint, crwaMint, amount } = opts;
    const l = this.launch(realRwaMint);
    const authority = Env.aegisAuthorityPda(realRwaMint);
    const trd = upside.pda.transferRestrictionData(realRwaMint);
    const vault = upside.ataFor(realRwaMint, authority);
    const userReal = upside.ataFor(realRwaMint, user);
    const vaultGroup = BigInt(l.vaultGroup.toString());
    const investorGroup = BigInt(l.investorGroup.toString());

    const common: Record<string, PublicKey> = {
      user,
      launch: Env.launchPda(realRwaMint),
      realRwaMint,
      crwaMint,
      aegisAuthority: authority,
      escrowVault: vault,
      userRealRwaAccount: userReal,
      userCrwaAccount: upside.ataFor(crwaMint, user),
      accessControl: upside.pda.accessControl(realRwaMint),
      transferRestrictionData: trd,
      userSaa: upside.pda.securityAssociatedAccount(userReal),
      vaultSaa: upside.pda.securityAssociatedAccount(vault),
      redeemRule: upside.pda.rule(trd, vaultGroup, investorGroup),
      realRwaExtraMetas: upside.pda.extraAccountMetaList(realRwaMint),
      transferRestrictionsProgram: TRANSFER_RESTRICTIONS_PROGRAM_ID,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    if (method === "bridgeDeposit") {
      common.depositRule = upside.pda.rule(trd, investorGroup, vaultGroup);
      common.associatedTokenProgram = new PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
      );
    }

    return (this.program.methods as any)[method](bnOf(amount))
      .accountsPartial(common)
      .instruction();
  }

  /**
   * `aegis_hook::initialize_extra_account_meta_list`, callable by anyone for any mint.
   *
   * Used in tests to reproduce a front-run: the cRWA mint address is visible in the launch
   * transaction, so a watcher could create this account first.
   */
  async initHookMetasIx(
    payer: PublicKey,
    mint: PublicKey
  ): Promise<TransactionInstruction> {
    const hookIdl = AEGIS_HOOK_IDL;
    const hook = new Program(hookIdl, {
      publicKey: PublicKey.default,
      connection: {},
    } as any);
    return hook.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        payer,
        extraAccountMetaList: Env.extraAccountMetaList(mint),
        mint,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  private claimCommon(realRwaMint: PublicKey, cranker: PublicKey) {
    const l = this.launch(realRwaMint);
    const pool = Env.meteoraPool(l.meteoraConfig, l.crwaMint, l.quoteMint);
    return {
      l,
      pool,
      accounts: {
        cranker,
        platformConfig: Env.platformConfigPda(),
        launch: Env.launchPda(realRwaMint),
        aegisAuthority: Env.aegisAuthorityPda(realRwaMint),
        feeRecipient: this.platformConfig().feeRecipient,
        feeRecipientQuoteAccount: getAssociatedTokenAddressSync(
          l.quoteMint,
          this.platformConfig().feeRecipient,
          true,
          TOKEN_PROGRAM_ID
        ),
        quoteMint: l.quoteMint,
        quoteVault: Env.meteoraTokenVault(l.quoteMint, pool),
        meteoraConfig: l.meteoraConfig,
        virtualPool: pool,
        poolAuthority: Env.meteoraPoolAuthority(),
        meteoraEventAuthority: Env.meteoraEventAuthority(),
        meteoraDbcProgram: METEORA_DBC_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: new PublicKey(
          "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        ),
        systemProgram: SystemProgram.programId,
      } as Record<string, PublicKey>,
    };
  }

  async claimTradingFeeIx(
    realRwaMint: PublicKey,
    cranker: PublicKey
  ): Promise<TransactionInstruction> {
    const { l, pool, accounts } = this.claimCommon(realRwaMint, cranker);
    return this.program.methods
      .claimPartnerTradingFee()
      .accountsPartial({
        ...accounts,
        aegisCrwaAccount: upside.ataFor(
          l.crwaMint,
          Env.aegisAuthorityPda(realRwaMint)
        ),
        baseMint: l.crwaMint,
        baseVault: Env.meteoraTokenVault(l.crwaMint, pool),
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  async claimMigrationFeeIx(
    realRwaMint: PublicKey,
    cranker: PublicKey
  ): Promise<TransactionInstruction> {
    const { accounts } = this.claimCommon(realRwaMint, cranker);
    return this.program.methods
      .claimPartnerMigrationFee()
      .accountsPartial(accounts)
      .instruction();
  }

  /** The issuer collects the asset behind their unsold wrapper. `issuerOverride` names another signer. */
  async claimUnsoldIx(
    realRwaMint: PublicKey,
    issuerOverride?: PublicKey
  ): Promise<TransactionInstruction> {
    const l = this.launch(realRwaMint);
    const issuer = issuerOverride ?? l.issuer;
    const authority = Env.aegisAuthorityPda(realRwaMint);
    const trd = upside.pda.transferRestrictionData(realRwaMint);
    const vault = upside.ataFor(realRwaMint, authority);
    const issuerAta = upside.ataFor(realRwaMint, issuer);
    return this.program.methods
      .claimUnsold()
      .accountsPartial({
        issuer,
        launch: Env.launchPda(realRwaMint),
        realRwaMint,
        crwaMint: l.crwaMint,
        aegisAuthority: authority,
        escrowVault: vault,
        issuerRealRwaAccount: issuerAta,
        accessControl: upside.pda.accessControl(realRwaMint),
        transferRestrictionData: trd,
        vaultSaa: upside.pda.securityAssociatedAccount(vault),
        issuerSaa: upside.pda.securityAssociatedAccount(issuerAta),
        redeemRule: upside.pda.rule(
          trd,
          BigInt(l.vaultGroup.toString()),
          BigInt(l.investorGroup.toString())
        ),
        realRwaExtraMetas: upside.pda.extraAccountMetaList(realRwaMint),
        transferRestrictionsProgram: TRANSFER_RESTRICTIONS_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  async abortLaunchIx(
    realRwaMint: PublicKey,
    issuerOverride?: PublicKey
  ): Promise<TransactionInstruction> {
    const l = this.launch(realRwaMint);
    const authority = Env.aegisAuthorityPda(realRwaMint);
    const trd = upside.pda.transferRestrictionData(realRwaMint);
    const vault = upside.ataFor(realRwaMint, authority);
    const issuerAta = upside.ataFor(realRwaMint, l.issuer);
    return this.program.methods
      .abortLaunch()
      .accountsPartial({
        issuer: issuerOverride ?? l.issuer,
        launch: Env.launchPda(realRwaMint),
        realRwaMint,
        aegisAuthority: authority,
        escrowVault: vault,
        issuerRealRwaAccount: issuerAta,
        accessControl: upside.pda.accessControl(realRwaMint),
        transferRestrictionData: trd,
        vaultSaa: upside.pda.securityAssociatedAccount(vault),
        issuerSaa: upside.pda.securityAssociatedAccount(issuerAta),
        redeemRule: upside.pda.rule(
          trd,
          BigInt(l.vaultGroup.toString()),
          BigInt(l.investorGroup.toString())
        ),
        realRwaExtraMetas: upside.pda.extraAccountMetaList(realRwaMint),
        transferRestrictionsProgram: TRANSFER_RESTRICTIONS_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  /** Pool creation is well past the 200k default, so every caller raises the budget. */
  static computeBudget(units = 1_400_000): TransactionInstruction {
    return ComputeBudgetProgram.setComputeUnitLimit({ units });
  }

  // ------------------------------------------------------------------
  // flows
  // ------------------------------------------------------------------

  /**
   * Performs the compliance setup an issuer would do through Upside, off-chain, between
   * `create_rwa` and `fund_vault`. Split across several transactions purely for size.
   */
  async setupCompliance(
    mint: PublicKey,
    layout: upside.ComplianceLayout = upside.DEFAULT_LAYOUT,
    issuer: Keypair = this.issuer
  ): Promise<void> {
    const a = issuer.publicKey;
    const authority = Env.aegisAuthorityPda(mint);

    this.sendOk(
      [
        await upside.ix.initRuleBook(mint, a, layout.maxHolders),
        await upside.ix.initHookMetas(mint, a),
      ],
      [issuer]
    );

    this.sendOk(
      [
        await upside.ix.initGroup(mint, a, layout.investorGroup),
        await upside.ix.initGroup(mint, a, layout.vaultGroup),
        // the redemption path: vault -> investor, allowed immediately
        await upside.ix.initRule(
          mint,
          a,
          layout.vaultGroup,
          layout.investorGroup,
          1
        ),
        // the deposit path: investor -> vault. Needed only once the bridge opens, but created
        // up front so a launch is never half-usable.
        await upside.ix.initRule(
          mint,
          a,
          layout.investorGroup,
          layout.vaultGroup,
          1
        ),
      ],
      [issuer]
    );

    this.sendOk(
      [
        // the vault must exist before it can be registered as a holder
        upside.ix.createAta(a, mint, authority),
        await upside.ix.initHolder(mint, a, layout.vaultHolderId),
        await upside.ix.initHolderGroup(
          mint,
          a,
          layout.vaultHolderId,
          layout.vaultGroup
        ),
        await upside.ix.initSaa(
          mint,
          a,
          authority,
          layout.vaultGroup,
          layout.vaultHolderId
        ),
      ],
      [issuer]
    );
  }

  /** `create_rwa` + the issuer's off-chain compliance setup + `fund_vault`. */
  async fundedLaunch(
    args: CreateRwaArgs = defaultRwaArgs(),
    layout: upside.ComplianceLayout = upside.DEFAULT_LAYOUT
  ): Promise<Keypair> {
    const mint = await this.createRwa(args);
    await this.setupCompliance(mint.publicKey, layout);
    this.sendOk(
      [
        await this.fundVaultIx({
          issuer: this.issuer.publicKey,
          realRwaMint: mint.publicKey,
          investorGroup: layout.investorGroup,
          vaultGroup: layout.vaultGroup,
        }),
      ],
      [this.issuer]
    );
    return mint;
  }

  async initPlatform(): Promise<void> {
    this.sendOk([await this.initializePlatformIx()], [this.admin]);
    // `initialize_platform` defaults the fee recipient to the admin. Point it at a separate
    // treasury so the fee transfer is observable.
    this.sendOk(
      [
        await this.updatePlatformConfigIx({
          newFeeRecipient: this.treasury.publicKey,
        }),
      ],
      [this.admin]
    );
  }

  async setPaused(paused: boolean): Promise<void> {
    this.sendOk(
      [
        await this.updatePlatformConfigIx({ isPaused: paused }),
      ],
      [this.admin]
    );
  }

  /** Runs `create_rwa` for a fresh mint and returns the mint keypair. */
  async createRwa(
    args: CreateRwaArgs = defaultRwaArgs(),
    issuer: Keypair = this.issuer
  ): Promise<Keypair> {
    const mint = Keypair.generate();
    const ix = await this.createRwaIx({
      issuer: issuer.publicKey,
      realRwaMint: mint.publicKey,
      feeRecipient: this.treasury.publicKey,
      args,
    });
    this.sendOk([ix], [issuer, mint]);
    return mint;
  }

  /** A plain legacy-SPL mint, for use as a stand-in quote token. */
  async makeSplMint(decimals = 6): Promise<Keypair> {
    const mint = Keypair.generate();
    const space = getMintLen([]);
    this.sendOk(
      [
        SystemProgram.createAccount({
          fromPubkey: this.admin.publicKey,
          newAccountPubkey: mint.publicKey,
          space,
          lamports: Number(
            this.svm.minimumBalanceForRentExemption(BigInt(space))
          ),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
          mint.publicKey,
          decimals,
          this.admin.publicKey,
          null,
          TOKEN_PROGRAM_ID
        ),
      ],
      [this.admin, mint]
    );
    return mint;
  }

  meteoraDbcProgramId(): PublicKey {
    return METEORA_DBC_PROGRAM_ID;
  }

  aegisHookProgramId(): PublicKey {
    return AEGIS_HOOK_PROGRAM_ID;
  }

  // ------------------------------------------------------------------
  // account readers
  // ------------------------------------------------------------------

  accountData(key: PublicKey): Buffer {
    const acc = this.svm.getAccount(key);
    if (!acc) throw new Error(`account ${key.toBase58()} does not exist`);
    return Buffer.from(acc.data);
  }

  exists(key: PublicKey): boolean {
    return this.svm.getAccount(key) !== null;
  }

  /** Decodes one of our own Anchor accounts via the generated coder. */
  decode<T = any>(name: string, key: PublicKey): T {
    return this.program.coder.accounts.decode<T>(name, this.accountData(key));
  }

  launch(realRwaMint: PublicKey): any {
    return this.decode("launch", Env.launchPda(realRwaMint));
  }

  quoteToken(quoteMint: PublicKey): any {
    return this.decode("quoteToken", Env.quoteTokenPda(quoteMint));
  }

  platformConfig(): any {
    return this.decode("platformConfig", Env.platformConfigPda());
  }

  balance(key: PublicKey): bigint {
    return this.svm.getBalance(key) ?? 0n;
  }
}

// ----------------------------------------------------------------------
// Upside account layouts
//
// These are Upside's accounts, not ours, so they are read positionally rather than through a
// coder. Layouts verified against upsideos-solana-rwa @ ce74f27.
// ----------------------------------------------------------------------

/** `WalletRole`: 8-byte discriminator, owner (32), access_control (32), role (u8). */
export function walletRoleBitmask(data: Buffer): number {
  return data[8 + 32 + 32];
}

/**
 * `AccessControl`: 8-byte discriminator, mint (32), authority (32), max_total_supply (u64),
 * lockup_escrow_account (Option<Pubkey>, 1-byte tag).
 */
export function accessControl(data: Buffer) {
  let o = 8;
  const mint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const authority = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const maxTotalSupply = data.readBigUInt64LE(o);
  o += 8;
  const hasEscrow = data[o] !== 0;
  o += 1;
  const lockupEscrowAccount = hasEscrow
    ? new PublicKey(data.subarray(o, o + 32))
    : null;
  return { mint, authority, maxTotalSupply, lockupEscrowAccount };
}

// ----------------------------------------------------------------------
// assertions
// ----------------------------------------------------------------------

/**
 * Asserts the transaction failed with a specific Anchor error.
 *
 * Matching on the logged error name rather than the numeric code keeps the test readable and
 * stable if variants are reordered.
 */
export function expectAnchorError(
  res: TransactionMetadata | FailedTransactionMetadata,
  errorName: string
): void {
  if (!(res instanceof FailedTransactionMetadata)) {
    throw new Error(`expected failure with ${errorName}, but it succeeded`);
  }
  const logs = res.meta().logs().join("\n");
  if (!logs.includes(errorName)) {
    throw new Error(
      `expected failure with ${errorName}, got:\n${res.err()}\n${logs}`
    );
  }
}

/** Asserts the transaction succeeded, surfacing the program logs when it did not. */
export function expectSuccess(
  res: TransactionMetadata | FailedTransactionMetadata
): TransactionMetadata {
  if (res instanceof FailedTransactionMetadata) {
    throw new Error(
      `expected success, got ${res.err()}\n${res.meta().logs().join("\n")}`
    );
  }
  return res;
}

export function expectFailure(
  res: TransactionMetadata | FailedTransactionMetadata
): FailedTransactionMetadata {
  if (!(res instanceof FailedTransactionMetadata)) {
    throw new Error("expected the transaction to fail, but it succeeded");
  }
  return res;
}

export function bnOf(v: bigint | number) {
  return toBn(v);
}

function toBn(v: bigint | number) {
  // Anchor's borsh layer wants a BN for u64 fields.
  const BN = require("bn.js");
  return new BN(v.toString());
}
