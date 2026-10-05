use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use dynamic_bonding_curve::cpi::accounts::CreateConfigWithTransferHookCtx;
use dynamic_bonding_curve::params::fee_parameters::{BaseFeeParameters, PoolFeeParameters};
use dynamic_bonding_curve::{
    ConfigParameters, LiquidityVestingInfoParams, LockedVestingParams, MigratedPoolFee,
    MigratedPoolMarketCapFeeSchedulerParams, MigrationFee, TokenSupplyParams,
};

use crate::constants::*;
use crate::curve::plan_curve;
use crate::errors::AegisError;
use crate::events::LaunchConfigured;
use crate::instructions::quote_token::require_active_quote_token;
use crate::state::{Launch, LaunchStage, PlatformConfig, QuoteToken, RwaCurveArchetype};

// ==========================================================================
// Meteora enum discriminants.
//
// `ConfigParameters` takes raw `u8`s. Naming them here means a reader can check each against
// Meteora's `state/config.rs` without decoding magic numbers, and a wrong value is visible
// rather than plausible.
// ==========================================================================

/// `CollectFeeMode::QuoteToken`. Fees accrue only in the quote token, so the base side is never
/// skimmed — which is what keeps cRWA supply exactly equal to the escrowed asset.
const COLLECT_FEE_QUOTE_ONLY: u8 = 0;
/// `MigrationOption::DammV2`. Option 0 (DAMM v1) is deprecated and rejected outright.
const MIGRATION_OPTION_DAMM_V2: u8 = 1;
/// `ActivationType::Timestamp`.
const ACTIVATION_TYPE_TIMESTAMP: u8 = 1;
/// `TokenType::Token2022`.
const TOKEN_TYPE_TOKEN_2022: u8 = 1;
/// `MigrationFeeOption::Customizable`, which lets us pin the graduated pool's fee.
const MIGRATION_FEE_OPTION_CUSTOMIZABLE: u8 = 6;
/// `BaseFeeMode::FeeSchedulerLinear`. With every scheduler factor at zero this degenerates into
/// a flat fee, which is what an RWA wants: a deterministic cost, not a decaying one.
const BASE_FEE_MODE_FLAT: u8 = 0;
/// `TokenAuthorityOption::PartnerUpdateAndMintAuthority`. Assigns cRWA mint authority to the
/// config's `fee_claimer` — for us, the launch's own PDA. Meteora only permits a mint-authority
/// option on transfer-hook configs, which is the sole reason `aegis_hook` exists.
const TOKEN_AUTHORITY_PARTNER_MINT: u8 = 4;

/// Meteora's fee denominator: a numerator of `FEE_DENOMINATOR` would be a 100% fee.
const FEE_DENOMINATOR: u64 = 1_000_000_000;
/// Basis points in one whole.
const BPS_DENOMINATOR: u64 = 10_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateRwaConfigArgs {
    /// Opening price as a Q64.64 sqrt price. Derived by the frontend from a human price; an
    /// issuer never types this.
    pub sqrt_start_price: u128,

    /// How far the *sqrt* price may travel over the sale, in basis points. 10_000 is flat.
    /// Expressed against the sqrt price so no square root is needed on-chain; a sqrt multiple
    /// of `m` is a price multiple of `m²`.
    pub sqrt_expansion_bps: u32,

    /// Quote-token atoms to raise. Becomes Meteora's migration threshold.
    pub target_raise: u64,

    /// Bounds how far the price may expand. See `curve::RwaCurveArchetype`.
    pub archetype: RwaCurveArchetype,

    /// Percentage of the raise diverted out of the graduated pool at migration and paid to the
    /// issuer and Aegis.
    ///
    /// This is the only channel that delivers raised capital at all: Meteora turns the migration
    /// threshold into pool liquidity, and the rest of it is locked. With this at zero an issuer
    /// raises nothing, which is a silent and expensive surprise — hence the floor below.
    pub migration_fee_pct: u8,

    /// Of the liquidity that belongs to the issuer, the share locked forever.
    ///
    /// Permanently locked liquidity can never be withdrawn by anyone. Its fees still flow to the
    /// issuer; the principal stays in the pool as a permanent floor under the wrapper's price.
    pub issuer_permanent_lock_pct: u8,

    /// Of the liquidity that belongs to the issuer, the share released on a schedule.
    ///
    /// Together with `issuer_permanent_lock_pct` this must account for the issuer's entire
    /// share. There is deliberately no third bucket: liquidity that is withdrawable on day one
    /// is the exit a launchpad exists to prevent.
    pub issuer_vested_pct: u8,

    /// How many 30-day periods that vested share unlocks over. Must be zero when nothing vests.
    pub vesting_months: u16,

    /// Swap fee on the graduated pool, in basis points.
    pub pool_fee_bps: u16,
}

