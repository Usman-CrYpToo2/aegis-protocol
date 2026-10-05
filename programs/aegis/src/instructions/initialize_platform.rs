use anchor_lang::prelude::*;

use crate::constants::PLATFORM_CONFIG_SEED;
use crate::events::PlatformInitialized;
use crate::state::PlatformConfig;

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    /// Becomes the global protocol admin, and pays rent.
    ///
    /// Note this is first-caller-wins: nothing here proves the signer is the deployer. Handled
    /// as deployment procedure rather than in code — initialize in the same script as the
    /// deploy and verify `platform_config.admin` before announcing the program. See `audit.md`
    /// finding 5.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The singleton PDA that stores the global protocol configuration.
    #[account(
        init,
        payer = admin,
        space = 8 + PlatformConfig::INIT_SPACE, // 8 bytes for Anchor discriminator
        seeds = [PLATFORM_CONFIG_SEED],
        bump
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializePlatform>) -> Result<()> {
    let platform_config = &mut ctx.accounts.platform_config;

    // 1. Assign the caller as the master protocol administrator
    platform_config.admin = ctx.accounts.admin.key();

    // 2. Default the fee recipient to the admin's wallet.
    // (In a production environment, this would be updated to a DAO treasury or Squads multi-sig).
    platform_config.fee_recipient = ctx.accounts.admin.key();

    // 3. Set the default RWA pool creation fee to 1 SOL (1,000,000,000 lamports).
    platform_config.creation_fee_lamports = 1_000_000_000;

    // 4. Set the protocol to active.
    platform_config.is_paused = false;

    // 5. Economic defaults.
    //
    // The revenue model is one number: the protocol charges a 1% placement fee on the sale and
    // nothing else. Everything the issuer raises beyond that is theirs. The admin can change any
    // of this without redeploying.
    platform_config.curve_fee_bps = 100; // 1%
    platform_config.issuer_curve_fee_share_pct = 0; // the placement fee is the protocol's
    platform_config.aegis_migration_fee_share_pct = 0; // no second cut of the raise

    // The only permanently locked liquidity. Keeps a venue alive for holders who cannot use the
    // bridge, rather than serving as the anti-rug mechanism — the bridge already is that.
    platform_config.aegis_lp_share_pct = 10;

    // 6. Bounds on what the issuer may choose.
    platform_config.min_migration_fee_pct = 1;
    platform_config.max_migration_fee_pct = 90;
    // Vesting alone stops a day-one withdrawal, so no permanent lock is demanded of the issuer.
    platform_config.min_issuer_permanent_pct = 0;
    platform_config.min_vesting_months = 3;
    platform_config.max_vesting_months = 24;
    // Low, because a high pool fee is how far the price may drift from the asset's value before
    // anyone bothers to correct it.
    platform_config.min_pool_fee_bps = 10;
    platform_config.max_pool_fee_bps = 300;

    platform_config.bump = ctx.bumps.platform_config;

    emit!(PlatformInitialized {
        admin: platform_config.admin,
        fee_recipient: platform_config.fee_recipient,
        creation_fee_lamports: platform_config.creation_fee_lamports,
    });

    msg!("Aegis Protocol Initialized successfully.");
    msg!("Admin Authority: {}", platform_config.admin);
    msg!(
        "Platform Creation Fee: {} lamports",
        platform_config.creation_fee_lamports
    );

    Ok(())
}
