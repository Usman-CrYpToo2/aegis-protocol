//! The bridge: converting between the asset and its wrapper, one for one, forever.
//!
//! After graduation cRWA trades on an open AMM at whatever price people pay, which can drift
//! away from what the underlying asset is worth. The bridge is what pulls it back, and it is the
//! reason the wrapper means anything at all.
//!
//! If cRWA trades below the asset, anyone can buy it cheap, redeem it for the real thing, and
//! keep the difference — and that buying lifts the price. If it trades above, a holder of the
//! asset can deposit, mint, and sell into the premium — and that selling caps it. So redemption
//! puts a floor under the price and deposit puts a ceiling on it.
//!
//! The compliance asymmetry is the whole design in one line: **cRWA moves freely, the asset never
//! leaves the compliance layer.**
//!
//! * Redeeming hands someone a regulated security, so Upside's rules decide whether it may
//!   happen. Aegis checks the holder's registration itself rather than relying on the hook — a
//!   wrapper is worthless protection if the gate is somebody else's job.
//! * Depositing needs no gate of ours. To hold the asset in the first place the depositor was
//!   already approved, so the check has already happened.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{burn, mint_to, Burn, Mint, MintTo, TokenAccount};

use crate::access_control::accounts::AccessControl;
use crate::compliance::{verify_compliance, ComplianceInputs};
use crate::constants::*;
use crate::errors::AegisError;
use crate::events::{BridgeDeposited, BridgeRedeemed};
use crate::state::{Launch, LaunchStage};
use crate::token_hook::transfer_checked_with_hook;
use crate::transfer_restrictions::accounts::{
    SecurityAssociatedAccount, TransferRestrictionData, TransferRule,
};

/// Wrap: hand over the asset, receive the wrapper.
///
/// The compliance check here is not about the depositor — they are already an approved holder or
/// they could not be holding the asset. It is about whether they will be able to get back out.
/// Depositing into a launch whose redemption path is shut would be trading a real security for a
/// token that can never be unwrapped, so the same gate runs as everywhere else.
#[derive(Accounts)]
pub struct BridgeDeposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, real_rwa_mint.key().as_ref()],
        bump = launch.bump,
        has_one = real_rwa_mint @ AegisError::ComplianceRegistryMismatch,
        has_one = crwa_mint @ AegisError::CrwaSupplyMismatch,
        has_one = escrow_vault @ AegisError::VaultMintMismatch,
    )]
    pub launch: Box<Account<'info, Launch>>,

    pub real_rwa_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub crwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: signer-only PDA. Owns the vault and holds cRWA mint authority.
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
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_real_rwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Created on demand: a first-time depositor has no wrapper account yet.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = crwa_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_crwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // ------------------------------------------------------------------
    // Upside compliance.
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
        seeds = [b"saa", user_real_rwa_account.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub user_saa: Box<Account<'info, SecurityAssociatedAccount>>,

    #[account(
        seeds = [b"saa", escrow_vault.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub vault_saa: Box<Account<'info, SecurityAssociatedAccount>>,

    /// investor -> vault. Governs the incoming transfer.
    #[account(
        seeds = [
            b"tr",
            transfer_restriction_data.key().as_ref(),
            launch.investor_group.to_le_bytes().as_ref(),
            launch.vault_group.to_le_bytes().as_ref(),
        ],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub deposit_rule: Box<Account<'info, TransferRule>>,

    /// vault -> investor. Not used by this transfer; checked so that nobody deposits into a
    /// launch they could never redeem from.
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
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_handler(ctx: Context<BridgeDeposit>, amount: u64) -> Result<()> {
    require!(amount > 0, AegisError::ZeroBridgeAmount);
    require!(
        ctx.accounts.launch.stage == LaunchStage::Graduated,
        AegisError::InvalidLaunchStage
    );
    require_eq!(
        ctx.accounts.user_saa.group,
        ctx.accounts.launch.investor_group,
        AegisError::HolderNotApproved
    );
    require_deposit_rule_open(&ctx.accounts.deposit_rule)?;

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
    // 1. Take the asset in.
    // ------------------------------------------------------------------
    let vault_before = ctx.accounts.escrow_vault.amount;

    let hook_accounts = [
        ctx.accounts.transfer_restrictions_program.to_account_info(),
        ctx.accounts.real_rwa_extra_metas.to_account_info(),
        ctx.accounts.transfer_restriction_data.to_account_info(),
        ctx.accounts.user_saa.to_account_info(),
        ctx.accounts.vault_saa.to_account_info(),
        ctx.accounts.deposit_rule.to_account_info(),
    ];

    transfer_checked_with_hook(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.user_real_rwa_account.to_account_info(),
        ctx.accounts.real_rwa_mint.to_account_info(),
        ctx.accounts.escrow_vault.to_account_info(),
        ctx.accounts.user.to_account_info(),
        &hook_accounts,
        amount,
        ctx.accounts.real_rwa_mint.decimals,
        &[],
    )?;

    // ------------------------------------------------------------------
    // 2. Mint exactly what arrived.
    //
    // Measured rather than assumed. If the asset ever carried a transfer fee the vault would
    // receive less than was sent, and minting the requested amount would create wrapper with no
    // backing behind it. Such mints are rejected at approval time, so this is a second line
    // rather than the first.
    // ------------------------------------------------------------------
    ctx.accounts.escrow_vault.reload()?;
    let received = ctx
        .accounts
        .escrow_vault
        .amount
        .checked_sub(vault_before)
        .ok_or(AegisError::MathOverflow)?;
    require!(received > 0, AegisError::NothingReceived);

    let launch_key = ctx.accounts.launch.key();
    let authority_bump = ctx.accounts.launch.authority_bump;
    let authority_seeds: &[&[u8]] = &[AEGIS_AUTHORITY_SEED, launch_key.as_ref(), &[authority_bump]];

    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.crwa_mint.to_account_info(),
                to: ctx.accounts.user_crwa_account.to_account_info(),
                authority: ctx.accounts.aegis_authority.to_account_info(),
            },
            &[authority_seeds],
        ),
        received,
    )?;

    settle(
        &mut ctx.accounts.launch,
        &mut ctx.accounts.crwa_mint,
        &mut ctx.accounts.escrow_vault,
    )?;

    emit!(BridgeDeposited {
        launch: ctx.accounts.launch.key(),
        user: ctx.accounts.user.key(),
        amount: received,
        real_rwa_locked: ctx.accounts.launch.real_rwa_locked,
        crwa_minted: ctx.accounts.launch.crwa_minted,
    });

    msg!(
        "Aegis: wrapped {} of {}",
        received,
        ctx.accounts.launch.real_rwa_mint
    );
    Ok(())
}

