//! Collecting the protocol's share of a launch.
//!
//! Meteora pays the "partner" side of a launch to whatever address the config records as
//! `fee_claimer`. For Aegis that is the per-launch `aegis_authority` PDA — it has to be, because
//! the same field is what grants cRWA mint authority, and the bridge runs on that.
//!
//! The consequence is that **only this program can collect it.** Every one of Meteora's partner
//! instructions requires `fee_claimer` to sign, and a PDA can only be signed for by the program
//! that owns it. Without the instructions in this file the revenue accrues where nobody can
//! reach it, silently — the issuer's side keeps working, because their claimant is an ordinary
//! wallet that calls Meteora directly.
//!
//! All three are **permissionless**. The destination is pinned to `platform_config.fee_recipient`,
//! so a stranger calling one simply pays the transaction fee to move the protocol's money to the
//! protocol. That makes them safe to crank and removes any dependence on one wallet staying live.
//!
//! Not covered here: fees earned by the 20% DAMM v2 liquidity position after graduation. That
//! position is owned by the same PDA and is claimed through DAMM v2 rather than Meteora's bonding
//! curve, which is a separate integration.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use dynamic_bonding_curve::cpi::accounts::{
    ClaimTradingFeesCtx, WithdrawMigrationFeeCtx,
};
use dynamic_bonding_curve::utils::remaining_accounts::TransferHookAccountsInfo;

use crate::constants::*;
use crate::errors::AegisError;
use crate::events::PartnerRevenueClaimed;
use crate::state::{Launch, PlatformConfig};

/// `SenderFlag::Partner` in Meteora's `withdraw_migration_fee`.
const SENDER_FLAG_PARTNER: u8 = 0;

