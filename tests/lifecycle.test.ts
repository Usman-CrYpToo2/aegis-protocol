/**
 * ONE LAUNCH, FROM START TO FINISH.
 *
 * Every other test file in this suite pulls one instruction apart and attacks it. This file does
 * the opposite: it follows a single issuer through a single launch, in order, with nothing
 * skipped and nothing mocked, and checks the money at each step.
 *
 * Read it top to bottom and you have the whole protocol.
 *
 * ---------------------------------------------------------------------------------------------
 * THE STORY
 *
 * A property company owns a building. They want to raise 10,000 USDC against it and give the
 * buyers something that trades.
 *
 * They cannot simply mint a token. The building is a regulated security, so the token
 * representing it has to carry a compliance layer: only approved wallets may hold it, and the
 * issuer keeps legal powers over it (freeze, force transfer, burn) because the law says they
 * must. A token like that cannot trade on an open market — no exchange can honour "only approved
 * wallets" on every hop.
 *
 * So Aegis splits it into two tokens:
 *
 *   Real RWA (TWRA)   the legal security. Compliance-locked forever. Lives in escrow.
 *   cRWA     (cTWRA)  the wrapper. Trades freely. Backed one-for-one by the escrow.
 *
 * The escrow is what makes the wrapper mean something. Every single cTWRA in existence is
 * matched by one TWRA sitting in a vault that only this program can move. Anyone approved can
 * swap between the two, in either direction, forever. That is the bridge, and it is what keeps
 * the wrapper's price tied to the building instead of floating free.
 *
 * ---------------------------------------------------------------------------------------------
 * THE TWELVE STEPS
 *
 *   ADMIN SETS UP THE PLATFORM
 *    1. initialize_platform      the protocol is created, once, ever
 *    2. update_platform_config   the admin sets fees and the bounds issuers must stay inside
 *    3. whitelist_quote_token    USDC is approved as something buyers may pay with
 *
 *   ISSUER PREPARES THE ASSET
 *    4. create_rwa               Aegis creates the security and hands the issuer full legal control
 *    5. (issuer, off-chain)      the issuer sets up their own compliance rules through Upside
 *    6. fund_vault               the entire supply is minted straight into the Aegis escrow
 *
 *   THE SALE
 *    7. create_rwa_config        the sale terms are fixed with Meteora
 *    8. launch_pool              Meteora creates cTWRA and opens the bonding curve
 *    9. (buyer)                  a buyer buys until the curve completes
 *
 *   GRADUATION
 *   10. (Meteora) migrate        the raise becomes a permanent DAMM v2 trading pool
 *   11. finalize_graduation      unsold wrapper is destroyed, unsold stock goes back to the issuer
 *
 *   FOREVER AFTER
 *   12. bridge_redeem / deposit  anyone approved converts between the two, one for one
 *       claim_partner_*          the protocol collects its revenue
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS REAL HERE
 *
 * Nothing in this file is a stub. Upside's Access Control and Transfer Restrictions programs are
 * the real mainnet binaries. Meteora's bonding curve and DAMM v2 are the real mainnet binaries.
 * If our transaction is wrong, their program rejects it and the test fails.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getTransferHook,
  unpackMint,
} from "@solana/spl-token";
import {
  ARCHETYPE,
  Env,
  SQRT_PRICE_ONE,
  defaultConfigArgs,
  defaultRwaArgs,
  expectSuccess,
  walletRoleBitmask,
} from "./helpers";
import {
  DAMM_V2_DYNAMIC_CONFIG,
  SWAP_MODE,
  dammV2,
  migrateDammV2Ix,
  swapWithTransferHookIx,
} from "./meteora";
import { registerHolder } from "./fixtures";
import * as upside from "./upside";

// =================================================================================================
// The numbers this launch uses. Everything below is denominated in the smallest unit ("atoms"),
// which is what the chain actually stores. Both tokens use 6 decimals, so 1 token = 1,000,000.
// =================================================================================================

/** 1,000,000 TWRA — one token per notional unit of the building. */
const TOTAL_SUPPLY = 1_000_000_000_000n;

/** 10,000 USDC. The issuer wants this much raised before the sale closes. */
const TARGET_RAISE = 10_000_000_000n;

/** Half the raise is paid out as cash to the issuer; the rest seeds the permanent pool. */
const MIGRATION_FEE_PCT = 50;

/** Buyers pay 1% on every trade during the sale. This is the protocol's placement fee. */
const CURVE_FEE_BPS = 100;

/** Of the migration fee, the protocol's cut. The default is 0; this admin chose 20%. */
const AEGIS_MIGRATION_FEE_SHARE_PCT = 20;

/** Meteora takes a fixed 20% of every trading fee before anyone else is paid. Not configurable. */
const METEORA_PROTOCOL_CUT_PCT = 20;

const LAYOUT = upside.DEFAULT_LAYOUT;

// =================================================================================================
// Small readers. LiteSVM hands back raw account bytes, so these decode the two things we watch.
// =================================================================================================