/// Unwrap: hand back the wrapper, receive the asset.
///
/// This is the compliance gate of the whole protocol. Everything before it moves a freely
/// tradable token around; this is the moment someone takes ownership of a regulated security,
/// and it is the moment KYC legally matters.
#[derive(Accounts)]
pub struct BridgeRedeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, real_rwa_mint.key().as_ref()],
        bump = launch.bump,
        has_one = real_rwa_mint @ AegisError::ComplianceRegistryMismatch,
        has_one = crwa_mint @ AegisError::CrwaSupplyMismatch,
        has_one = escrow_vault @ AegisError::VaultMintMismatch,
    )]
    pub launch: Box<Account<'info, Launch>>,

    pub real_rwa_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub crwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: signer-only PDA. Owns the vault.
    #[account(
        seeds = [AEGIS_AUTHORITY_SEED, launch.key().as_ref()],
        bump = launch.authority_bump,
    )]
    pub aegis_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Must already exist. Registering it with Upside requires the account first, so anyone
    /// entitled to redeem necessarily has one.
    #[account(
        mut,
        associated_token::mint = real_rwa_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_real_rwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = crwa_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_crwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // ------------------------------------------------------------------
    // Upside compliance.
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

    /// The redeemer's own registration. Its absence is what stops an unapproved wallet from
    /// taking delivery of a security.
    #[account(
        seeds = [b"saa", user_real_rwa_account.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub user_saa: Box<Account<'info, SecurityAssociatedAccount>>,

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
    pub system_program: Program<'info, System>,
}