/// Claim all quote-denominated trading fees the curve has accrued to the protocol.
///
/// The base side is deliberately never claimed. `create_rwa_config` pins `collect_fee_mode` to
/// quote-only, so base fees are structurally zero; asking for zero rather than passing an
/// unbounded maximum means a change in that assumption shows up as fees quietly not arriving
/// instead of as wrapper tokens appearing somewhere unaccounted.
#[derive(Accounts)]
pub struct ClaimPartnerTradingFee<'info> {
    /// Anyone. Pays the transaction and any rent for the destination account.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
    )]
    pub platform_config: Box<Account<'info, PlatformConfig>>,

    #[account(
        seeds = [LAUNCH_SEED, launch.real_rwa_mint.as_ref()],
        bump = launch.bump,
        constraint = launch.meteora_config == meteora_config.key() @ AegisError::WrongMeteoraConfig,
        constraint = launch.virtual_pool == virtual_pool.key() @ AegisError::WrongMeteoraConfig,
        constraint = launch.crwa_mint == base_mint.key() @ AegisError::CrwaSupplyMismatch,
        constraint = launch.quote_mint == quote_mint.key() @ AegisError::QuoteMintMismatch,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: signer-only PDA. Meteora's recorded `fee_claimer` for this launch.
    #[account(
        seeds = [AEGIS_AUTHORITY_SEED, launch.key().as_ref()],
        bump = launch.authority_bump,
    )]
    pub aegis_authority: UncheckedAccount<'info>,

    /// CHECK: pinned to the protocol treasury, so the caller cannot redirect the proceeds.
    #[account(address = platform_config.fee_recipient @ AegisError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = quote_mint,
        associated_token::authority = fee_recipient,
        associated_token::token_program = token_quote_program,
    )]
    pub fee_recipient_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Required by Meteora's account list even though nothing is claimed into it. Pointed at the
    /// protocol's own wrapper account rather than the treasury's, so that if a base fee ever did
    /// arrive it would land somewhere the protocol already accounts for.
    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = base_mint,
        associated_token::authority = aegis_authority,
        associated_token::token_program = token_base_program,
    )]
    pub aegis_crwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Meteora validates this against the pool it is claiming from.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: Meteora validates this against the pool it is claiming from.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    /// CHECK: pinned to the launch record; Meteora validates its contents.
    pub meteora_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the launch record; Meteora validates its contents.
    #[account(mut)]
    pub virtual_pool: UncheckedAccount<'info>,

    /// CHECK: Meteora's global pool authority, a constant in their program.
    #[account(address = dynamic_bonding_curve::const_pda::pool_authority::ID)]
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Meteora's event-authority PDA, derived from the pinned program below.
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = METEORA_DBC_PROGRAM_ID,
    )]
    pub meteora_event_authority: UncheckedAccount<'info>,

    /// CHECK: pinned to the official program.
    #[account(address = METEORA_DBC_PROGRAM_ID @ AegisError::InvalidDbcProgram)]
    pub meteora_dbc_program: UncheckedAccount<'info>,

    pub token_base_program: Program<'info, Token2022>,
    pub token_quote_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_trading_fee_handler(ctx: Context<ClaimPartnerTradingFee>) -> Result<()> {
    let before = ctx.accounts.fee_recipient_quote_account.amount;
    let base_before = ctx.accounts.aegis_crwa_account.amount;

    let launch_key = ctx.accounts.launch.key();
    let bump = ctx.accounts.launch.authority_bump;
    let seeds: &[&[u8]] = &[AEGIS_AUTHORITY_SEED, launch_key.as_ref(), &[bump]];

    dynamic_bonding_curve::cpi::claim_trading_fee2(
        CpiContext::new_with_signer(
            ctx.accounts.meteora_dbc_program.key(),
            ClaimTradingFeesCtx {
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                config: ctx.accounts.meteora_config.to_account_info(),
                pool: ctx.accounts.virtual_pool.to_account_info(),
                token_a_account: ctx.accounts.aegis_crwa_account.to_account_info(),
                token_b_account: ctx.accounts.fee_recipient_quote_account.to_account_info(),
                base_vault: ctx.accounts.base_vault.to_account_info(),
                quote_vault: ctx.accounts.quote_vault.to_account_info(),
                base_mint: ctx.accounts.base_mint.to_account_info(),
                quote_mint: ctx.accounts.quote_mint.to_account_info(),
                fee_claimer: ctx.accounts.aegis_authority.to_account_info(),
                token_base_program: ctx.accounts.token_base_program.to_account_info(),
                token_quote_program: ctx.accounts.token_quote_program.to_account_info(),
                event_authority: ctx.accounts.meteora_event_authority.to_account_info(),
                program: ctx.accounts.meteora_dbc_program.to_account_info(),
            },
            &[seeds],
        ),
        // Base: none, ever. Quote: everything.
        0,
        u64::MAX,
        // No hook accounts are needed because no base transfer is requested. The wrapper carries
        // a hook only until the curve completes, and this asks for nothing on that side.
        TransferHookAccountsInfo::default(),
    )?;

    ctx.accounts.fee_recipient_quote_account.reload()?;
    ctx.accounts.aegis_crwa_account.reload()?;

    // Proves the quote-only fee mode still holds. If Meteora ever paid a base fee despite being
    // asked for zero, this fails rather than leaving unaccounted wrapper in a protocol account.
    require_eq!(
        ctx.accounts.aegis_crwa_account.amount,
        base_before,
        AegisError::UnexpectedBaseFee
    );

    let claimed = ctx
        .accounts
        .fee_recipient_quote_account
        .amount
        .checked_sub(before)
        .ok_or(AegisError::MathOverflow)?;

    emit!(PartnerRevenueClaimed {
        launch: launch_key,
        kind: RevenueKind::TradingFee as u8,
        quote_mint: ctx.accounts.quote_mint.key(),
        amount: claimed,
        recipient: ctx.accounts.fee_recipient.key(),
    });
    msg!("Aegis: claimed {} in curve trading fees", claimed);
    Ok(())
}

/// Which stream a claim came from. Recorded on the event so a treasury can be reconciled.
#[repr(u8)]
pub enum RevenueKind {
    TradingFee = 0,
    MigrationFee = 1,
    // 2 was surplus. Aegis cannot accrue any: the curve is generated so that its total quote
    // capacity is exactly the migration threshold, which leaves nothing above the target for
    // Meteora to book as surplus. See `curve::plan_curve`.
}

