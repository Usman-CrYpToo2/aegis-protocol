use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::access_control::accounts::AccessControl;
use crate::compliance::{verify_compliance, ComplianceInputs};
use crate::constants::*;
use crate::errors::AegisError;
use crate::events::UnsoldClaimed;
use crate::state::{Launch, LaunchStage};
use crate::token_hook::transfer_checked_with_hook;
use crate::transfer_restrictions::accounts::{
    SecurityAssociatedAccount, TransferRestrictionData, TransferRule,
};

/// The issuer collects the asset behind the wrapper their sale never sold.
///
/// `finalize_graduation` records that amount as `issuer_unsold` and leaves it in the vault, so
/// that opening the bridge never depends on the issuer. This is the other half: the issuer takes
/// it out whenever they are a registered holder. Only the issuer is affected if they cannot.
///
/// **Holders are always covered first.** The vault can hold less than it should — the issuer
/// retains a securities issuer's power to move or burn from any account, the vault included. So
/// this pays at most what the vault holds *above* the cRWA supply. A loss the issuer's share can
/// absorb comes out of the issuer's share, never out of the backing of anyone's wrapper. Anything
/// that could not be paid stays owed, and can be claimed if the vault is later made whole.
///
/// It is also capped at `issuer_unsold`, so asset donated to the vault is never paid out here.
#[derive(Accounts)]
pub struct ClaimUnsold<'info> {
    /// Only the issuer. Like `abort_launch`, this moves the security to them.
    pub issuer: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, real_rwa_mint.key().as_ref()],
        bump = launch.bump,
        has_one = real_rwa_mint @ AegisError::ComplianceRegistryMismatch,
        has_one = crwa_mint @ AegisError::CrwaSupplyMismatch,
        has_one = issuer @ AegisError::NotLaunchIssuer,
        has_one = escrow_vault @ AegisError::VaultMintMismatch,
    )]
    pub launch: Box<Account<'info, Launch>>,

    pub real_rwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Read for its supply: the part of the vault that backs the wrapper and must not be paid out.
    pub crwa_mint: Box<InterfaceAccount<'info, Mint>>,

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

    /// The issuer's own holder record. To receive the security they must be registered, in the
    /// investor group the launch was configured with, like anyone else.
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

pub fn handler(ctx: Context<ClaimUnsold>) -> Result<()> {
    require!(
        ctx.accounts.launch.stage == LaunchStage::Graduated,
        AegisError::InvalidLaunchStage
    );
    let owed = ctx.accounts.launch.issuer_unsold;
    require!(owed > 0, AegisError::NothingToClaim);

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

    // ------------------------------------------------------------------
    // Only what the vault holds above the wrapper supply is the issuer's to take.
    //
    // Read from the chain, not the ledger: both sides can be moved by people Aegis does not
    // control. If the vault is already below the supply, holders are short and the issuer gets
    // nothing at all.
    // ------------------------------------------------------------------
    let surplus = ctx
        .accounts
        .escrow_vault
        .amount
        .checked_sub(ctx.accounts.crwa_mint.supply)
        .ok_or(AegisError::BackingShortfall)?;
    let amount = owed.min(surplus);
    require!(amount > 0, AegisError::UnsoldNotInVault);

    let launch_key = ctx.accounts.launch.key();
    let authority_bump = ctx.accounts.launch.authority_bump;
    let authority_seeds: &[&[u8]] = &[AEGIS_AUTHORITY_SEED, launch_key.as_ref(), &[authority_bump]];

    let hook_accounts = [
        ctx.accounts.transfer_restrictions_program.to_account_info(),
        ctx.accounts.real_rwa_extra_metas.to_account_info(),
        ctx.accounts.transfer_restriction_data.to_account_info(),
        ctx.accounts.vault_saa.to_account_info(),
        ctx.accounts.issuer_saa.to_account_info(),
        ctx.accounts.redeem_rule.to_account_info(),
    ];

    let vault_before = ctx.accounts.escrow_vault.amount;
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

    ctx.accounts.escrow_vault.reload()?;
    let released = vault_before
        .checked_sub(ctx.accounts.escrow_vault.amount)
        .ok_or(AegisError::MathOverflow)?;
    require_eq!(released, amount, AegisError::BackingShortfall);

    // ------------------------------------------------------------------
    // Settle the ledger and prove the wrapper is still fully backed.
    // ------------------------------------------------------------------
    let launch = &mut ctx.accounts.launch;
    launch.issuer_unsold = owed
        .checked_sub(amount)
        .ok_or(AegisError::MathOverflow)?;
    launch.real_rwa_locked = ctx.accounts.escrow_vault.amount;
    launch.crwa_minted = ctx.accounts.crwa_mint.supply;
    launch.assert_backing()?;

    emit!(UnsoldClaimed {
        launch: launch.key(),
        issuer: launch.issuer,
        amount,
        remaining: launch.issuer_unsold,
    });

    msg!(
        "Aegis: {} unsold returned to issuer, {} still owed",
        amount,
        launch.issuer_unsold
    );
    Ok(())
}