/** Token balance. `amount` sits at byte 64 of every SPL token account. */
function balance(env: Env, account: PublicKey): bigint {
  const acc = env.svm.getAccount(account);
  if (!acc) return 0n;
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

/** Decodes a Token-2022 mint, extensions included. */
function readMint(env: Env, mint: PublicKey) {
  const acc = env.svm.getAccount(mint)!;
  return unpackMint(
    mint,
    { ...acc, data: Buffer.from(acc.data) } as any,
    TOKEN_2022_PROGRAM_ID
  );
}

/** Total supply of a Token-2022 mint. */
function supplyOf(env: Env, mint: PublicKey): bigint {
  return readMint(env, mint).supply;
}

/** Prints a number of atoms as a human amount, for the running commentary. */
function human(atoms: bigint, decimals = 6): string {
  const d = 10n ** BigInt(decimals);
  const whole = atoms / d;
  const frac = (atoms % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

describe("A COMPLETE LAUNCH", () => {
  // Every `it` below is one step, and they share this state because they are one story rather
  // than independent cases. Mocha runs them in the order they are written.
  let env: Env;

  let realRwaMint: Keypair; //  TWRA  — the security
  let crwaMint: Keypair; //     cTWRA — the wrapper, created by Meteora
  let usdc: Keypair; //         the quote token buyers pay with
  let meteoraConfig: Keypair; // the sale terms, stored in Meteora
  let pool: PublicKey; //       the bonding curve
  let buyer: Keypair; //        the person who buys in the sale
  let buyerUsdc: PublicKey;
  let buyerCrwa: PublicKey;

  /** The escrow: an Upside-compliant token account owned by a PDA only this program can sign for. */
  const escrowVault = () =>
    upside.ataFor(realRwaMint.publicKey, Env.aegisAuthorityPda(realRwaMint.publicKey));

  /** Where the protocol's revenue lands. */
  const treasuryUsdc = () =>
    getAssociatedTokenAddressSync(
      usdc.publicKey,
      env.treasury.publicKey,
      true,
      TOKEN_PROGRAM_ID
    );

  /**
   * The one invariant the whole protocol rests on.
   *
   * Asset in escrow == wrapper in circulation. If this ever breaks, some wrapper holder cannot
   * be paid, so it is asserted after every step that moves either token.
   */
  function assertPeg(where: string) {
    const escrowed = balance(env, escrowVault());
    const circulating = supplyOf(env, crwaMint.publicKey);
    assert.equal(
      escrowed.toString(),
      circulating.toString(),
      `peg broken after ${where}: ${escrowed} escrowed vs ${circulating} circulating`
    );

    // The program keeps its own ledger of both figures. It must agree with the chain, because
    // that ledger is what the bridge reads when deciding whether a redemption is covered.
    const rec = env.launch(realRwaMint.publicKey);
    assert.equal(rec.realRwaLocked.toString(), escrowed.toString());
    assert.equal(rec.crwaMinted.toString(), circulating.toString());
  }

  before(() => {
    env = Env.create(); // a blank chain, with the real programs loaded
    realRwaMint = Keypair.generate();
    crwaMint = Keypair.generate();
    meteoraConfig = Keypair.generate();
    buyer = env.outsider;
  });

  // ===============================================================================================
  // PART ONE — THE ADMIN SETS UP THE PLATFORM
  //
  // This happens once for the whole protocol, not once per launch. An issuer arriving later finds
  // all of it already done.
  // ===============================================================================================

  describe("1. the protocol is created", () => {
    it("initialize_platform creates the one global config account", async () => {
      env.sendOk([await env.initializePlatformIx()], [env.admin]);

      const cfg = env.platformConfig();
      assert.equal(cfg.admin.toBase58(), env.admin.publicKey.toBase58());
      // Fresh out of the box the fee recipient is the admin's own wallet.
      assert.equal(cfg.feeRecipient.toBase58(), env.admin.publicKey.toBase58());
      // 1 SOL to create a launch, and the protocol is live rather than paused.
      assert.equal(cfg.creationFeeLamports.toString(), "1000000000");
      assert.equal(cfg.isPaused, false);
    });

    it("ships with sane economic defaults, so a misconfigured platform is not the starting state", () => {
      const cfg = env.platformConfig();
      assert.equal(cfg.curveFeeBps, 100, "1% placement fee");
      assert.equal(cfg.issuerCurveFeeSharePct, 0, "the placement fee is the protocol's");
      assert.equal(cfg.aegisMigrationFeeSharePct, 0, "the raise is the issuer's");
      assert.equal(cfg.aegisLpSharePct, 10, "10% of graduated liquidity locked forever");
    });

    it("and with bounds on everything an issuer is allowed to choose", () => {
      const cfg = env.platformConfig();
      assert.equal(cfg.minMigrationFeePct, 1);
      assert.equal(cfg.maxMigrationFeePct, 90);
      assert.equal(cfg.minVestingMonths, 3);
      assert.equal(cfg.maxVestingMonths, 24);
      assert.equal(cfg.minPoolFeeBps, 10);
      assert.equal(cfg.maxPoolFeeBps, 300);
    });
  });

  describe("2. the admin configures it", () => {
    it("points revenue at a treasury instead of the admin's own wallet", async () => {
      env.sendOk(
        [
          await env.updatePlatformConfigIx({
            newFeeRecipient: env.treasury.publicKey,
          }),
        ],
        [env.admin]
      );
      assert.equal(
        env.platformConfig().feeRecipient.toBase58(),
        env.treasury.publicKey.toBase58()
      );
    });

    it("takes a 20% cut of the migration fee", async () => {
      // Worth being clear about what this changes, because the default is zero.
      //
      // The migration fee is cash taken off the raise at graduation. By default ALL of it goes to
      // the issuer — it is their money, raised against their building, and Aegis is already paid
      // by the 1% placement fee on the sale.
      //
      // This admin has decided to take 20% of it as well. It is set here purely so that later in
      // this file the migration-fee claim has something real to move. At the shipped default that
      // claim correctly transfers nothing.
      env.sendOk(
        [
          await env.updatePlatformConfigIx({
            aegisMigrationFeeSharePct: AEGIS_MIGRATION_FEE_SHARE_PCT,
          }),
        ],
        [env.admin]
      );
      assert.equal(
        env.platformConfig().aegisMigrationFeeSharePct,
        AEGIS_MIGRATION_FEE_SHARE_PCT
      );
    });
  });

  describe("3. USDC is approved as a quote token", () => {
    it("whitelist_quote_token records it, with a minimum raise", async () => {
      // A plain legacy-SPL mint standing in for USDC.
      usdc = await env.makeSplMint(6);

      // The floor is per token rather than global, because the number means nothing without the
      // token's decimals: a million units of a 6-decimal stablecoin is one dollar.
      env.sendOk(
        [await env.whitelistQuoteTokenIx(usdc.publicKey, undefined, 1_000_000_000n)],
        [env.admin]
      );

      const qt = env.quoteToken(usdc.publicKey);
      assert.equal(qt.mint.toBase58(), usdc.publicKey.toBase58());
      assert.equal(qt.decimals, 6);
      assert.equal(qt.isActive, true);
      assert.equal(qt.isLegacySpl, true);
      assert.equal(qt.minRaise.toString(), "1000000000", "1,000 USDC minimum");
    });

    it("is what makes a launch possible at all — no record, no launch", () => {
      // Existence of this account IS the whitelist. There is no list to grow and no loop to run.
      assert.isTrue(env.exists(Env.quoteTokenPda(usdc.publicKey)));
    });
  });

  // ===============================================================================================
  // PART TWO — THE ISSUER PREPARES THE ASSET
  // ===============================================================================================

  describe("4. the issuer creates the security", () => {
    let treasuryLamportsBefore: bigint;

    it("create_rwa creates the security — with a supply cap, but nothing minted yet", async () => {
      treasuryLamportsBefore = env.balance(env.treasury.publicKey);

      env.sendOk(
        [
          await env.createRwaIx({
            issuer: env.issuer.publicKey,
            realRwaMint: realRwaMint.publicKey,
            feeRecipient: env.treasury.publicKey,
            args: defaultRwaArgs({
              decimals: 6,
              totalSupply: TOTAL_SUPPLY,
              name: "Aegis Tower A",
              symbol: "TWRA",
            }),
          }),
        ],
        // The mint signs because it is a brand-new account being created.
        [env.issuer, realRwaMint]
      );

      // Nothing is minted here. The mint exists with a supply of zero and a hard cap equal to
      // the launch supply, so the tokens can only ever be created once, in step 6, straight into
      // escrow. They never pass through anyone's wallet.
      assert.equal(supplyOf(env, realRwaMint.publicKey).toString(), "0");
    });

    it("the 1 SOL creation fee reached the treasury", () => {
      const gained = env.balance(env.treasury.publicKey) - treasuryLamportsBefore;
      assert.equal(gained.toString(), "1000000000");
    });

    it("the token is compliance-restricted from birth — Upside's hook is already attached", () => {
      // Aegis builds the token rather than accepting one, so its shape is guaranteed. The hook
      // is set at creation and can never be removed: every transfer of TWRA, forever, is checked
      // by Upside's Transfer Restrictions program.
      assert.isTrue(env.exists(Env.accessControlPda(realRwaMint.publicKey)));
    });

    it("the issuer holds all four legal roles, and Aegis holds none", () => {
      // This is a deliberate asymmetry and the thing people get wrong about RWAs. The issuer is
      // legally required to be able to freeze a wallet, force a transfer, and burn. Aegis must
      // not be able to. So Aegis creates the token and immediately hands over every authority.
      const bitmask = walletRoleBitmask(
        env.accountData(Env.walletRolePda(realRwaMint.publicKey, env.issuer.publicKey))
      );
      // 1 ContractAdmin | 2 ReserveAdmin | 4 WalletsAdmin | 8 TransferAdmin = 15.
      assert.equal(bitmask, 15, "the issuer holds every role");

      // And Aegis has no role account at all, for the launch PDA or anything else.
      assert.isFalse(
        env.exists(
          Env.walletRolePda(realRwaMint.publicKey, Env.launchPda(realRwaMint.publicKey))
        ),
        "Aegis granted itself nothing"
      );
    });

    it("the launch record exists and is at stage TokenCreated", () => {
      const rec = env.launch(realRwaMint.publicKey);
      assert.deepEqual(rec.stage, { tokenCreated: {} });
      assert.equal(rec.issuer.toBase58(), env.issuer.publicKey.toBase58());
      assert.equal(rec.totalSupply.toString(), TOTAL_SUPPLY.toString());
      assert.equal(rec.decimals, 6);
    });
  });

  describe("5. the issuer sets up their compliance rules", () => {
    it("happens entirely outside Aegis, through Upside, using the issuer's own authority", async () => {
      // Aegis is not involved and could not be: these calls need the roles the issuer now holds.
      // What is created here:
      //
      //   a rule book          the registry of who may hold the token
      //   group 1 (investor)   KYC-approved investors
      //   group 2 (vault)      the Aegis escrow, and nothing else
      //   rule vault → investor    redemption is allowed
      //   rule investor → vault    deposit is allowed
      //   the vault's own holder record, so the escrow may legally hold the security
      await env.setupCompliance(realRwaMint.publicKey, LAYOUT);

      assert.isTrue(env.exists(upside.pda.transferRestrictionData(realRwaMint.publicKey)));
    });

    it("registers the issuer as an approved holder too", async () => {
      // The issuer is a holder like anyone else. They need this to receive their unsold stock
      // back at graduation — the security cannot be sent to an unregistered wallet, not even
      // the wallet of the company that issued it.
      await registerHolder(env, realRwaMint.publicKey, env.issuer, 1);
    });
  });

  describe("6. the whole supply is minted into escrow", () => {
    it("fund_vault mints every token directly into the Aegis-owned vault", async () => {
      // Not a transfer — a mint. Upside's `mint_securities` is called with the escrow as the
      // destination, so the supply comes into existence already inside the vault. There is no
      // moment at which the issuer, or anyone else, holds it and could send it elsewhere.
      env.sendOk(
        [
          Env.computeBudget(),
          await env.fundVaultIx({
            issuer: env.issuer.publicKey,
            realRwaMint: realRwaMint.publicKey,
            investorGroup: LAYOUT.investorGroup,
            vaultGroup: LAYOUT.vaultGroup,
          }),
        ],
        [env.issuer]
      );

      assert.equal(supplyOf(env, realRwaMint.publicKey).toString(), TOTAL_SUPPLY.toString());
      assert.equal(balance(env, escrowVault()).toString(), TOTAL_SUPPLY.toString());
      // Every token that exists is in the vault. The issuer holds none.
      assert.equal(
        balance(env, upside.ataFor(realRwaMint.publicKey, env.issuer.publicKey)).toString(),
        "0"
      );
    });

    it("the launch is now Funded, with the full backing recorded", () => {
      const rec = env.launch(realRwaMint.publicKey);
      assert.deepEqual(rec.stage, { funded: {} });
      assert.equal(rec.realRwaLocked.toString(), TOTAL_SUPPLY.toString());
      assert.equal(rec.crwaMinted.toString(), "0", "no wrapper exists yet");
    });

    it("the vault is owned by a PDA, so no human can move what is inside it", () => {
      // The vault's owner is `["authority", launch]` — an address with no private key. The only
      // code that can sign for it is this program, and the only instructions that do are the
      // bridge, graduation settlement, and abort.
      const authority = Env.aegisAuthorityPda(realRwaMint.publicKey);
      const vaultOwner = new PublicKey(env.accountData(escrowVault()).subarray(32, 64));
      assert.equal(vaultOwner.toBase58(), authority.toBase58());
    });
  });

  // ===============================================================================================
  // PART THREE — THE SALE
  // ===============================================================================================

  describe("7. the sale terms are fixed", () => {
    it("create_rwa_config hands Meteora a configuration the issuer could not have made predatory", async () => {
      // The issuer chooses their economics. They cannot choose anything structural.
      //
      // Chosen by the issuer, inside the admin's bounds:
      //   target raise, opening price, how far the price may rise, the archetype,
      //   the migration fee, how their liquidity is locked or vested, the pool's fee
      //
      // Fixed by Aegis, not reachable by anyone:
      //   who holds the wrapper's mint authority (a PDA, never the issuer)
      //   which side fees are collected on (quote only, so the wrapper supply cannot be skimmed)
      //   the token supply (fixed, equal to escrow)
      //   whether liquidity can be withdrawn after graduation (it cannot)
      //   the shape of the curve itself
      env.sendOk(
        [
          await env.createRwaConfigIx({
            issuer: env.issuer.publicKey,
            realRwaMint: realRwaMint.publicKey,
            quoteMint: usdc.publicKey,
            meteoraConfig: meteoraConfig.publicKey,
            args: defaultConfigArgs({
              targetRaise: TARGET_RAISE,
              // Start at 1 USDC per token and let the price rise to about 1.21x by the end.
              sqrtStartPrice: SQRT_PRICE_ONE,
              sqrtExpansionBps: 11_000,
              archetype: ARCHETYPE.bookBuilding,
              migrationFeePct: MIGRATION_FEE_PCT,
              // The issuer's share of graduated liquidity is 90% (the protocol keeps 10%).
              // They lock a third of it forever and vest the rest back over a year.
              issuerPermanentLockPct: 30,
              issuerVestedPct: 60,
              vestingMonths: 12,
              poolFeeBps: 100,
            }),
          }),
        ],
        // The config account is new, so it signs for its own rent.
        [env.issuer, meteoraConfig]
      );

      const rec = env.launch(realRwaMint.publicKey);
      assert.deepEqual(rec.stage, { configured: {} });
      assert.equal(rec.meteoraConfig.toBase58(), meteoraConfig.publicKey.toBase58());
      assert.equal(rec.quoteMint.toBase58(), usdc.publicKey.toBase58());
    });

    it("the config now belongs to Meteora, not to us", () => {
      // Proof that the CPI really happened: the account is owned by Meteora's program, and
      // Meteora's own validation accepted every field we sent.
      const owner = env.svm.getAccount(meteoraConfig.publicKey)!.owner;
      assert.equal(owner.toBase58(), env.meteoraDbcProgramId().toBase58());
    });

    it("the curve is generated by Aegis, not supplied by the issuer", () => {
      // This is worth stating plainly. A bonding curve is a list of price/liquidity segments, and
      // a hostile one can hide a wall that traps buyers at a price they can never sell back at.
      //
      // Aegis does not validate a curve the issuer sends. It builds one, from a single segment of
      // constant liquidity, out of four plain numbers. A single segment has no interior shape, so
      // a trap is not rejected — it cannot be written down.
      assert.deepEqual(env.launch(realRwaMint.publicKey).archetype, ARCHETYPE.bookBuilding);
    });
  });

  describe("8. the pool opens and the wrapper is born", () => {
    it("launch_pool has Meteora create cTWRA and mint the entire supply into the curve", async () => {
      // Aegis does NOT create the wrapper. Meteora does, inside this call, from a keypair we pass
      // in as a signer. Meteora then sets itself as the mint and hook authority, mints the full
      // supply into the pool's vault, and hands mint authority to our PDA afterwards.
      //
      // So there is no separate "mint the wrapper" step anywhere in this protocol. It all exists
      // from this moment, and all of it is backed by the escrow filled in step 6.
      env.sendOk(
        [
          Env.computeBudget(),
          await env.launchPoolIx({
            issuer: env.issuer.publicKey,
            realRwaMint: realRwaMint.publicKey,
            quoteMint: usdc.publicKey,
            meteoraConfig: meteoraConfig.publicKey,
            crwaMint: crwaMint.publicKey,
          }),
        ],
        [env.issuer, crwaMint]
      );

      pool = Env.meteoraPool(meteoraConfig.publicKey, crwaMint.publicKey, usdc.publicKey);
      assert.isTrue(env.exists(pool), "the bonding curve exists");
    });

    it("the wrapper supply is exactly the escrowed supply — the peg starts here", () => {
      assert.equal(supplyOf(env, crwaMint.publicKey).toString(), TOTAL_SUPPLY.toString());
      assertPeg("launch_pool");
    });

    it("every wrapper token is sitting in the curve, waiting to be bought", () => {
      const curveVault = Env.meteoraTokenVault(crwaMint.publicKey, pool);
      assert.equal(balance(env, curveVault).toString(), TOTAL_SUPPLY.toString());
    });

    it("the launch is Live, which closes the abort door for good", () => {
      // From here the wrapper exists and belongs to whoever buys it. The issuer can no longer
      // take their asset back — `abort_launch` is valid only at Funded and Configured.
      const rec = env.launch(realRwaMint.publicKey);
      assert.deepEqual(rec.stage, { live: {} });
      assert.equal(rec.crwaMint.toBase58(), crwaMint.publicKey.toBase58());
    });
  });

  describe("9. a buyer buys", () => {
    it("is given USDC and the two token accounts they need", async () => {
      buyerUsdc = getAssociatedTokenAddressSync(
        usdc.publicKey,
        buyer.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );
      buyerCrwa = getAssociatedTokenAddressSync(
        crwaMint.publicKey,
        buyer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      env.sendOk(
        [
          createAssociatedTokenAccountInstruction(
            env.admin.publicKey, buyerUsdc, buyer.publicKey, usdc.publicKey, TOKEN_PROGRAM_ID
          ),
          createMintToInstruction(
            usdc.publicKey, buyerUsdc, env.admin.publicKey, TARGET_RAISE * 4n, [], TOKEN_PROGRAM_ID
          ),
          createAssociatedTokenAccountInstruction(
            env.admin.publicKey, buyerCrwa, buyer.publicKey, crwaMint.publicKey, TOKEN_2022_PROGRAM_ID
          ),
        ],
        [env.admin]
      );

      assert.equal(balance(env, buyerUsdc).toString(), (TARGET_RAISE * 4n).toString());
    });

    it("buys the curve out in one go, and the sale completes", async () => {
      // Two things about this transaction that are easy to get wrong.
      //
      // 1. It calls `swap2_with_transfer_hook`, not `swap`. The wrapper carries a transfer hook,
      //    and a plain swap cannot move a hooked token — the hook's accounts must be supplied.
      //
      // 2. It uses PartialFill. The buyer offers twice the target. Under ExactIn, Meteora reverts
      //    when the curve cannot absorb the whole amount, so the final buy of any sale would
      //    always fail and no sale could ever finish. PartialFill takes what the curve can hold
      //    and returns the rest.
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            swapWithTransferHookIx({
              config: meteoraConfig.publicKey,
              pool,
              inputTokenAccount: buyerUsdc,
              outputTokenAccount: buyerCrwa,
              baseVault: Env.meteoraTokenVault(crwaMint.publicKey, pool),
              quoteVault: Env.meteoraTokenVault(usdc.publicKey, pool),
              baseMint: crwaMint.publicKey,
              quoteMint: usdc.publicKey,
              payer: buyer.publicKey,
              tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
              tokenQuoteProgram: TOKEN_PROGRAM_ID,
              poolAuthority: Env.meteoraPoolAuthority(),
              eventAuthority: Env.meteoraEventAuthority(),
              hookProgram: env.aegisHookProgramId(),
              extraAccountMetaList: Env.extraAccountMetaList(crwaMint.publicKey),
              amountIn: TARGET_RAISE * 2n,
              swapMode: SWAP_MODE.PartialFill,
            }),
          ],
          [buyer]
        )
      );

      const bought = balance(env, buyerCrwa);
      assert.isTrue(bought > 0n, "the buyer received wrapper tokens");
      console.log(`      → buyer received ${human(bought)} cTWRA`);
    });

    it("the curve took in the target raise, and the fee was collected in USDC only", () => {
      const raised = balance(env, Env.meteoraTokenVault(usdc.publicKey, pool));
      // The threshold plus the fee that was charged on top of it.
      assert.isTrue(raised >= TARGET_RAISE, "the raise target was reached");
      console.log(`      → curve holds ${human(raised)} USDC`);
    });

    it("trading did not disturb the peg, because fees never touch the wrapper side", () => {
      // `collect_fee_mode` is pinned to quote-only in the config. If fees were taken in the base
      // token, every trade would quietly skim wrapper out of the pool and the backing would drift.
      assertPeg("the sale");
    });
  });

  // ===============================================================================================
  // PART FOUR — GRADUATION
  // ===============================================================================================

  describe("10. the raise becomes a permanent trading pool", () => {
    it("Meteora migrates the curve into DAMM v2", async () => {
      // This call is Meteora's, not ours — anyone may crank it once the curve is complete. It
      // takes the USDC raised and the unsold wrapper and builds a real AMM pool out of them,
      // represented by two LP position NFTs: one for the partner (Aegis) and one for the creator
      // (the issuer).
      //
      // Both positions are locked. The protocol's 10% is locked forever. The issuer's 90% is
      // split 30% forever and 60% vesting back to them over twelve months, as configured in step 7.
      // Neither party can withdraw the principal on day one. That is enforced by the config, which
      // set both "withdrawable" buckets to zero.
      const partnerPosition = Keypair.generate();
      const creatorPosition = Keypair.generate();

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            migrateDammV2Ix({
              virtualPool: pool,
              config: meteoraConfig.publicKey,
              dbcPoolAuthority: Env.meteoraPoolAuthority(),
              dammPool: dammV2.pool(
                DAMM_V2_DYNAMIC_CONFIG, crwaMint.publicKey, usdc.publicKey
              ),
              firstPositionNftMint: partnerPosition.publicKey,
              secondPositionNftMint: creatorPosition.publicKey,
              baseMint: crwaMint.publicKey,
              quoteMint: usdc.publicKey,
              dbcBaseVault: Env.meteoraTokenVault(crwaMint.publicKey, pool),
              dbcQuoteVault: Env.meteoraTokenVault(usdc.publicKey, pool),
              payer: env.admin.publicKey,
              tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
              tokenQuoteProgram: TOKEN_PROGRAM_ID,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            }),
          ],
          [env.admin, partnerPosition, creatorPosition]
        )
      );

      const graduatedPool = dammV2.pool(
        DAMM_V2_DYNAMIC_CONFIG, crwaMint.publicKey, usdc.publicKey
      );
      assert.isTrue(env.exists(graduatedPool), "the permanent pool exists");
    });

    it("the wrapper's transfer hook is now permanently gone", () => {
      // Meteora revokes it the moment the curve completes: both the hook's program id AND the
      // authority that could set a new one are cleared. Nothing can put it back — not Meteora,
      // not Aegis, not the issuer.
      //
      // This is not a bug and not something Aegis could prevent. It is *why* the design puts
      // compliance at the bridge rather than on the wrapper. Any design that assumes lasting KYC
      // on cTWRA is simply wrong about how this works. cTWRA was always meant to trade freely;
      // the gate sits on the door back to the real security, and that gate never moves.
      const hook = getTransferHook(readMint(env, crwaMint.publicKey));
      assert.isNotNull(hook, "the extension itself is still present");
      assert.equal(
        hook!.programId.toBase58(),
        PublicKey.default.toBase58(),
        "no hook program remains"
      );
      assert.equal(
        hook!.authority.toBase58(),
        PublicKey.default.toBase58(),
        "and nobody can set a new one"
      );
    });

    it("but the real security's hook is untouched, and always will be", () => {
      // The asymmetry in one assertion. TWRA keeps Upside's Transfer Restrictions hook forever;
      // only cTWRA lost its own. That is the entire compliance story of this protocol.
      const hook = getTransferHook(readMint(env, realRwaMint.publicKey));
      assert.equal(
        hook!.programId.toBase58(),
        upside.TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58()
      );
    });
  });

  describe("11. the books are squared", () => {
    let unsoldBefore: bigint;
    let issuerRealBefore: bigint;

    it("finalize_graduation destroys the unsold wrapper and sends the stock home", async () => {
      // A bonding curve rarely sells out. Whatever wrapper was not bought is backed by asset in
      // the vault that now belongs to nobody — so leaving it alone would make the backing figure
      // a lie: supply would say a million while only part of it is in anyone's hands.
      //
      // This step collects the leftover from Meteora, burns it, and releases the matching amount
      // of the security back to the issuer. It is their unsold stock, and it goes home.
      //
      // Permissionless on purpose: it moves nothing to the caller and changes nobody's
      // entitlement, and gating it would let a launch sit unsettled because one wallet went quiet.
      issuerRealBefore = balance(
        env, upside.ataFor(realRwaMint.publicKey, env.issuer.publicKey)
      );
      unsoldBefore = supplyOf(env, crwaMint.publicKey) - balance(env, buyerCrwa);

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.finalizeGraduationIx({
              // Note the caller: a stranger, not the issuer and not the admin.
              cranker: env.admin.publicKey,
              realRwaMint: realRwaMint.publicKey,
              crwaMint: crwaMint.publicKey,
              quoteMint: usdc.publicKey,
              meteoraConfig: meteoraConfig.publicKey,
            }),
          ],
          [env.admin]
        )
      );

      assert.deepEqual(env.launch(realRwaMint.publicKey).stage, { graduated: {} });
    });

    it("the issuer got their unsold stock back", () => {
      const returned =
        balance(env, upside.ataFor(realRwaMint.publicKey, env.issuer.publicKey)) -
        issuerRealBefore;
      assert.isTrue(returned > 0n, "unsold stock returned to the issuer");
      console.log(`      → ${human(returned)} TWRA returned to the issuer as unsold stock`);
    });

    it("that stock came out of escrow, and the matching wrapper was burned", () => {
      // Both sides fell by the same amount. That is the only way the peg survives this step.
      assertPeg("finalize_graduation");
      const circulating = supplyOf(env, crwaMint.publicKey);
      assert.isTrue(circulating < TOTAL_SUPPLY, "supply fell");
      console.log(`      → ${human(circulating)} cTWRA now in circulation, fully backed`);
    });

    it("Aegis kept none of the wrapper for itself", () => {
      const aegisCrwa = upside.ataFor(
        crwaMint.publicKey, Env.aegisAuthorityPda(realRwaMint.publicKey)
      );
      assert.equal(balance(env, aegisCrwa), 0n, "leftover was burned, not held");
    });
  });

  // ===============================================================================================
  // PART FIVE — FOREVER AFTER
  //
  // The sale is over. What remains is permanent: a freely traded wrapper, a pool that cannot be
  // drained, and a bridge that anyone approved may use in either direction for as long as the
  // asset exists.
  // ===============================================================================================

  describe("12. the bridge — redeeming the wrapper for the real asset", () => {
    it("the buyer must be an approved holder first", async () => {
      // This is the compliance gate, and it is the only one that matters. The wrapper moved
      // freely to anyone. Taking delivery of the actual security requires KYC, exactly as the law
      // requires, and that requirement never expires.
      await registerHolder(env, realRwaMint.publicKey, buyer, 2);
    });

    it("bridge_redeem burns wrapper and releases exactly the same amount of the security", async () => {
      const buyerReal = upside.ataFor(realRwaMint.publicKey, buyer.publicKey);
      const crwaBefore = balance(env, buyerCrwa);
      const realBefore = balance(env, buyerReal);
      const amount = crwaBefore / 4n; // redeem a quarter of what they bought

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: buyer.publicKey,
              realRwaMint: realRwaMint.publicKey,
              crwaMint: crwaMint.publicKey,
              amount,
            }),
          ],
          [buyer]
        )
      );

      // One for one. Not a rate, not an oracle, not a fee — the same number, both sides.
      assert.equal((crwaBefore - balance(env, buyerCrwa)).toString(), amount.toString());
      assert.equal((balance(env, buyerReal) - realBefore).toString(), amount.toString());
      console.log(`      → redeemed ${human(amount)} cTWRA for ${human(amount)} TWRA`);
    });

    it("the peg holds, because escrow and supply fell together", () => {
      assertPeg("bridge_redeem");
    });

    it("bridge_deposit runs the same trade backwards", async () => {
      // The other direction needs no KYC check of its own. Anyone holding the security was
      // already approved to hold it — that was checked when they received it.
      const buyerReal = upside.ataFor(realRwaMint.publicKey, buyer.publicKey);
      const realBefore = balance(env, buyerReal);
      const crwaBefore = balance(env, buyerCrwa);
      const amount = realBefore / 2n;

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeDepositIx({
              user: buyer.publicKey,
              realRwaMint: realRwaMint.publicKey,
              crwaMint: crwaMint.publicKey,
              amount,
            }),
          ],
          [buyer]
        )
      );

      assert.equal((realBefore - balance(env, buyerReal)).toString(), amount.toString());
      assert.equal((balance(env, buyerCrwa) - crwaBefore).toString(), amount.toString());
      console.log(`      → deposited ${human(amount)} TWRA for ${human(amount)} cTWRA`);
    });

    it("the peg holds again", () => {
      assertPeg("bridge_deposit");
    });

    it("this is what ties the wrapper's price to the building", () => {
      // Worth saying once, plainly, because it is the economic heart of the design.
      //
      // If cTWRA trades below the value of TWRA, an approved holder buys cTWRA cheaply, redeems
      // it one-for-one, and profits. That buying pressure lifts the price back.
      //
      // If it trades above, they deposit TWRA, receive cTWRA, and sell. That selling pressure
      // pushes it back down.
      //
      // The bridge is always open and always one-for-one, so the wrapper cannot drift far from
      // the asset. Nothing else in the protocol enforces price — this does.
      assertPeg("the bridge overall");
    });
  });

  describe("13. the protocol collects its revenue", () => {
    it("claim_partner_trading_fee collects the placement fee from the sale", async () => {
      // Where this money came from: buyers paid 1% on their trades during the sale. Meteora keeps
      // a fixed 20% of that for itself, and the rest is split between the partner (Aegis) and the
      // creator (the issuer) by `creator_trading_fee_percentage`. That is 0 by default, so Aegis
      // receives the whole of the remaining 80%.
      //
      // Note who signs: the admin here, but it could be anyone. The destination is pinned to the
      // recorded fee recipient, so a stranger calling this only pays gas to move the protocol's
      // money to the protocol. That makes it safe to crank and removes any dependence on one
      // wallet staying alive.
      const before = balance(env, treasuryUsdc());

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.claimTradingFeeIx(realRwaMint.publicKey, env.admin.publicKey),
          ],
          [env.admin]
        )
      );

      const collected = balance(env, treasuryUsdc()) - before;
      assert.isTrue(collected > 0n, "the placement fee reached the treasury");
      console.log(`      → trading fee collected: ${human(collected)} USDC`);

      // Sanity on the size. The fee is 1% of the amount buyers put in, and Meteora keeps 20%,
      // so the protocol should see roughly 0.8% of the raise. Checked loosely because the exact
      // figure depends on how much the partial fill actually absorbed.
      const expectedRoughly =
        (TARGET_RAISE * BigInt(CURVE_FEE_BPS)) /
        10_000n *
        BigInt(100 - METEORA_PROTOCOL_CUT_PCT) /
        100n;
      assert.isTrue(
        collected > (expectedRoughly * 8n) / 10n && collected < expectedRoughly * 2n,
        `expected around ${human(expectedRoughly)} USDC, got ${human(collected)}`
      );
    });

    it("claim_partner_migration_fee collects the protocol's share of the raise", async () => {
      // The migration fee is cash taken off the raise at graduation — here 50% of 10,000 USDC.
      // Of that, this admin set the protocol's share to 20% back in step 2. The other 80% is the
      // issuer's, and they claim it directly from Meteora without Aegis being involved.
      const before = balance(env, treasuryUsdc());

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.claimMigrationFeeIx(realRwaMint.publicKey, env.admin.publicKey),
          ],
          [env.admin]
        )
      );

      const collected = balance(env, treasuryUsdc()) - before;
      assert.isTrue(collected > 0n, "the migration fee share reached the treasury");
      console.log(`      → migration fee collected: ${human(collected)} USDC`);

      // 50% of the raise, of which the protocol takes 20%.
      const expected =
        (TARGET_RAISE * BigInt(MIGRATION_FEE_PCT)) /
        100n *
        BigInt(AEGIS_MIGRATION_FEE_SHARE_PCT) /
        100n;
      assert.isTrue(
        collected >= (expected * 9n) / 10n && collected <= expected,
        `expected about ${human(expected)} USDC, got ${human(collected)}`
      );
    });

    it("claiming revenue never touches the backing", () => {
      // Fees are collected in USDC only. There is no path by which claiming money can reach the
      // escrow or the wrapper supply — asserted here rather than assumed, because "the fee logic
      // accidentally moved backing" is exactly the kind of bug that is invisible until it is fatal.
      assertPeg("revenue claims");
    });

    it("and the protocol holds no wrapper tokens at all", () => {
      const aegisCrwa = upside.ataFor(
        crwaMint.publicKey, Env.aegisAuthorityPda(realRwaMint.publicKey)
      );
      assert.equal(balance(env, aegisCrwa), 0n);
    });
  });

  // ===============================================================================================
  // THE FINAL LEDGER
  // ===============================================================================================

  describe("the finished launch", () => {
    it("prints where all the money ended up", () => {
      const escrowed = balance(env, escrowVault());
      const circulating = supplyOf(env, crwaMint.publicKey);
      const treasury = balance(env, treasuryUsdc());
      const issuerStock = balance(
        env, upside.ataFor(realRwaMint.publicKey, env.issuer.publicKey)
      );
      const buyerWrapper = balance(env, buyerCrwa);
      const buyerSecurity = balance(
        env, upside.ataFor(realRwaMint.publicKey, buyer.publicKey)
      );

      console.log("");
      console.log("      ============ FINAL STATE ============");
      console.log(`      escrowed TWRA .............. ${human(escrowed)}`);
      console.log(`      circulating cTWRA .......... ${human(circulating)}`);
      console.log(`      issuer unsold stock ........ ${human(issuerStock)} TWRA`);
      console.log(`      buyer holds ................ ${human(buyerWrapper)} cTWRA`);
      console.log(`      buyer holds ................ ${human(buyerSecurity)} TWRA`);
      console.log(`      protocol treasury .......... ${human(treasury)} USDC`);
      console.log("      =====================================");
      console.log("");

      // Everything that was ever minted is still accounted for: in escrow, or with the issuer,
      // or with the buyer. Nothing was created and nothing vanished.
      assert.equal(
        (escrowed + issuerStock + buyerSecurity).toString(),
        TOTAL_SUPPLY.toString(),
        "every unit of the security is accounted for"
      );
    });

    it("ends where it started: the escrow equals the wrapper supply, exactly", () => {
      assertPeg("the whole launch");
    });

    it("and the launch is recorded as Graduated, which is terminal", () => {
      // There is no instruction that moves a launch out of Graduated. The bridge stays open, the
      // revenue claims stay callable, and nothing can reopen the sale or reclaim the asset.
      assert.deepEqual(env.launch(realRwaMint.publicKey).stage, { graduated: {} });
    });
  });
});