pub fn redeem_handler(ctx: Context<BridgeRedeem>, amount: u64) -> Result<()> {
    require!(amount > 0, AegisError::ZeroBridgeAmount);
    require!(
        ctx.accounts.launch.stage == LaunchStage::Graduated,
        AegisError::InvalidLaunchStage
    );

    // Checked here rather than left to the hook. The hook would also refuse, but a protocol
    // whose central compliance promise depends on somebody else's program running correctly is
    // not making a promise.
    require_eq!(
        ctx.accounts.user_saa.group,
        ctx.accounts.launch.investor_group,
        AegisError::HolderNotApproved
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

    require!(
        ctx.accounts.escrow_vault.amount >= amount,
        AegisError::VaultUnderfunded
    );

    // ------------------------------------------------------------------
    // 1. Destroy the wrapper first.
    //
    // Order matters. Burning first means a failure to release the asset reverts the burn with
    // it. Releasing first would open a window in which the asset has left the vault while the
    // wrapper still exists — unbacked supply, if anything downstream could observe it.
    // ------------------------------------------------------------------
    burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.crwa_mint.to_account_info(),
                from: ctx.accounts.user_crwa_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // ------------------------------------------------------------------
    // 2. Release the asset.
    // ------------------------------------------------------------------
    let launch_key = ctx.accounts.launch.key();
    let authority_bump = ctx.accounts.launch.authority_bump;
    let authority_seeds: &[&[u8]] = &[AEGIS_AUTHORITY_SEED, launch_key.as_ref(), &[authority_bump]];

    let hook_accounts = [
        ctx.accounts.transfer_restrictions_program.to_account_info(),
        ctx.accounts.real_rwa_extra_metas.to_account_info(),
        ctx.accounts.transfer_restriction_data.to_account_info(),
        ctx.accounts.vault_saa.to_account_info(),
        ctx.accounts.user_saa.to_account_info(),
        ctx.accounts.redeem_rule.to_account_info(),
    ];

    let vault_before = ctx.accounts.escrow_vault.amount;

    transfer_checked_with_hook(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.escrow_vault.to_account_info(),
        ctx.accounts.real_rwa_mint.to_account_info(),
        ctx.accounts.user_real_rwa_account.to_account_info(),
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
    // The vault must have given up exactly what the wrapper was burned for, no more. This is a
    // local check on this transfer, not a statement about the ledger — the ledger is re-read
    // from the chain below precisely because other people can move both sides.
    require_eq!(released, amount, AegisError::BackingShortfall);

    settle(
        &mut ctx.accounts.launch,
        &mut ctx.accounts.crwa_mint,
        &mut ctx.accounts.escrow_vault,
    )?;

    emit!(BridgeRedeemed {
        launch: ctx.accounts.launch.key(),
        user: ctx.accounts.user.key(),
        amount,
        real_rwa_locked: ctx.accounts.launch.real_rwa_locked,
        crwa_minted: ctx.accounts.launch.crwa_minted,
    });

    msg!(
        "Aegis: unwrapped {} of {}",
        amount,
        ctx.accounts.launch.real_rwa_mint
    );
    Ok(())
}

// ----------------------------------------------------------------------
// Shared
// ----------------------------------------------------------------------

/// `locked_until` is a sentinel: 0 forbids, 1 allows immediately, larger values are a timestamp.
fn require_deposit_rule_open(rule: &TransferRule) -> Result<()> {
    require!(rule.locked_until != 0, AegisError::DepositPathClosed);
    let now = Clock::get()?.unix_timestamp as u64;
    require!(
        rule.locked_until <= 1 || rule.locked_until <= now,
        AegisError::DepositPathLocked
    );
    Ok(())
}

/// Re-reads the ledger from the chain and checks the backing still holds.
///
/// The ledger is a mirror for readers and indexers; the mint supply and the vault balance are
/// the truth, so they are read back rather than tracked by arithmetic. Deriving the ledger this
/// way also means an unsolicited change to either side — a donated token, a holder burning their
/// own wrapper — is simply absorbed instead of wedging the protocol.
fn settle<'info>(
    launch: &mut Account<'info, Launch>,
    crwa_mint: &mut InterfaceAccount<'info, Mint>,
    escrow_vault: &mut InterfaceAccount<'info, TokenAccount>,
) -> Result<()> {
    crwa_mint.reload()?;
    escrow_vault.reload()?;

    launch.crwa_minted = crwa_mint.supply;
    launch.real_rwa_locked = escrow_vault.amount;

    launch.assert_backing()
}
