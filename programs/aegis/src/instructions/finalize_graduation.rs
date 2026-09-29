use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{burn, Burn, Mint, TokenAccount};

use dynamic_bonding_curve::cpi::accounts::WithdrawLeftoverCtx;
use dynamic_bonding_curve::state::TransferHookPool;

use crate::access_control::accounts::AccessControl;
use crate::compliance::{verify_compliance, ComplianceInputs};
use crate::constants::*;
use crate::errors::AegisError;
use crate::events::Graduated;
use crate::state::{Launch, LaunchStage};
use crate::transfer_restrictions::accounts::{
    SecurityAssociatedAccount, TransferRestrictionData, TransferRule,
};

/// Launch step 5: settle the unsold allocation.
///
/// A bonding curve rarely sells out. Whatever is left over was minted at launch and is therefore
/// backed by real asset locked in the vault — asset that now belongs to nobody, because the
/// wrapper tokens representing it were never bought.
///
/// Leaving it alone would make the backing figure meaningless: total supply would say one
/// million while only nine hundred thousand are in anyone's hands. So the leftover wrapper is
/// destroyed and the matching asset is returned to the issuer. It is their unsold stock, and it
/// goes home.
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
        has_one = issuer @ AegisError::NotLaunchIssuer,
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

    #[account(mut)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: identity only, pinned by `has_one` above. Not a signer — this is permissionless.
    pub issuer: UncheckedAccount<'info>,

    /// Where the unsold asset is returned. Must already exist, because registering it with
    /// Upside requires the account to exist first.
    #[account(
        mut,
        associated_token::mint = real_rwa_mint,
        associated_token::authority = issuer,
        associated_token::token_program = token_program,
    )]
    pub issuer_real_rwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // ------------------------------------------------------------------
    // Upside compliance. The asset moving back to the issuer is still a regulated security, so
    // it passes the same checks as any other transfer out of the vault.
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

    /// The issuer's own holder record. They are a holder like anyone else here: to receive the
    /// security back they must be registered, in the investor group the launch was configured
    /// with.
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

    /// CHECK: Upside's hook validation account for the Real RWA. Token-2022 resolves the hook's
    /// accounts through it, so the transfer below cannot happen without it.
    #[account(
        seeds = [b"extra-account-metas", real_rwa_mint.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub real_rwa_extra_metas: UncheckedAccount<'info>,

    /// CHECK: pinned to Upside's Transfer Restrictions program, which is the Real RWA's hook.
    #[account(
        executable,
        address = crate::transfer_restrictions::ID @ AegisError::UnauthorizedTransferHook,
    )]
    pub transfer_restrictions_program: UncheckedAccount<'info>,

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

    // The issuer is receiving a security, so they are subject to the same rules as any investor.
    // Checked explicitly rather than left to the hook, so the failure names the real problem.
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
    // of wrapper here is backed by asset already in the vault, so burning it and releasing the
    // same amount keeps the peg exact — the depositor has simply made a gift to the issuer.
    ctx.accounts.aegis_crwa_account.reload()?;
    let leftover = ctx.accounts.aegis_crwa_account.amount;

    if leftover > 0 {
        // --------------------------------------------------------------
        // 2. Destroy the unsold wrapper.
        //
        // Burned before the asset is released. If the release then fails the whole transaction
        // reverts, so there is no ordering in which wrapper and backing are both gone.
        // --------------------------------------------------------------
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

        // --------------------------------------------------------------
        // 3. Return the matching asset to the issuer.
        //
        // Goes through Upside's transfer hook, which resolves its own accounts from the ones
        // supplied here — hence the program and validation account being passed alongside the
        // holder records and the rule.
        // --------------------------------------------------------------
        let hook_accounts = [
            ctx.accounts.transfer_restrictions_program.to_account_info(),
            ctx.accounts.real_rwa_extra_metas.to_account_info(),
            ctx.accounts.transfer_restriction_data.to_account_info(),
            ctx.accounts.vault_saa.to_account_info(),
            ctx.accounts.issuer_saa.to_account_info(),
            ctx.accounts.redeem_rule.to_account_info(),
        ];

        crate::token_hook::transfer_checked_with_hook(
            &ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_vault.to_account_info(),
            ctx.accounts.real_rwa_mint.to_account_info(),
            ctx.accounts.issuer_real_rwa_account.to_account_info(),
            ctx.accounts.aegis_authority.to_account_info(),
            &hook_accounts,
            leftover,
            ctx.accounts.real_rwa_mint.decimals,
            &[authority_seeds],
        )?;
    }

    // ------------------------------------------------------------------
    // 4. Square the ledger and confirm the peg survived.
    // ------------------------------------------------------------------
    // Read the ledger back from the chain rather than adjusting it by the amount settled. Both
    // sides can be moved by people Aegis does not control, and absorbing that is what keeps an
    // unsolicited token from halting the launch permanently.
    ctx.accounts.crwa_mint.reload()?;
    ctx.accounts.escrow_vault.reload()?;

    let launch = &mut ctx.accounts.launch;
    launch.crwa_minted = ctx.accounts.crwa_mint.supply;
    launch.real_rwa_locked = ctx.accounts.escrow_vault.amount;
    launch.assert_backing()?;

    launch.stage = LaunchStage::Graduated;

    emit!(Graduated {
        launch: launch.key(),
        unsold_burned: leftover,
        real_rwa_locked: launch.real_rwa_locked,
        crwa_minted: launch.crwa_minted,
    });

    msg!("Aegis: graduated. {} unsold wrapper burned", leftover);
    msg!(
        "Backed 1:1 — {} escrowed, {} wrapped",
        launch.real_rwa_locked,
        launch.crwa_minted
    );

    Ok(())
}
