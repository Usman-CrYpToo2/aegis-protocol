use anchor_lang::prelude::*;
use crate::errors::AegisError;

use crate::constants::*;
use crate::state::PlatformConfig;

#[derive(Accounts)]
pub struct UpdatePlatformConfig<'info> {
    /// The current protocol administrator.
    ///
    /// `has_one = admin` below ensures this signer matches the
    /// administrator stored inside the PlatformConfig PDA.
    /// Seeds are pinned as well as `has_one`. Only one `PlatformConfig` can exist, because
    /// `initialize_platform` creates it at this address with `init`, so the address check is
    /// redundant today — but every other instruction reaches the config by seeds, and leaving
    /// one path that accepts any account of the right type is the kind of asymmetry that stops
    /// being harmless the moment a second config becomes creatable.
    #[account(
        mut,
        seeds = [crate::constants::PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
        has_one = admin @AegisError::Unauthorized
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// The current protocol administrator who is authorized
    /// to modify the configuration.
    pub admin: Signer<'info>,

    /// CHECK: when supplied, becomes the new fee recipient.
    ///
    /// Taken as an account rather than a bare pubkey so its owner can be checked. A fee
    /// recipient owned by another program cannot receive a plain lamport transfer, which would
    /// make `create_rwa` fail and halt every launch until an admin noticed and changed it back.
    #[account(
        owner = anchor_lang::system_program::ID @ AegisError::InvalidFeeRecipient,
    )]
    pub new_fee_recipient: Option<UncheckedAccount<'info>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdatePlatformConfigParams {
    /// Optional new protocol administrator.
    pub admin: Option<Pubkey>,

    /// Optional new pool creation fee, in lamports.
    pub creation_fee_lamports: Option<u64>,

    /// Optional new pause state.
    pub is_paused: Option<bool>,

    // ---- protocol revenue ----
    /// Placement fee on the sale, in basis points. Meteora's own floor is 25.
    pub curve_fee_bps: Option<u16>,
    /// The issuer's share of that placement fee.
    pub issuer_curve_fee_share_pct: Option<u8>,
    /// The protocol's share of the migration fee.
    pub aegis_migration_fee_share_pct: Option<u8>,
    /// Share of graduated liquidity permanently locked to the protocol.
    pub aegis_lp_share_pct: Option<u8>,

    // ---- bounds on issuer choices ----
    pub min_migration_fee_pct: Option<u8>,
    pub max_migration_fee_pct: Option<u8>,
    pub min_issuer_permanent_pct: Option<u8>,
    pub min_vesting_months: Option<u16>,
    pub max_vesting_months: Option<u16>,
    pub min_pool_fee_bps: Option<u16>,
    pub max_pool_fee_bps: Option<u16>,
}

