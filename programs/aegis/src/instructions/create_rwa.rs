use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::access_control::{
    cpi::accounts::{GrantRole, InitializeAccessControl},
    program::AccessControl as AccessControlProgram,
    types::InitializeAccessControlArgs,
};
use crate::constants::*;
use crate::errors::AegisError;
use crate::events::RwaCreated;
use crate::state::{Launch, LaunchStage, PlatformConfig, RwaCurveArchetype};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateRwaArgs {
    /// Shared by the Real RWA and the cRWA. Meteora rejects anything outside 6..=9, and the
    /// two mints must match exactly or the 1:1 backing is off by a power of ten.
    pub decimals: u8,
    /// The exact supply that will be issued. Becomes Upside's `max_total_supply`, so the
    /// issuer has no headroom to mint into without a visible on-chain cap change.
    pub total_supply: u64,
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

/// Step 1 of a launch: create the Real RWA.
///
/// The Real RWA is the legal security. Aegis does not mint it, does not hold authority over
/// it, and cannot freeze or seize it. Aegis only *builds* it, so that the token is guaranteed
/// to be shaped correctly: Token-2022, the right decimals, Upside's transfer hook attached,
/// and a supply cap equal to the intended issuance.
///
/// Upside grants ContractAdmin to whoever pays. The issuer pays, so the issuer becomes
/// ContractAdmin with no action from us, and then grants itself the remaining three roles in
/// the same transaction. The issuer ends up with complete legal control, which is a regulatory
/// requirement for a real security, not a concession.
///
/// The cRWA does **not** exist after this instruction. Meteora creates it inside its own pool
/// initialization, so it cannot exist before `launch_pool`.
#[derive(Accounts)]
pub struct CreateRwa<'info> {
    /// The asset issuer. Pays for everything and receives all four Upside roles.
    #[account(mut)]
    pub issuer: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    /// CHECK: constrained to the address recorded in `platform_config`.
    #[account(
        mut,
        address = platform_config.fee_recipient @ AegisError::InvalidFeeRecipient,
    )]
    pub fee_recipient: UncheckedAccount<'info>,

    /// A fresh keypair. Upside initializes the mint inside its own instruction, so this
    /// arrives uninitialized and must sign.
    #[account(mut)]
    pub real_rwa_mint: Signer<'info>,

    #[account(
        init,
        payer = issuer,
        space = 8 + Launch::INIT_SPACE,
        seeds = [LAUNCH_SEED, real_rwa_mint.key().as_ref()],
        bump,
    )]
    pub launch: Account<'info, Launch>,

    /// CHECK: created by the Upside CPI below. Address pinned to Upside's PDA so a
    /// substituted account cannot be passed.
    #[account(
        mut,
        seeds = [b"ac", real_rwa_mint.key().as_ref()],
        bump,
        seeds::program = crate::access_control::ID,
    )]
    pub access_control: UncheckedAccount<'info>,

    /// CHECK: created by the Upside CPI below. Holds the issuer's role bitmask.
    #[account(
        mut,
        seeds = [b"wallet_role", real_rwa_mint.key().as_ref(), issuer.key().as_ref()],
        bump,
        seeds::program = crate::access_control::ID,
    )]
    pub issuer_wallet_role: UncheckedAccount<'info>,

    pub access_control_program: Program<'info, AccessControlProgram>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateRwa>, args: CreateRwaArgs) -> Result<()> {
    let platform = &ctx.accounts.platform_config;

    require!(!platform.is_paused, AegisError::ProtocolPaused);
    require!(
        args.decimals >= MIN_RWA_DECIMALS && args.decimals <= MAX_RWA_DECIMALS,
        AegisError::InvalidRwaDecimals
    );
    require!(args.total_supply > 0, AegisError::InvalidTotalSupply);
    require!(
        args.name.len() <= MAX_TOKEN_NAME_LEN,
        AegisError::TokenNameTooLong
    );
    require!(
        args.symbol.len() <= MAX_TOKEN_SYMBOL_LEN,
        AegisError::TokenSymbolTooLong
    );
    require!(
        args.uri.len() <= MAX_TOKEN_URI_LEN,
        AegisError::TokenUriTooLong
    );

    // ----------------------------------------------------------------------
    // 1. Protocol fee.
    // ----------------------------------------------------------------------
    let creation_fee = platform.creation_fee_lamports;
    if creation_fee > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.issuer.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
            ),
            creation_fee,
        )?;
    }

    // ----------------------------------------------------------------------
    // 2. Create the Real RWA through Upside.
    //
    // Upside builds the Token-2022 mint with the transfer hook, permanent delegate, group
    // pointers and metadata already attached, and sets every mint-level authority to its own
    // Access Control PDA. That is why the role bitmask *is* the authority model: no wallet
    // ever holds raw token power directly.
    //
    // `hook_program_id` is the one lever we control here, and we pin it to Upside's Transfer
    // Restrictions program. That is what makes KYC enforceable on unwrap later.
    // ----------------------------------------------------------------------
    crate::access_control::cpi::initialize_access_control(
        CpiContext::new(
            ctx.accounts.access_control_program.key(),
            InitializeAccessControl {
                payer: ctx.accounts.issuer.to_account_info(),
                // Metadata update authority. The issuer's asset, the issuer's metadata.
                authority: ctx.accounts.issuer.to_account_info(),
                mint: ctx.accounts.real_rwa_mint.to_account_info(),
                access_control: ctx.accounts.access_control.to_account_info(),
                wallet_role: ctx.accounts.issuer_wallet_role.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ),
        InitializeAccessControlArgs {
            decimals: args.decimals,
            name: args.name,
            symbol: args.symbol,
            uri: args.uri,
            hook_program_id: crate::transfer_restrictions::ID,
            max_total_supply: args.total_supply,
        },
    )?;

    // ----------------------------------------------------------------------
    // 3. Give the issuer the other three roles.
    //
    // The step above made the issuer ContractAdmin, which is the only role that can grant
    // roles. So the issuer grants to itself: `wallet_role` and `authority_wallet_role` are
    // deliberately the same account.
    //
    // Doing it here rather than leaving it to the frontend means a launch can never end up
    // half-configured — for instance with no ReserveAdmin, which would make the token
    // impossible to mint and the launch impossible to fund.
    // ----------------------------------------------------------------------
    crate::access_control::cpi::grant_role(
        CpiContext::new(
            ctx.accounts.access_control_program.key(),
            GrantRole {
                wallet_role: ctx.accounts.issuer_wallet_role.to_account_info(),
                authority_wallet_role: ctx.accounts.issuer_wallet_role.to_account_info(),
                access_control: ctx.accounts.access_control.to_account_info(),
                security_token: ctx.accounts.real_rwa_mint.to_account_info(),
                user_wallet: ctx.accounts.issuer.to_account_info(),
                authority: ctx.accounts.issuer.to_account_info(),
                payer: ctx.accounts.issuer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        ),
        ISSUER_DELEGATED_ROLES,
    )?;

    // ----------------------------------------------------------------------
    // 4. Record the launch.
    // ----------------------------------------------------------------------
    let launch = &mut ctx.accounts.launch;
    launch.issuer = ctx.accounts.issuer.key();
    launch.real_rwa_mint = ctx.accounts.real_rwa_mint.key();
    launch.crwa_mint = Pubkey::default();
    launch.meteora_config = Pubkey::default();
    launch.virtual_pool = Pubkey::default();
    launch.quote_mint = Pubkey::default();
    launch.escrow_vault = Pubkey::default();
    launch.total_supply = args.total_supply;
    launch.real_rwa_locked = 0;
    launch.crwa_minted = 0;
    launch.decimals = args.decimals;
    launch.stage = LaunchStage::TokenCreated;
    // Placeholder. The real archetype is chosen and validated in `create_rwa_config`.
    launch.archetype = RwaCurveArchetype::FixedPar;
    launch.bump = ctx.bumps.launch;
    // Derived and stored in `setup_rwa_compliance`, where the authority first has to sign.
    launch.authority_bump = 0;

    emit!(RwaCreated {
        launch: launch.key(),
        real_rwa_mint: launch.real_rwa_mint,
        issuer: launch.issuer,
        total_supply: launch.total_supply,
        decimals: launch.decimals,
    });

    msg!("Aegis: Real RWA created {}", launch.real_rwa_mint);
    msg!("Issuer (all four Upside roles): {}", launch.issuer);
    msg!(
        "Supply cap {} at {} decimals",
        launch.total_supply,
        launch.decimals
    );

    Ok(())
}