/// Launch step 3: fix the sale terms with Meteora.
///
/// Creates the Meteora config the pool will later be built from. Almost every field is chosen by
/// Aegis rather than the issuer, because most of Meteora's configuration surface is a rug vector
/// when it is left open: mint authority, fee collection side, liquidity locking, token supply.
///
/// The issuer chooses their own economic terms, inside bounds the protocol admin sets in
/// `PlatformConfig`. What they cannot choose is anything structural — mint authority, fee
/// collection side, token supply, whether liquidity can be withdrawn — because each of those is
/// a rug vector when left open. The curve itself is derived rather than accepted, so a
/// predatory shape is not rejected; it cannot be expressed. See `crate::curve`.
#[derive(Accounts)]
pub struct CreateRwaConfig<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
    )]
    pub platform_config: Box<Account<'info, PlatformConfig>>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, launch.real_rwa_mint.as_ref()],
        bump = launch.bump,
        has_one = issuer @ AegisError::NotLaunchIssuer,
    )]
    pub launch: Box<Account<'info, Launch>>,

    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Proof that the admin approved this quote token. Its existence is the whitelist.
    #[account(
        seeds = [QUOTE_TOKEN_SEED, quote_mint.key().as_ref()],
        bump = quote_token.bump,
    )]
    pub quote_token: Box<Account<'info, QuoteToken>>,

    /// CHECK: signer-only PDA, carries no data.
    ///
    /// Meteora overloads `fee_claimer` with four roles at once: partner fee recipient, partner
    /// LP position owner, partner migration-fee claimant, and — with the authority option below
    /// — cRWA mint authority. All four must therefore land on something that can sign a CPI,
    /// which rules out a plain treasury wallet.
    /// Derived canonically rather than from `launch.authority_bump`. The stored bump is only
    /// written at `fund_vault`, so trusting it here would make an out-of-order call fail with an
    /// opaque seeds error instead of naming the real problem. Nothing signs with this PDA in
    /// this instruction — it is only recorded as Meteora's partner — so re-deriving costs a
    /// little compute and nothing else.
    #[account(
        seeds = [AEGIS_AUTHORITY_SEED, launch.key().as_ref()],
        bump,
    )]
    pub aegis_authority: UncheckedAccount<'info>,

    /// CHECK: a fresh keypair. Meteora initializes it inside the CPI, so it arrives empty and
    /// must sign for its own rent.
    #[account(mut)]
    pub meteora_config: Signer<'info>,

    /// CHECK: pinned to the official program. Without this constraint an attacker could pass
    /// their own program and have Aegis call it with the issuer as payer — and the event
    /// authority below, being derived from whatever program is passed, would validate nothing.
    #[account(address = METEORA_DBC_PROGRAM_ID @ AegisError::InvalidDbcProgram)]
    pub meteora_dbc_program: UncheckedAccount<'info>,

    /// CHECK: Meteora's own event-authority PDA, derived from the pinned program above.
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = METEORA_DBC_PROGRAM_ID,
    )]
    pub meteora_event_authority: UncheckedAccount<'info>,

    /// CHECK: the Aegis hook, pinned by address and required by Meteora to be executable.
    ///
    /// It approves every transfer. It exists only because Meteora refuses to grant mint
    /// authority on a non-hook config, and mint authority is what the bridge runs on.
    #[account(
        executable,
        address = aegis_hook::ID @ AegisError::InvalidHookProgram,
    )]
    pub aegis_hook_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateRwaConfig>, args: CreateRwaConfigArgs) -> Result<()> {
    let platform = &ctx.accounts.platform_config;

    require!(!platform.is_paused, AegisError::ProtocolPaused);
    require!(
        ctx.accounts.launch.stage == LaunchStage::Funded,
        AegisError::InvalidLaunchStage
    );

    require_active_quote_token(&ctx.accounts.quote_token, &ctx.accounts.quote_mint.key())?;

    // A launch too small to be worth listing wastes the admin's whitelist and the buyers' time,
    // and the floor is per quote token because "small" means nothing without a denomination.
    require!(
        args.target_raise >= ctx.accounts.quote_token.min_raise,
        AegisError::RaiseBelowMinimum
    );

    // The migration fee is the issuer's capital channel, so it is bounded at both ends: too high
    // starves the graduated pool, and zero means the issuer walks away from their own raise with
    // nothing.
    require!(
        args.migration_fee_pct >= platform.min_migration_fee_pct,
        AegisError::MigrationFeeTooLow
    );
    require!(
        args.migration_fee_pct <= platform.max_migration_fee_pct,
        AegisError::MigrationFeeTooHigh
    );

    // ------------------------------------------------------------------
    // The issuer's liquidity split.
    //
    // Aegis takes a fixed share of the graduated liquidity and locks it forever. What is left is
    // the issuer's, and they decide how much of it is locked forever and how much unlocks over
    // time. The two must account for their whole share — there is no bucket for liquidity that
    // can simply be pulled, because that is the exit this protocol exists to close.
    // ------------------------------------------------------------------
    require!(
        platform.aegis_lp_share_pct <= 100,
        AegisError::InvalidPercentage
    );
    let issuer_lp_share_pct = 100u8
        .checked_sub(platform.aegis_lp_share_pct)
        .ok_or(AegisError::InvalidPercentage)?;

    let issuer_split = args
        .issuer_permanent_lock_pct
        .checked_add(args.issuer_vested_pct)
        .ok_or(AegisError::InvalidLiquiditySplit)?;
    require_eq!(
        issuer_split,
        issuer_lp_share_pct,
        AegisError::InvalidLiquiditySplit
    );
    require!(
        args.issuer_permanent_lock_pct >= platform.min_issuer_permanent_pct,
        AegisError::PermanentLockTooLow
    );

    // Vesting is described in whole 30-day periods. The schedule and the amount have to agree in
    // both directions: months without a vested share is a schedule for nothing, and a vested
    // share without months would ask Meteora to release it all at once.
    let creator_liquidity_vesting_info = if args.issuer_vested_pct > 0 {
        require!(
            args.vesting_months >= platform.min_vesting_months
                && args.vesting_months <= platform.max_vesting_months,
            AegisError::InvalidVestingMonths
        );
        // Whole basis points per period. Any remainder from the division simply stays locked
        // past the final period, which is the safe direction to round: liquidity is never
        // released early, only a dust fraction late.
        let bps_per_period = (BPS_DENOMINATOR / args.vesting_months as u64) as u16;
        require!(bps_per_period > 0, AegisError::InvalidVestingMonths);
        LiquidityVestingInfoParams {
            vesting_percentage: args.issuer_vested_pct,
            bps_per_period,
            number_of_periods: args.vesting_months,
            // Unlocking begins one period after migration rather than immediately, which is
            // what `number_of_periods > 0` already gives us; no separate cliff is needed.
            cliff_duration_from_migration_time: 0,
            frequency: VESTING_PERIOD_SECONDS as u32,
        }
    } else {
        require_eq!(args.vesting_months, 0, AegisError::InvalidVestingMonths);
        LiquidityVestingInfoParams::default()
    };

    // The graduated pool's swap fee. Meteora's own range is 10..=1000 bps; the admin narrows it
    // further, and the issuer picks inside that.
    require!(
        args.pool_fee_bps >= platform.min_pool_fee_bps
            && args.pool_fee_bps <= platform.max_pool_fee_bps
            && args.pool_fee_bps >= METEORA_MIN_POOL_FEE_BPS
            && args.pool_fee_bps <= METEORA_MAX_POOL_FEE_BPS,
        AegisError::InvalidFeeBps
    );

    // ------------------------------------------------------------------
    // Protocol revenue. None of this is the issuer's to set.
    // ------------------------------------------------------------------
    require!(
        platform.curve_fee_bps >= METEORA_MIN_FEE_BPS
            && platform.curve_fee_bps <= MAX_CURVE_FEE_BPS,
        AegisError::InvalidFeeBps
    );
    let curve_fee_numerator = (platform.curve_fee_bps as u64)
        .checked_mul(FEE_DENOMINATOR)
        .and_then(|n| n.checked_div(BPS_DENOMINATOR))
        .ok_or(AegisError::InvalidFeeBps)?;

    require!(
        platform.issuer_curve_fee_share_pct <= 100,
        AegisError::InvalidPercentage
    );
    require!(
        platform.aegis_migration_fee_share_pct <= 100,
        AegisError::InvalidPercentage
    );
    // Meteora reads this as the *creator's* share, so Aegis's share is the remainder. Splitting
    // a fee that does not exist is rejected by Meteora, so a zero fee forces a zero split; that
    // is only reachable if the admin lowered the floor to zero.
    let issuer_migration_fee_share_pct = if args.migration_fee_pct == 0 {
        0
    } else {
        100u8
            .checked_sub(platform.aegis_migration_fee_share_pct)
            .ok_or(AegisError::InvalidPercentage)?
    };

    // ------------------------------------------------------------------
    // Build the curve.
    //
    // Derived from the issuer's economic terms rather than accepted from them. A single segment
    // of constant liquidity has no interior shape, so hidden spikes and liquidity traps are not
    // rejected — they cannot be expressed. See `crate::curve`.
    // ------------------------------------------------------------------
    let plan = plan_curve(
        args.sqrt_start_price,
        args.sqrt_expansion_bps,
        args.target_raise,
        args.archetype,
        ctx.accounts.launch.total_supply,
    )?;

    // ------------------------------------------------------------------
    // The non-negotiable payload.
    // ------------------------------------------------------------------
    let config_params = ConfigParameters {
        // A flat fee at the platform's rate. A fee *scheduler* would let a launch open at a
        // punitive rate that decays once early buyers are in, so every scheduler factor is
        // pinned to zero and the fee is the same for the first buyer and the last.
        pool_fees: PoolFeeParameters {
            base_fee: BaseFeeParameters {
                base_fee_mode: BASE_FEE_MODE_FLAT,
                cliff_fee_numerator: curve_fee_numerator,
                first_factor: 0,  // number_of_period
                second_factor: 0, // period_frequency
                third_factor: 0,  // reduction_factor
            },
            // Volatility-driven fees make the cost of buying unpredictable, which is the wrong
            // property for a regulated instrument.
            dynamic_fee: None,
        },

        // Fees in quote only. Collecting in the base token would siphon cRWA out of the pool and
        // break the one-to-one backing.
        collect_fee_mode: COLLECT_FEE_QUOTE_ONLY,
        migration_option: MIGRATION_OPTION_DAMM_V2,
        activation_type: ACTIVATION_TYPE_TIMESTAMP,
        token_type: TOKEN_TYPE_TOKEN_2022,
        token_decimal: ctx.accounts.launch.decimals,

        // Aegis's share is locked forever, without exception — it is what guarantees Meteora's
        // 10% still-locked floor holds no matter what the issuer chose. The issuer's share is
        // split between permanent locking and vesting as validated above. Both
        // `*_liquidity_percentage` fields — the withdrawable buckets — are zero on purpose: no
        // party can pull graduated liquidity out of this pool. Fees still accrue to the position
        // owners; the principal is another matter.
        partner_permanent_locked_liquidity_percentage: platform.aegis_lp_share_pct,
        creator_permanent_locked_liquidity_percentage: args.issuer_permanent_lock_pct,
        partner_liquidity_percentage: 0,
        creator_liquidity_percentage: 0,
        partner_liquidity_vesting_info: LiquidityVestingInfoParams::default(),
        creator_liquidity_vesting_info,

        migration_quote_threshold: args.target_raise,
        sqrt_start_price: plan.sqrt_start_price,
        curve: plan.to_meteora_curve(),

        // No cRWA vesting. A vesting schedule would hold back wrapper tokens that the escrowed
        // asset is already backing, so the peg ledger could not be read from supply alone.
        locked_vesting: LockedVestingParams::default(),

        // Fixed supply, equal to the escrowed asset. This is the peg, expressed to Meteora:
        // every cRWA that will ever exist at launch is matched by a Real RWA already in the
        // vault. Whatever the curve does not sell returns to Aegis as leftover.
        token_supply: Some(TokenSupplyParams {
            pre_migration_token_supply: ctx.accounts.launch.total_supply,
            post_migration_token_supply: ctx.accounts.launch.total_supply,
        }),

        migration_fee_option: MIGRATION_FEE_OPTION_CUSTOMIZABLE,
        migrated_pool_fee: MigratedPoolFee {
            collect_fee_mode: COLLECT_FEE_QUOTE_ONLY,
            dynamic_fee: 0,
            // Validated above against both Meteora's range and the admin's narrower one.
            pool_fee_bps: args.pool_fee_bps,
        },
        migrated_pool_base_fee_mode: 0,
        migrated_pool_market_cap_fee_scheduler_params:
            MigratedPoolMarketCapFeeSchedulerParams::default(),
        compounding_fee_bps: 0,

        migration_fee: MigrationFee {
            fee_percentage: args.migration_fee_pct,
            creator_fee_percentage: issuer_migration_fee_share_pct,
        },

        // Mint authority to `fee_claimer`, which is the launch's Aegis PDA. Never to the
        // creator: that option exists in Meteora and would hand the issuer unlimited cRWA
        // minting, which is precisely the rug this protocol claims to prevent.
        token_update_authority: TOKEN_AUTHORITY_PARTNER_MINT,

        // The issuer's cut of the curve's trading fee. Set by the admin, not by the issuer: it
        // is a split of the protocol's placement fee, so letting the issuer choose it would let
        // them take all of it.
        creator_trading_fee_percentage: platform.issuer_curve_fee_share_pct,

        // Aegis charges its own creation fee at `create_rwa`; Meteora's is left at zero so the
        // issuer is not billed twice for the same launch.
        pool_creation_fee: 0,
        enable_first_swap_with_min_fee: false,
        padding: [0; 2],
    };

    // ------------------------------------------------------------------
    // Create the config.
    // ------------------------------------------------------------------
    dynamic_bonding_curve::cpi::create_config_with_transfer_hook(
        CpiContext::new(
            ctx.accounts.meteora_dbc_program.key(),
            CreateConfigWithTransferHookCtx {
                config: ctx.accounts.meteora_config.to_account_info(),
                // Both the partner role and the leftover destination are the launch PDA.
                // Leftover in particular must not be a wallet: unsold cRWA is backed by escrowed
                // asset, so it has to come back somewhere the program can act on.
                fee_claimer: ctx.accounts.aegis_authority.to_account_info(),
                leftover_receiver: ctx.accounts.aegis_authority.to_account_info(),
                quote_mint: ctx.accounts.quote_mint.to_account_info(),
                transfer_hook_program: ctx.accounts.aegis_hook_program.to_account_info(),
                payer: ctx.accounts.issuer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.meteora_event_authority.to_account_info(),
                program: ctx.accounts.meteora_dbc_program.to_account_info(),
            },
        ),
        config_params,
    )?;

    // ------------------------------------------------------------------
    // Record.
    // ------------------------------------------------------------------
    let launch = &mut ctx.accounts.launch;
    launch.meteora_config = ctx.accounts.meteora_config.key();
    launch.quote_mint = ctx.accounts.quote_mint.key();
    launch.archetype = args.archetype;
    launch.stage = LaunchStage::Configured;

    emit!(LaunchConfigured {
        launch: launch.key(),
        meteora_config: launch.meteora_config,
        quote_mint: launch.quote_mint,
        archetype: launch.archetype,
        target_raise: args.target_raise,
        sqrt_start_price: plan.sqrt_start_price,
        sqrt_end_price: plan.sqrt_end_price,
        migration_sqrt_price: plan.migration_sqrt_price,
        migration_fee_pct: args.migration_fee_pct,
    });

    msg!(
        "Aegis: config {} for {}",
        launch.meteora_config,
        launch.real_rwa_mint
    );
    msg!(
        "Curve: sqrt {} -> {} (sale closes at {})",
        plan.sqrt_start_price,
        plan.sqrt_end_price,
        plan.migration_sqrt_price
    );
    msg!(
        "Raise {} {}, selling up to {} of {} tokens",
        args.target_raise,
        launch.quote_mint,
        plan.base_tokens_with_buffer,
        launch.total_supply
    );

    Ok(())
}
