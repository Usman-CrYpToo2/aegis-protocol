use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::access_control::accounts::{AccessControl, WalletRole};
use crate::access_control::cpi::accounts::MintSecurities;
use crate::access_control::program::AccessControl as AccessControlProgram;
use crate::compliance::{require_supply_cap_unchanged, verify_compliance, ComplianceInputs};
use crate::constants::*;
use crate::errors::AegisError;
use crate::events::VaultFunded;
use crate::state::{Launch, LaunchStage};
use crate::transfer_restrictions::accounts::{
    SecurityAssociatedAccount, TransferRestrictionData, TransferRule,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct FundVaultArgs {
    /// The Upside transfer group holding KYC-approved investors. The issuer chooses their own
    /// group numbering, so Aegis cannot assume it — but it must be pinned, because redemption
    /// is only ever permitted into this group.
    pub investor_group: u64,
}

/// Launch step 2: lock the whole asset in escrow.
///
/// Before this runs, the issuer must have configured compliance through Upside: the registry,
/// the hook's companion account, their transfer groups and rules, and a holder record for this
/// vault. Aegis deliberately does not do that setup — group and rule design is a regulatory
/// decision belonging to the issuer of a security, and they can rewrite it afterwards anyway.
///
/// What Aegis does instead is refuse to lock the asset unless the configuration actually works,
/// and in particular unless the redemption path out of the vault is open. Checking here rather
/// than at launch means a misconfigured issuer finds out *before* their asset is immobilised.
///
/// The minting is done here, by CPI, rather than left to the issuer beforehand. The issuer
/// still signs and still supplies the ReserveAdmin role, so nothing changes legally — but it
/// makes "the vault holds exactly the launch supply" true by construction instead of something
/// we merely observe and hope nobody disturbs.
#[derive(Accounts)]
#[instruction(args: FundVaultArgs)]
pub struct FundVault<'info> {
    /// Must be the issuer recorded on the launch, and must hold ReserveAdmin.
    #[account(mut)]
    pub issuer: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, real_rwa_mint.key().as_ref()],
        bump = launch.bump,
        has_one = real_rwa_mint @ AegisError::ComplianceRegistryMismatch,
        has_one = issuer @ AegisError::NotLaunchIssuer,
    )]
    pub launch: Box<Account<'info, Launch>>,

    #[account(mut)]
    pub real_rwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: signer-only PDA. Owns the escrow vault; holds no data.
    #[account(
        seeds = [AEGIS_AUTHORITY_SEED, launch.key().as_ref()],
        bump,
    )]
    pub aegis_authority: UncheckedAccount<'info>,

    /// Upside's `mint_securities` requires the destination to be an associated token account of
    /// the destination authority, so the vault address is fully determined by the launch.
    #[account(
        mut,
        associated_token::mint = real_rwa_mint,
        associated_token::authority = aegis_authority,
        associated_token::token_program = token_program,
    )]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [b"ac", real_rwa_mint.key().as_ref()],
        bump,
        seeds::program = crate::access_control::ID,
    )]
    pub access_control: Box<Account<'info, AccessControl>>,

    /// Proves the issuer still holds ReserveAdmin. Upside re-checks this, but failing here
    /// gives a message that names the actual problem.
    #[account(
        seeds = [b"wallet_role", real_rwa_mint.key().as_ref(), issuer.key().as_ref()],
        bump,
        seeds::program = crate::access_control::ID,
    )]
    pub issuer_wallet_role: Box<Account<'info, WalletRole>>,

    #[account(
        seeds = [b"trd", real_rwa_mint.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub transfer_restriction_data: Box<Account<'info, TransferRestrictionData>>,

    /// The vault's holder record. Also required by `mint_securities` for any destination that
    /// is not a registered lockup escrow — which ours is not, and cannot be.
    #[account(
        seeds = [b"saa", escrow_vault.key().as_ref()],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub vault_saa: Box<Account<'info, SecurityAssociatedAccount>>,

    /// The vault -> investor rule. Its address encodes both group ids, so passing the wrong
    /// rule cannot pass the seed check.
    #[account(
        seeds = [
            b"tr",
            transfer_restriction_data.key().as_ref(),
            vault_saa.group.to_le_bytes().as_ref(),
            args.investor_group.to_le_bytes().as_ref(),
        ],
        bump,
        seeds::program = crate::transfer_restrictions::ID,
    )]
    pub redeem_rule: Box<Account<'info, TransferRule>>,

    pub access_control_program: Program<'info, AccessControlProgram>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<FundVault>, args: FundVaultArgs) -> Result<()> {
    require!(
        ctx.accounts.launch.stage == LaunchStage::TokenCreated,
        AegisError::InvalidLaunchStage
    );
    require!(
        ctx.accounts.issuer_wallet_role.role & ROLE_RESERVE_ADMIN == ROLE_RESERVE_ADMIN,
        AegisError::UnauthorizedIssuer
    );
    // A vault sharing a group with investors would let investors transfer to each other through
    // rules meant for the escrow, and makes the redemption rule self-referential.
    require_neq!(
        args.investor_group,
        ctx.accounts.vault_saa.group,
        AegisError::InvalidGroupConfiguration
    );

    let total_supply = ctx.accounts.launch.total_supply;

    // Pin the groups before verifying, so the gate compares against what we are committing to
    // rather than against whatever it happens to read.
    {
        let launch = &mut ctx.accounts.launch;
        launch.vault_group = ctx.accounts.vault_saa.group;
        launch.investor_group = args.investor_group;
        launch.authority_bump = ctx.bumps.aegis_authority;
    }

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

    // No dilution headroom before the supply is locked. See `require_supply_cap_unchanged`.
    require_supply_cap_unchanged(&ctx.accounts.launch, &ctx.accounts.access_control)?;

    // The vault must be empty. A pre-funded vault would mean tokens arrived by some path we did
    // not account for, and the "minted exactly once, exactly here" guarantee would be a guess.
    require_eq!(
        ctx.accounts.escrow_vault.amount,
        0,
        AegisError::VaultUnderfunded
    );
    require_eq!(
        ctx.accounts.real_rwa_mint.supply,
        0,
        AegisError::SupplyMintedElsewhere
    );

    // ------------------------------------------------------------------
    // Mint the entire supply into escrow, using the issuer's ReserveAdmin role.
    // ------------------------------------------------------------------
    crate::access_control::cpi::mint_securities(
        CpiContext::new(
            ctx.accounts.access_control_program.key(),
            MintSecurities {
                authority: ctx.accounts.issuer.to_account_info(),
                authority_wallet_role: ctx.accounts.issuer_wallet_role.to_account_info(),
                access_control: ctx.accounts.access_control.to_account_info(),
                security_mint: ctx.accounts.real_rwa_mint.to_account_info(),
                destination_account: ctx.accounts.escrow_vault.to_account_info(),
                destination_authority: ctx.accounts.aegis_authority.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                security_associated_account: Some(ctx.accounts.vault_saa.to_account_info()),
            },
        ),
        total_supply,
    )?;

    // ------------------------------------------------------------------
    // Confirm what actually landed, rather than trusting the CPI's intent.
    // ------------------------------------------------------------------
    ctx.accounts.escrow_vault.reload()?;
    ctx.accounts.real_rwa_mint.reload()?;

    // At least, rather than exactly. Nothing can have been donated here — the mint's supply was
    // zero a moment ago — but the weaker form costs nothing and cannot be turned into a block.
    require_gte!(
        ctx.accounts.escrow_vault.amount,
        total_supply,
        AegisError::VaultUnderfunded
    );
    // Guards against a supply cap that allowed minting beyond this launch, or tokens minted to
    // another account in the same transaction.
    require_eq!(
        ctx.accounts.real_rwa_mint.supply,
        total_supply,
        AegisError::SupplyMintedElsewhere
    );

    let launch = &mut ctx.accounts.launch;
    launch.escrow_vault = ctx.accounts.escrow_vault.key();
    launch.real_rwa_locked = total_supply;
    launch.stage = LaunchStage::Funded;

    emit!(VaultFunded {
        launch: launch.key(),
        real_rwa_mint: launch.real_rwa_mint,
        escrow_vault: launch.escrow_vault,
        amount: launch.real_rwa_locked,
        vault_group: launch.vault_group,
        investor_group: launch.investor_group,
    });

    msg!("Aegis: escrowed {} of {}", total_supply, launch.real_rwa_mint);
    msg!("Vault {} (group {})", launch.escrow_vault, launch.vault_group);
    msg!("Redemption open to investor group {}", launch.investor_group);

    Ok(())
}
