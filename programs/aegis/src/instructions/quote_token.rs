use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    native_mint,
    state::Mint as SplMint,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint;

use crate::constants::*;
use crate::errors::AegisError;
use crate::events::{QuoteTokenApproved, QuoteTokenStatusChanged};
use crate::state::{PlatformConfig, QuoteToken};

/// Approve a quote token for use in launches. Protocol admin only.
///
/// Two reasons this is gated rather than permissionless. The obvious one is that the quote
/// token is what buyers pay with, so a launch denominated in a worthless or malicious token is
/// a trap regardless of how sound the curve is.
///
/// The less obvious one is that Meteora will not accept every quote mint. A mint it rejects
/// would let an issuer complete `create_rwa_config` and then fail at pool creation, after
/// they have already locked their asset. Checking Meteora's rules here moves that failure to
/// the earliest possible point, and makes it the admin's problem rather than the issuer's.
#[derive(Accounts)]
pub struct WhitelistQuoteToken<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
        has_one = admin @ AegisError::Unauthorized,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    pub quote_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + QuoteToken::INIT_SPACE,
        seeds = [QUOTE_TOKEN_SEED, quote_mint.key().as_ref()],
        bump,
    )]
    pub quote_token: Account<'info, QuoteToken>,

    pub system_program: Program<'info, System>,
}

pub fn whitelist_handler(ctx: Context<WhitelistQuoteToken>, min_raise: u64) -> Result<()> {
    let mint_info = ctx.accounts.quote_mint.to_account_info();
    let is_legacy_spl = validate_meteora_accepts_quote_mint(&mint_info)?;

    let quote_token = &mut ctx.accounts.quote_token;
    quote_token.mint = ctx.accounts.quote_mint.key();
    quote_token.decimals = ctx.accounts.quote_mint.decimals;
    quote_token.is_active = true;
    quote_token.is_legacy_spl = is_legacy_spl;
    quote_token.min_raise = min_raise;
    quote_token.approved_at = Clock::get()?.unix_timestamp;
    quote_token.bump = ctx.bumps.quote_token;

    emit!(QuoteTokenApproved {
        mint: quote_token.mint,
        decimals: quote_token.decimals,
        is_legacy_spl: quote_token.is_legacy_spl,
    });

    msg!(
        "Aegis: quote token approved {} ({} decimals, legacy_spl={})",
        quote_token.mint,
        quote_token.decimals,
        quote_token.is_legacy_spl
    );

    Ok(())
}

/// Change an approved quote token's status or its minimum raise. Protocol admin only.
///
/// Deactivating blocks new launches without touching existing ones. There is deliberately no
/// instruction to close the account: launches already configured against this quote token
/// continue to reference it, and re-approving a closed address could silently change its
/// recorded decimals. Both fields are optional so either can be changed alone; the minimum
/// raise in particular moves with the token's price and should not require a flag flip.
#[derive(Accounts)]
pub struct UpdateQuoteToken<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
        has_one = admin @ AegisError::Unauthorized,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    #[account(
        mut,
        seeds = [QUOTE_TOKEN_SEED, quote_token.mint.as_ref()],
        bump = quote_token.bump,
    )]
    pub quote_token: Account<'info, QuoteToken>,
}

pub fn update_handler(
    ctx: Context<UpdateQuoteToken>,
    is_active: Option<bool>,
    min_raise: Option<u64>,
) -> Result<()> {
    let quote_token = &mut ctx.accounts.quote_token;

    if let Some(is_active) = is_active {
        require_neq!(
            quote_token.is_active,
            is_active,
            AegisError::QuoteTokenStatusUnchanged
        );
        quote_token.is_active = is_active;

        emit!(QuoteTokenStatusChanged {
            mint: quote_token.mint,
            is_active,
        });

        msg!(
            "Aegis: quote token {} is now {}",
            quote_token.mint,
            if is_active { "active" } else { "inactive" }
        );
    }

    if let Some(min_raise) = min_raise {
        quote_token.min_raise = min_raise;
        msg!(
            "Aegis: quote token {} minimum raise is now {}",
            quote_token.mint,
            min_raise
        );
    }

    Ok(())
}

/// Mirrors Meteora DBC's `is_supported_quote_mint`. Returns true when the mint is legacy SPL.
///
/// Meteora accepts a quote mint without further ceremony only if it is a legacy SPL token, or a
/// Token-2022 mint carrying nothing but metadata extensions. Anything else needs a `TokenBadge`
/// that only Meteora's own operators can issue, so Aegis treats it as unsupported rather than
/// approving a token that would strand a launch at pool creation.
///
/// The extension allowlist also covers transfer fees implicitly: a fee-bearing quote mint
/// carries the `TransferFeeConfig` extension, which is not on the list. That matters because a
/// transfer fee would make the amount Meteora receives differ from the amount a buyer sent.
fn validate_meteora_accepts_quote_mint(mint_info: &AccountInfo) -> Result<bool> {
    if mint_info.owner == &Token::id() {
        return Ok(true);
    }

    require_keys_eq!(
        *mint_info.owner,
        Token2022::id(),
        AegisError::UnsupportedQuoteMint
    );

    // Meteora rejects native (wrapped SOL) Token-2022 outright.
    require!(
        !native_mint::check_id(&mint_info.key()),
        AegisError::UnsupportedQuoteMint
    );

    let data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<SplMint>::unpack(&data)
        .map_err(|_| error!(AegisError::UnsupportedQuoteMint))?;

    for extension in mint
        .get_extension_types()
        .map_err(|_| error!(AegisError::UnsupportedQuoteMint))?
    {
        require!(
            extension == ExtensionType::MetadataPointer
                || extension == ExtensionType::TokenMetadata,
            AegisError::UnsupportedQuoteMint
        );
    }

    Ok(false)
}

/// Shared gate for any instruction that commits a launch to a quote token.
pub fn require_active_quote_token(quote_token: &QuoteToken, quote_mint: &Pubkey) -> Result<()> {
    require_keys_eq!(
        quote_token.mint,
        *quote_mint,
        AegisError::QuoteTokenNotWhitelisted
    );
    require!(quote_token.is_active, AegisError::QuoteTokenInactive);
    Ok(())
}
