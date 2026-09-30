use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{burn, Burn, Mint, TokenAccount};

use dynamic_bonding_curve::cpi::accounts::WithdrawLeftoverCtx;
use dynamic_bonding_curve::state::TransferHookPool;

use crate::constants::*;
use crate::errors::AegisError;
use crate::events::Graduated;
use crate::state::{Launch, LaunchStage};

/// Launch step 5: settle the unsold allocation and open the bridge.
///
/// A bonding curve rarely sells out. Whatever is left over was minted at launch and is therefore
/// backed by real asset locked in the vault — asset that belongs to the issuer, because the
/// wrapper tokens representing it were never bought.
///
/// Leaving the wrapper alone would make the backing figure meaningless: total supply would say
/// one million while only nine hundred thousand are in anyone's hands. So the leftover wrapper is
/// destroyed, and the matching asset is recorded as owed to the issuer (`issuer_unsold`).
///
/// **The asset stays in the vault.** An earlier version sent it to the issuer here, which meant
/// this instruction needed the issuer to be a registered holder. It is also the only instruction
/// that opens the bridge — so an issuer who de-registered themselves, never registered, or lost
/// their wallet could keep the bridge shut forever and no cRWA holder could ever redeem. Paying
/// the issuer and opening the bridge are two different jobs, and the second must not depend on
/// anything the issuer controls. The issuer collects with `claim_unsold` whenever they are
/// registered.
///
/// No Real RWA moves here, so none of Upside's compliance state is involved: a paused registry,
/// a frozen vault or a closed rule cannot hold graduation back. Those still govern every transfer
/// out of the vault, which is where they belong.
///
/// Deliberately permissionless. It only squares the books — it moves nothing to the caller and
/// changes nobody's entitlement — and gating it would mean a launch could sit unsettled because
/// one particular wallet went quiet.
///
/// Must run after Meteora's migration, which Meteora enforces: the leftover is only released
/// once the graduated pool exists. Migration is a separate transaction because the two together
/// exceed the account limit.
#[derive(Accounts)]
pub struct FinalizeGraduation<'info> {
    /// Anyone. Pays rent for the collection account and nothing else.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, real_rwa_mint.key().as_ref()],
        bump = launch.bump,
        has_one = real_rwa_mint @ AegisError::ComplianceRegistryMismatch,
        has_one = crwa_mint @ AegisError::CrwaSupplyMismatch,
        has_one = escrow_vault @ AegisError::VaultMintMismatch,
        constraint = launch.meteora_config == meteora_config.key() @ AegisError::WrongMeteoraConfig,
        constraint = launch.virtual_pool == virtual_pool.key() @ AegisError::WrongMeteoraConfig,
    )]
    pub launch: Box<Account<'info, Launch>>,

    pub real_rwa_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub crwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: signer-only PDA. Owns the escrow vault, and is the leftover receiver Meteora was
    /// given at config time.
    #[account(
        seeds = [AEGIS_AUTHORITY_SEED, launch.key().as_ref()],
        bump = launch.authority_bump,
    )]
    pub aegis_authority: UncheckedAccount<'info>,

    /// Where Meteora deposits the unsold wrapper. It must be an associated token account of the
    /// leftover receiver, and Meteora does not create it, so it is created here if missing.
    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = crwa_mint,
        associated_token::authority = aegis_authority,
        associated_token::token_program = token_program,
    )]
    pub aegis_crwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Read only: its balance is the escrow side of the ledger. Nothing is moved out of it here.
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    // ------------------------------------------------------------------
    // Meteora, for collecting the leftover.
    // ------------------------------------------------------------------
    /// CHECK: Meteora's global pool authority, a constant in their program.
    #[account(address = dynamic_bonding_curve::const_pda::pool_authority::ID)]
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: pinned to the launch record; Meteora validates its contents.
    pub meteora_config: UncheckedAccount<'info>,

    /// Meteora refuses to release the leftover unless this shows the graduated pool already
    /// exists, which is what orders settlement after migration.
    ///
    /// Loaded as a typed account rather than left unchecked, because its `is_withdraw_leftover`
    /// flag has to be read before deciding whether to call Meteora at all — see the handler.
    /// The type also proves the pool is the transfer-hook variant this launch created.
    #[account(mut)]
    pub virtual_pool: AccountLoader<'info, TransferHookPool>,

    /// CHECK: Meteora's wrapper vault, validated by their program against the pool.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,

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

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<FinalizeGraduation>) -> Result<()> {
    require!(
        ctx.accounts.launch.stage == LaunchStage::Live,
        AegisError::InvalidLaunchStage
    );

    let launch_key = ctx.accounts.launch.key();
    let authority_bump = ctx.accounts.launch.authority_bump;
    let authority_seeds: &[&[u8]] = &[AEGIS_AUTHORITY_SEED, launch_key.as_ref(), &[authority_bump]];

    // ------------------------------------------------------------------
    // 1. Collect the unsold wrapper from Meteora — unless someone already did.
    //
    // Meteora's `withdraw_leftover` takes no signer: anybody may call it. It is harmless in
    // itself, because Meteora forces the destination to be the leftover receiver's associated
    // account, which is this launch's PDA. The tokens can only ever land with us.
    //
    // What it does do is set a one-way `is_withdraw_leftover` flag, and a second call reverts.
    // If settlement blindly called it, anyone could permanently brick a launch for the price of
    // a transaction: graduation would revert forever and the bridge would never open. So the
    // flag is read first and the call skipped if the work is already done.
    // ------------------------------------------------------------------
    let already_collected = {
        let pool = ctx.accounts.virtual_pool.load()?;
        pool.is_withdraw_leftover != 0
    };

    if !already_collected {
        dynamic_bonding_curve::cpi::withdraw_leftover(CpiContext::new(
            ctx.accounts.meteora_dbc_program.key(),
            WithdrawLeftoverCtx {
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                config: ctx.accounts.meteora_config.to_account_info(),
                virtual_pool: ctx.accounts.virtual_pool.to_account_info(),
                token_base_account: ctx.accounts.aegis_crwa_account.to_account_info(),
                base_vault: ctx.accounts.base_vault.to_account_info(),
                base_mint: ctx.accounts.crwa_mint.to_account_info(),
                leftover_receiver: ctx.accounts.aegis_authority.to_account_info(),
                token_base_program: ctx.accounts.token_program.to_account_info(),
                event_authority: ctx.accounts.meteora_event_authority.to_account_info(),
                program: ctx.accounts.meteora_dbc_program.to_account_info(),
            },
        ))?;
    }

    // The whole balance is settled, not a delta across the call above, so the amount is right
    // whether Meteora was called here or by someone else earlier.
    //
    // Anything else sitting in this account is settled too. That is deliberate: a stray deposit
    // of wrapper here is backed by asset already in the vault, so burning it and crediting the
    // same amount to the issuer keeps the peg exact — the depositor has simply made a gift to the
    // issuer.
    ctx.accounts.aegis_crwa_account.reload()?;
    let leftover = ctx.accounts.aegis_crwa_account.amount;

    // ------------------------------------------------------------------
    // 2. Destroy the unsold wrapper.
    // ------------------------------------------------------------------
    if leftover > 0 {
        burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.crwa_mint.to_account_info(),
                    from: ctx.accounts.aegis_crwa_account.to_account_info(),
                    authority: ctx.accounts.aegis_authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            leftover,
        )?;
    }

    // ------------------------------------------------------------------
    // 3. Record the asset behind it as the issuer's, square the ledger, and open the bridge.
    // ------------------------------------------------------------------
    // Read the ledger back from the chain rather than adjusting it by the amount settled. Both
    // sides can be moved by people Aegis does not control, and absorbing that is what keeps an
    // unsolicited token from halting the launch permanently.
    ctx.accounts.crwa_mint.reload()?;

    let launch = &mut ctx.accounts.launch;
    launch.issuer_unsold = launch
        .issuer_unsold
        .checked_add(leftover)
        .ok_or(AegisError::MathOverflow)?;
    launch.crwa_minted = ctx.accounts.crwa_mint.supply;
    launch.real_rwa_locked = ctx.accounts.escrow_vault.amount;
    launch.assert_backing()?;

    launch.stage = LaunchStage::Graduated;

    emit!(Graduated {
        launch: launch.key(),
        unsold_burned: leftover,
        issuer_unsold: launch.issuer_unsold,
        real_rwa_locked: launch.real_rwa_locked,
        crwa_minted: launch.crwa_minted,
    });

    msg!("Aegis: graduated. {} unsold wrapper burned", leftover);
    msg!(
        "Escrowed {}: {} backs the wrapper, {} owed to the issuer",
        launch.real_rwa_locked,
        launch.crwa_minted,
        launch.issuer_unsold
    );

    Ok(())
}
