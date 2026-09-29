use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::access_control::accounts::AccessControl;
use crate::compliance::{verify_compliance, ComplianceInputs};
use crate::constants::*;
use crate::errors::AegisError;
use crate::events::LaunchAborted;
use crate::state::{Launch, LaunchStage};
use crate::token_hook::transfer_checked_with_hook;
use crate::transfer_restrictions::accounts::{
    SecurityAssociatedAccount, TransferRestrictionData, TransferRule,
};

/// Abandon a launch and release the asset, before any wrapper exists.
///
/// `fund_vault` escrows the **entire** supply. Until the pool is launched, the only ways out of
/// the vault are graduation and redemption, both of which require the launch to have gone live.
/// An issuer who stops in between — changes their mind, loses a key, cannot get a curve past the
/// firewall — would have their asset locked in escrow permanently, with no wrapper in existence
/// to redeem against it.
///
/// Valid only at `Funded` and `Configured`, and that boundary is the whole safety argument: at
/// those stages no cRWA exists and nobody has bought anything, so there is no holder whose claim
/// this could erase. From `Live` onward buyers exist and the asset is no longer the issuer's
/// alone to withdraw, so this must never be reachable there.
///
/// The asset returns through the same compliance path as any other transfer out of the vault.
/// The issuer is receiving a regulated security and is a holder like anyone else.
#[derive(Accounts)]
pub struct AbortLaunch<'info> {
    /// Only the issuer. Unlike settlement, this is not something a stranger should be able to
    /// trigger: it ends a launch.
    #[account(mut)]
    pub issuer: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, real_rwa_mint.key().as_ref()],
        bump = launch.bump,
        has_one = real_rwa_mint @ AegisError::ComplianceRegistryMismatch,
        has_one = issuer @ AegisError::NotLaunchIssuer,
        has_one = escrow_vault @ AegisError::VaultMintMismatch,
    )]
    pub launch: Box<Account<'info, Launch>>,

    pub real_rwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: signer-only PDA that owns the vault.
    #[account(
        seeds = [AEGIS_AUTHORITY_SEED, launch.key().as_ref()],
        bump = launch.authority_bump,
    )]
    pub aegis_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = real_rwa_mint,
        associated_token::authority = issuer,
        associated_token::token_program = token_program,
    )]
    pub issuer_real_rwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // ------------------------------------------------------------------
    // Upside compliance — unchanged from every other route out of the vault.
    // ------------------------------------------------------------------
    #[account(
        seeds = [b"ac", real_rwa_mint.key().as_ref()],
        bump,
        seeds::program = crate::access_control::ID,
    )]
    pub access_control: Box<Account<'info, AccessControl>>,

    #[account(
        seeds = [b"trd", real_rwa_mint.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub transfer_restriction_data: Box<Account<'info, TransferRestrictionData>>,

    #[account(
        seeds = [b"saa", escrow_vault.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub vault_saa: Box<Account<'info, SecurityAssociatedAccount>>,

    #[account(
        seeds = [b"saa", issuer_real_rwa_account.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub issuer_saa: Box<Account<'info, SecurityAssociatedAccount>>,

    #[account(
        seeds = [
            b"tr",
            transfer_restriction_data.key().as_ref(),
            launch.vault_group.to_le_bytes().as_ref(),
            launch.investor_group.to_le_bytes().as_ref(),
        ],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub redeem_rule: Box<Account<'info, TransferRule>>,

    /// CHECK: Upside's hook validation account for the asset.
    #[account(
        seeds = [b"extra-account-metas", real_rwa_mint.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub real_rwa_extra_metas: UncheckedAccount<'info>,

    /// CHECK: pinned to Upside's Transfer Restrictions program, the asset's hook.
    #[account(
        executable,
        address = crate::transfer_restrictions::ID @ AegisError::UnauthorizedTransferHook,
    )]
    pub transfer_restrictions_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<AbortLaunch>) -> Result<()> {
    let stage = ctx.accounts.launch.stage;
    require!(
        stage == LaunchStage::Funded || stage == LaunchStage::Configured,
        AegisError::InvalidLaunchStage
    );
    // Belt and braces on the boundary above. Nothing should be able to reach this instruction
    // once a wrapper exists, because from that point the asset backs somebody else's holding.
    require_eq!(
        ctx.accounts.launch.crwa_minted,
        0,
        AegisError::LaunchAlreadyLive
    );

    require_eq!(
        ctx.accounts.issuer_saa.group,
        ctx.accounts.launch.investor_group,
        AegisError::IssuerNotRegistered
    );

    verify_compliance(ComplianceInputs {
        launch: &ctx.accounts.launch,
        real_rwa_mint: &ctx.accounts.real_rwa_mint,
        access_control: &ctx.accounts.access_control,
        transfer_restriction_data: &ctx.accounts.transfer_restriction_data,
        vault: &ctx.accounts.escrow_vault,
        vault_saa: &ctx.accounts.vault_saa,
        redeem_rule: &ctx.accounts.redeem_rule,
        aegis_authority: &ctx.accounts.aegis_authority.key(),
        transfer_restriction_data_key: &ctx.accounts.transfer_restriction_data.key(),
    })?;

    // The whole balance, not the recorded figure. Anything donated into the vault belongs to the
    // issuer here for the same reason the rest does: no wrapper was ever issued against it.
    let amount = ctx.accounts.escrow_vault.amount;

    if amount > 0 {
        let launch_key = ctx.accounts.launch.key();
        let authority_bump = ctx.accounts.launch.authority_bump;
        let authority_seeds: &[&[u8]] =
            &[AEGIS_AUTHORITY_SEED, launch_key.as_ref(), &[authority_bump]];

        let hook_accounts = [
            ctx.accounts.transfer_restrictions_program.to_account_info(),
            ctx.accounts.real_rwa_extra_metas.to_account_info(),
            ctx.accounts.transfer_restriction_data.to_account_info(),
            ctx.accounts.vault_saa.to_account_info(),
            ctx.accounts.issuer_saa.to_account_info(),
            ctx.accounts.redeem_rule.to_account_info(),
        ];

        transfer_checked_with_hook(
            &ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_vault.to_account_info(),
            ctx.accounts.real_rwa_mint.to_account_info(),
            ctx.accounts.issuer_real_rwa_account.to_account_info(),
            ctx.accounts.aegis_authority.to_account_info(),
            &hook_accounts,
            amount,
            ctx.accounts.real_rwa_mint.decimals,
            &[authority_seeds],
        )?;
    }

    ctx.accounts.escrow_vault.reload()?;
    require_eq!(
        ctx.accounts.escrow_vault.amount,
        0,
        AegisError::VaultUnderfunded
    );

    // A terminal stage rather than closing the account. The launch record is the only durable
    // trace that this asset was ever escrowed, and every other instruction is gated on a stage
    // this is not, so nothing can act on it again.
    let launch = &mut ctx.accounts.launch;
    launch.real_rwa_locked = 0;
    launch.stage = LaunchStage::Aborted;
    launch.assert_backing()?;

    emit!(LaunchAborted {
        launch: launch.key(),
        real_rwa_mint: launch.real_rwa_mint,
        issuer: launch.issuer,
        returned: amount,
    });

    msg!("Aegis: launch aborted, {} returned to issuer", amount);
    Ok(())
}
