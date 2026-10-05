use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::transfer_hook::TransferHook;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{get_mint_extension_data, Mint, TokenAccount, TokenInterface};

use dynamic_bonding_curve::cpi::accounts::InitializeVirtualPoolWithToken2022TransferHookCtx;
use dynamic_bonding_curve::InitializePoolParameters;

use crate::access_control::accounts::AccessControl;
use crate::compliance::{require_supply_cap_unchanged, verify_compliance, ComplianceInputs};
use crate::constants::*;
use crate::errors::AegisError;
use crate::events::PoolLaunched;
use crate::state::{Launch, LaunchStage, PlatformConfig};
use crate::transfer_restrictions::accounts::{
    SecurityAssociatedAccount, TransferRestrictionData, TransferRule,
};

/// Token-2022 resolves a hook's extra accounts through a per-mint account at this seed. Mirrors
/// `aegis_hook::EXTRA_ACCOUNT_METAS_SEED`.
const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LaunchPoolArgs {
    /// Metadata for the wrapper token. Cosmetic: the legal identity lives on the Real RWA.
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

/// Launch step 4: open the sale.
///
/// Meteora creates the cRWA mint inside its own instruction — Aegis cannot create it earlier,
/// which is why the wrapper does not exist until this point — and mints the entire supply
/// straight into the pool vault.
///
/// Because the mint is produced by another program, the checks that matter run *after* the CPI
/// rather than before it. Three of them decide whether the protocol's central claim is true:
/// that cRWA supply equals the escrowed asset exactly, that mint authority landed on the Aegis
/// PDA rather than the issuer, and that the decimals match on both sides. If any is wrong the
/// whole transaction reverts and no sale happens. This is where 1:1 backing stops being a claim
/// and becomes something the program refuses to proceed without.
///
/// The hook's companion account is created in the same transaction. It cannot be created before
/// the mint exists, and without it every single trade of the token fails — a pool that looks
/// healthy and is entirely unusable.
///
/// This instruction is compute-heavy: Meteora initializes a mint with extensions, writes
/// metadata, mints the supply and reassigns two authorities, on top of Aegis re-verifying
/// compliance. Callers should raise the compute budget rather than rely on the 200k default.
#[derive(Accounts)]
pub struct LaunchPool<'info> {
    /// The issuer. Becomes Meteora's pool creator, which carries the issuer's share of the
    /// graduated liquidity position, their trading fees, surplus and migration fee.
    #[account(mut)]
    pub issuer: Signer<'info>,

    #[account(
        seeds = [PLATFORM_CONFIG_SEED],
        bump = platform_config.bump,
    )]
    pub platform_config: Box<Account<'info, PlatformConfig>>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, real_rwa_mint.key().as_ref()],
        bump = launch.bump,
        has_one = real_rwa_mint @ AegisError::ComplianceRegistryMismatch,
        has_one = issuer @ AegisError::NotLaunchIssuer,
        has_one = escrow_vault @ AegisError::VaultMintMismatch,
        constraint = launch.meteora_config == meteora_config.key() @ AegisError::WrongMeteoraConfig,
        constraint = launch.quote_mint == quote_mint.key() @ AegisError::QuoteMintMismatch,
    )]
    pub launch: Box<Account<'info, Launch>>,

    // ------------------------------------------------------------------
    // Backing side — the asset that must still be there.
    // ------------------------------------------------------------------
    pub real_rwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: signer-only PDA. Owns the escrow vault and is Meteora's `fee_claimer`, which is
    /// what makes it the cRWA mint authority once the pool exists.
    #[account(
        seeds = [AEGIS_AUTHORITY_SEED, launch.key().as_ref()],
        bump = launch.authority_bump,
    )]
    pub aegis_authority: UncheckedAccount<'info>,

    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,

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

    /// The vault -> investor rule, pinned to the groups recorded at funding so the redemption
    /// path cannot have been quietly redirected to a different pair of groups.
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

    // ------------------------------------------------------------------
    // Meteora side.
    // ------------------------------------------------------------------
    /// CHECK: the config created at step 3, pinned to the launch record above. Meteora
    /// deserializes and validates it.
    pub meteora_config: UncheckedAccount<'info>,

    /// CHECK: Meteora's own global pool authority. A compile-time constant in their program, so
    /// pinning it costs nothing and removes an account the caller could otherwise choose.
    #[account(address = dynamic_bonding_curve::const_pda::pool_authority::ID)]
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: a fresh keypair. Meteora initializes the mint inside the CPI, so it arrives empty
    /// and cannot be typed as a `Mint` until afterwards. It signs for its own rent.
    #[account(mut)]
    pub crwa_mint: Signer<'info>,

    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Meteora initializes this at a PDA derived from the config and both mints, so a
    /// substituted address fails inside their program rather than here.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Meteora initializes this; read back after the CPI to confirm the whole supply
    /// landed in it.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,

    /// CHECK: Meteora initializes this.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    /// CHECK: Meteora's event-authority PDA, derived from the pinned program below.
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = METEORA_DBC_PROGRAM_ID,
    )]
    pub meteora_event_authority: UncheckedAccount<'info>,

    /// CHECK: pinned to the official program. Everything Meteora-derived above is checked
    /// against this address, so without the pin none of those derivations mean anything.
    #[account(address = METEORA_DBC_PROGRAM_ID @ AegisError::InvalidDbcProgram)]
    pub meteora_dbc_program: UncheckedAccount<'info>,

    // ------------------------------------------------------------------
    // Hook side.
    // ------------------------------------------------------------------
    /// CHECK: pinned. Meteora additionally requires it to match the hook recorded on the config,
    /// so a mismatch here would fail inside their program too.
    #[account(
        executable,
        address = aegis_hook::ID @ AegisError::InvalidHookProgram,
    )]
    pub aegis_hook_program: UncheckedAccount<'info>,

    /// CHECK: created by the hook program below, at the address Token-2022 will look for.
    #[account(
        mut,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, crwa_mint.key().as_ref()],
        bump,
        seeds::program = aegis_hook::ID,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// Quote side may be legacy SPL or Token-2022; Meteora checks it against the quote mint.
    pub token_quote_program: Interface<'info, TokenInterface>,
    /// The base side is always Token-2022.
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<LaunchPool>, args: LaunchPoolArgs) -> Result<()> {
    require!(
        !ctx.accounts.platform_config.is_paused,
        AegisError::ProtocolPaused
    );
    require!(
        ctx.accounts.launch.stage == LaunchStage::Configured,
        AegisError::InvalidLaunchStage
    );

    let total_supply = ctx.accounts.launch.total_supply;

    // ------------------------------------------------------------------
    // Re-verify compliance.
    //
    // Everything checked at funding is under the issuer's control and could have changed since:
    // transfers paused, the redemption rule closed, the vault frozen, the hook repointed, the
    // supply cap raised. Launching into any of those would create a wrapper nobody can ever
    // unwrap.
    // ------------------------------------------------------------------
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

    // The last point before buyers arrive. A cap raised after funding means the curve was priced
    // for a supply that no longer exists, so nobody should start buying into it.
    require_supply_cap_unchanged(&ctx.accounts.launch, &ctx.accounts.access_control)?;

    // The asset itself must still be present and untouched. `verify_compliance` proves the vault
    // is usable; this proves it is still full. The issuer keeps ReserveAdmin and can force a
    // transfer out of any account, so the balance is re-read rather than assumed.
    // At least, rather than exactly: an unsolicited deposit into the vault leaves the launch
    // over-collateralised, which is harmless, and rejecting it would let anyone block a launch.
    // A shortfall is the case that matters and is still caught.
    require_gte!(
        ctx.accounts.escrow_vault.amount,
        total_supply,
        AegisError::VaultUnderfunded
    );
    require_eq!(
        ctx.accounts.real_rwa_mint.supply,
        total_supply,
        AegisError::SupplyMintedElsewhere
    );

    // ------------------------------------------------------------------
    // Create the pool. Meteora mints the whole cRWA supply into its own base vault.
    // ------------------------------------------------------------------
    dynamic_bonding_curve::cpi::initialize_virtual_pool_with_token2022_transfer_hook(
        CpiContext::new(
            ctx.accounts.meteora_dbc_program.key(),
            InitializeVirtualPoolWithToken2022TransferHookCtx {
                config: ctx.accounts.meteora_config.to_account_info(),
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                // The issuer is Meteora's creator, which is what routes the raise proceeds and
                // the issuer's liquidity position to them rather than to Aegis.
                creator: ctx.accounts.issuer.to_account_info(),
                base_mint: ctx.accounts.crwa_mint.to_account_info(),
                quote_mint: ctx.accounts.quote_mint.to_account_info(),
                pool: ctx.accounts.pool.to_account_info(),
                base_vault: ctx.accounts.base_vault.to_account_info(),
                quote_vault: ctx.accounts.quote_vault.to_account_info(),
                transfer_hook_program: ctx.accounts.aegis_hook_program.to_account_info(),
                payer: ctx.accounts.issuer.to_account_info(),
                token_quote_program: ctx.accounts.token_quote_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.meteora_event_authority.to_account_info(),
                program: ctx.accounts.meteora_dbc_program.to_account_info(),
            },
        ),
        InitializePoolParameters {
            name: args.name,
            symbol: args.symbol,
            uri: args.uri,
        },
    )?;

    // ------------------------------------------------------------------
    // Inspect what Meteora actually produced.
    //
    // The mint was created by another program from a config written in an earlier transaction.
    // Reading it back is the only way to know the peg holds, so none of this is assumed.
    // ------------------------------------------------------------------
    let crwa_mint_info = ctx.accounts.crwa_mint.to_account_info();

    let crwa = {
        let data = crwa_mint_info.try_borrow_data()?;
        Mint::try_deserialize(&mut &data[..]).map_err(|_| error!(AegisError::CrwaMintMalformed))?
    };

    // The peg, asserted rather than trusted: every cRWA that now exists is matched by a Real RWA
    // already locked in the vault.
    require_eq!(crwa.supply, total_supply, AegisError::CrwaSupplyMismatch);

    // A decimal mismatch would silently scale the peg by a power of ten in every later swap.
    require_eq!(
        crwa.decimals,
        ctx.accounts.launch.decimals,
        AegisError::CrwaDecimalsMismatch
    );

    // The single most important post-condition. Meteora offers an authority option that hands
    // mint rights to the pool creator — the issuer — which would let them print unbacked wrapper
    // tokens at will. Step 3 asks for the partner option instead; this proves it was honoured.
    require!(
        crwa.mint_authority == Some(ctx.accounts.aegis_authority.key()).into(),
        AegisError::CrwaMintAuthorityMismatch
    );

    // Freeze authority must be nobody: a freezable wrapper could be used to strand holders.
    require!(
        crwa.freeze_authority.is_none(),
        AegisError::CrwaFreezeAuthoritySet
    );

    {
        let hook = get_mint_extension_data::<TransferHook>(&crwa_mint_info)
            .map_err(|_| error!(AegisError::CrwaMintMalformed))?;
        let hook_program: Option<Pubkey> = hook.program_id.into();
        require!(
            hook_program == Some(aegis_hook::ID),
            AegisError::InvalidHookProgram
        );
    }

    // Every wrapper token should be sitting in Meteora's vault, waiting to be sold. Anything
    // else means supply escaped somewhere we are not accounting for.
    {
        let data = ctx.accounts.base_vault.try_borrow_data()?;
        let vault = TokenAccount::try_deserialize(&mut &data[..])
            .map_err(|_| error!(AegisError::CrwaMintMalformed))?;
        require_keys_eq!(
            vault.mint,
            ctx.accounts.crwa_mint.key(),
            AegisError::CrwaSupplyMismatch
        );
        require_eq!(vault.amount, crwa.supply, AegisError::CrwaSupplyMismatch);
    }

    // ------------------------------------------------------------------
    // Give the hook its companion account.
    //
    // Token-2022 resolves a hook's extra accounts through this, so without it every transfer of
    // the mint fails. It cannot be created before the mint exists, which is why it happens here
    // and not in a step of its own: a pool that trades nothing is worse than no pool.
    // ------------------------------------------------------------------
    aegis_hook::cpi::initialize_extra_account_meta_list(CpiContext::new(
        ctx.accounts.aegis_hook_program.key(),
        aegis_hook::cpi::accounts::InitializeExtraAccountMetaList {
            payer: ctx.accounts.issuer.to_account_info(),
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            mint: crwa_mint_info.clone(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    ))?;

    // ------------------------------------------------------------------
    // Record. The peg ledger becomes meaningful from here on.
    // ------------------------------------------------------------------
    let launch = &mut ctx.accounts.launch;
    launch.crwa_mint = ctx.accounts.crwa_mint.key();
    launch.virtual_pool = ctx.accounts.pool.key();
    launch.crwa_minted = crwa.supply;
    launch.real_rwa_locked = ctx.accounts.escrow_vault.amount;
    launch.stage = LaunchStage::Live;
    launch.assert_backing()?;

    emit!(PoolLaunched {
        launch: launch.key(),
        crwa_mint: launch.crwa_mint,
        virtual_pool: launch.virtual_pool,
        crwa_supply: launch.crwa_minted,
    });

    msg!(
        "Aegis: live. cRWA {} pool {}",
        launch.crwa_mint,
        launch.virtual_pool
    );
    msg!(
        "Backed 1:1 — {} escrowed, {} wrapped",
        launch.real_rwa_locked,
        launch.crwa_minted
    );

    Ok(())
}