pub fn handler(
    ctx: Context<UpdatePlatformConfig>,
    parameters: UpdatePlatformConfigParams,
) -> Result<()> {
    let platform_config = &mut ctx.accounts.platform_config;

    // Update protocol administrator if supplied.
    if let Some(new_admin) = parameters.admin {
        require!(
            new_admin != Pubkey::default(),
            AegisError::InvalidAdmin
        );

        platform_config.admin = new_admin;
    }

    // Update treasury / fee recipient if supplied. Validated by the account constraint above.
    if let Some(new_fee_recipient) = &ctx.accounts.new_fee_recipient {
        platform_config.fee_recipient = new_fee_recipient.key();
    }

    // Update pool creation fee if supplied.
    if let Some(new_creation_fee) = parameters.creation_fee_lamports {
        platform_config.creation_fee_lamports = new_creation_fee;
    }

    // Update global pause state if supplied.
    if let Some(new_is_paused) = parameters.is_paused {
        platform_config.is_paused = new_is_paused;
    }

    // ------------------------------------------------------------------
    // Protocol revenue.
    // ------------------------------------------------------------------
    if let Some(bps) = parameters.curve_fee_bps {
        // Meteora rejects anything below 25 bps outright, and a placement fee above 10% would
        // be punitive on buyers rather than a fee.
        require!(
            (METEORA_MIN_FEE_BPS..=MAX_CURVE_FEE_BPS).contains(&bps),
            AegisError::InvalidFeeBps
        );
        platform_config.curve_fee_bps = bps;
    }
    if let Some(pct) = parameters.issuer_curve_fee_share_pct {
        require!(pct <= 100, AegisError::InvalidPercentage);
        platform_config.issuer_curve_fee_share_pct = pct;
    }
    if let Some(pct) = parameters.aegis_migration_fee_share_pct {
        require!(pct <= 100, AegisError::InvalidPercentage);
        platform_config.aegis_migration_fee_share_pct = pct;
    }
    if let Some(pct) = parameters.aegis_lp_share_pct {
        // Meteora requires at least 10% of graduated liquidity to be locked a day after
        // migration. The protocol's permanent share is what guarantees that floor is met even
        // if an issuer vests every last unit of theirs.
        require!(
            (MIN_AEGIS_LP_SHARE_PCT..=100).contains(&pct),
            AegisError::InvalidPercentage
        );
        platform_config.aegis_lp_share_pct = pct;
    }

    // ------------------------------------------------------------------
    // Bounds on issuer choices.
    // ------------------------------------------------------------------
    if let Some(pct) = parameters.min_migration_fee_pct {
        require!(pct <= 99, AegisError::InvalidPercentage);
        platform_config.min_migration_fee_pct = pct;
    }
    if let Some(pct) = parameters.max_migration_fee_pct {
        // Meteora caps the migration fee at 99%.
        require!(pct <= 99, AegisError::InvalidPercentage);
        platform_config.max_migration_fee_pct = pct;
    }
    if let Some(pct) = parameters.min_issuer_permanent_pct {
        require!(pct <= 100, AegisError::InvalidPercentage);
        platform_config.min_issuer_permanent_pct = pct;
    }
    if let Some(months) = parameters.min_vesting_months {
        platform_config.min_vesting_months = months;
    }
    if let Some(months) = parameters.max_vesting_months {
        require!(months <= MAX_VESTING_MONTHS, AegisError::InvalidVestingMonths);
        platform_config.max_vesting_months = months;
    }
    if let Some(bps) = parameters.min_pool_fee_bps {
        platform_config.min_pool_fee_bps = bps;
    }
    if let Some(bps) = parameters.max_pool_fee_bps {
        require!(
            (METEORA_MIN_POOL_FEE_BPS..=METEORA_MAX_POOL_FEE_BPS).contains(&bps),
            AegisError::InvalidFeeBps
        );
        platform_config.max_pool_fee_bps = bps;
    }

    // Every range must still be a range after the update, whichever end was touched.
    require!(
        platform_config.min_migration_fee_pct <= platform_config.max_migration_fee_pct,
        AegisError::InvalidPercentage
    );
    require!(
        platform_config.min_vesting_months <= platform_config.max_vesting_months,
        AegisError::InvalidVestingMonths
    );
    require!(
        platform_config.min_pool_fee_bps >= METEORA_MIN_POOL_FEE_BPS
            && platform_config.min_pool_fee_bps <= platform_config.max_pool_fee_bps,
        AegisError::InvalidFeeBps
    );
    // The issuer cannot be asked to lock more than they hold.
    require!(
        platform_config.min_issuer_permanent_pct
            <= 100u8.saturating_sub(platform_config.aegis_lp_share_pct),
        AegisError::InvalidPercentage
    );

    emit!(crate::events::PlatformConfigUpdated {
        admin: platform_config.admin,
        fee_recipient: platform_config.fee_recipient,
        creation_fee_lamports: platform_config.creation_fee_lamports,
        is_paused: platform_config.is_paused,
    });

    msg!("Aegis platform configuration updated.");
    msg!("Admin: {}", platform_config.admin);
    msg!("Fee recipient: {}", platform_config.fee_recipient);
    msg!(
        "Creation fee: {} lamports",
        platform_config.creation_fee_lamports
    );
    msg!("Paused: {}", platform_config.is_paused);

    Ok(())
}