/// Shared shape for the two quote-only claims. Meteora's `withdraw_migration_fee` and
/// `partner_withdraw_surplus` take identical accounts.
#[derive(Accounts)]
pub struct ClaimPartnerQuote<'info> {
    /// Anyone.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
    )]
    pub platform_config: Box<Account<'info, PlatformConfig>>,

    #[account(
        seeds = [LAUNCH_SEED, launch.real_rwa_mint.as_ref()],
        bump = launch.bump,
        constraint = launch.meteora_config == meteora_config.key() @ AegisError::WrongMeteoraConfig,
        constraint = launch.virtual_pool == virtual_pool.key() @ AegisError::WrongMeteoraConfig,
        constraint = launch.quote_mint == quote_mint.key() @ AegisError::QuoteMintMismatch,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: signer-only PDA. Meteora's recorded `fee_claimer` for this launch.
    #[account(
        seeds = [AEGIS_AUTHORITY_SEED, launch.key().as_ref()],
        bump = launch.authority_bump,
    )]
    pub aegis_authority: UncheckedAccount<'info>,

    /// CHECK: pinned to the protocol treasury.
    #[account(address = platform_config.fee_recipient @ AegisError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = quote_mint,
        associated_token::authority = fee_recipient,
        associated_token::token_program = token_quote_program,
    )]
    pub fee_recipient_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Meteora validates this against the pool.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    /// CHECK: pinned to the launch record.
    pub meteora_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the launch record.
    #[account(mut)]
    pub virtual_pool: UncheckedAccount<'info>,

    /// CHECK: Meteora's global pool authority.
    #[account(address = dynamic_bonding_curve::const_pda::pool_authority::ID)]
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Meteora's event-authority PDA.
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = METEORA_DBC_PROGRAM_ID,
    )]
    pub meteora_event_authority: UncheckedAccount<'info>,

    /// CHECK: pinned to the official program.
    #[account(address = METEORA_DBC_PROGRAM_ID @ AegisError::InvalidDbcProgram)]
    pub meteora_dbc_program: UncheckedAccount<'info>,

    pub token_quote_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// The protocol's share of the migration fee — the cut taken off the raise at graduation.
pub fn claim_migration_fee_handler(ctx: Context<ClaimPartnerQuote>) -> Result<()> {
    let before = ctx.accounts.fee_recipient_quote_account.amount;
    let launch_key = ctx.accounts.launch.key();
    let bump = ctx.accounts.launch.authority_bump;
    let seeds: &[&[u8]] = &[AEGIS_AUTHORITY_SEED, launch_key.as_ref(), &[bump]];

    dynamic_bonding_curve::cpi::withdraw_migration_fee(
        CpiContext::new_with_signer(
            ctx.accounts.meteora_dbc_program.key(),
            WithdrawMigrationFeeCtx {
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                config: ctx.accounts.meteora_config.to_account_info(),
                virtual_pool: ctx.accounts.virtual_pool.to_account_info(),
                token_quote_account: ctx
                    .accounts
                    .fee_recipient_quote_account
                    .to_account_info(),
                quote_vault: ctx.accounts.quote_vault.to_account_info(),
                quote_mint: ctx.accounts.quote_mint.to_account_info(),
                sender: ctx.accounts.aegis_authority.to_account_info(),
                token_quote_program: ctx.accounts.token_quote_program.to_account_info(),
                event_authority: ctx.accounts.meteora_event_authority.to_account_info(),
                program: ctx.accounts.meteora_dbc_program.to_account_info(),
            },
            &[seeds],
        ),
        SENDER_FLAG_PARTNER,
    )?;

    finish(&mut ctx.accounts.fee_recipient_quote_account, before, launch_key,
        RevenueKind::MigrationFee, ctx.accounts.quote_mint.key(), ctx.accounts.fee_recipient.key(),
        "migration fee")
}

/// Measures what actually arrived rather than trusting the call, and records it.
fn finish<'info>(
    destination: &mut InterfaceAccount<'info, TokenAccount>,
    before: u64,
    launch: Pubkey,
    kind: RevenueKind,
    quote_mint: Pubkey,
    recipient: Pubkey,
    label: &str,
) -> Result<()> {
    destination.reload()?;
    let claimed = destination
        .amount
        .checked_sub(before)
        .ok_or(AegisError::MathOverflow)?;

    emit!(PartnerRevenueClaimed {
        launch,
        kind: kind as u8,
        quote_mint,
        amount: claimed,
        recipient,
    });
    msg!("Aegis: claimed {} in {}", claimed, label);
    Ok(())
}
