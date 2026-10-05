use anchor_lang::prelude::*;

pub mod compliance;
pub mod constants;
pub mod curve;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod token_hook;

use instructions::*;

declare_id!("Hs2JZNwdk6QqMWPkipSe513qLQVQH8EWkU2w8N2vgLUw");

// Upside RWA programs, generated from the IDLs in `idls/`.
//
// We cannot depend on their crates directly: Upside builds against Anchor 0.32 while this
// program is on Anchor 1.2, so the core Solana types are different and would not link.
// `declare_program!` sidesteps that entirely by generating CPI bindings against *our* Anchor
// version, and it reads each program's address out of the IDL, so there is no second copy of
// the address to drift.
declare_program!(access_control);
declare_program!(transfer_restrictions);

#[program]
pub mod aegis {
    use super::*;

    // ==========================================================================================
    // Platform administration
    // ==========================================================================================

    /// Bootstraps the Aegis Protocol global singleton state.
    /// Establishes the master admin and the protocol treasury. Callable once.
    pub fn initialize_platform(ctx: Context<InitializePlatform>) -> Result<()> {
        instructions::initialize_platform::handler(ctx)
    }

    /// Updates global platform parameters. Master admin only.
    pub fn update_platform_config(
        ctx: Context<UpdatePlatformConfig>,
        parameters: UpdatePlatformConfigParams,
    ) -> Result<()> {
        instructions::update_platform_config::handler(ctx, parameters)
    }

    /// Approves a quote token for use in launches. Protocol admin only.
    ///
    /// Also enforces Meteora's own quote-mint rules, so an unsupported token is rejected here
    /// rather than at pool creation, after an issuer has already locked their asset.
    pub fn whitelist_quote_token(ctx: Context<WhitelistQuoteToken>, min_raise: u64) -> Result<()> {
        instructions::quote_token::whitelist_handler(ctx, min_raise)
    }

    /// Updates an approved quote token's status or minimum raise. Existing launches are
    /// unaffected either way.
    pub fn update_quote_token(
        ctx: Context<UpdateQuoteToken>,
        is_active: Option<bool>,
        min_raise: Option<u64>,
    ) -> Result<()> {
        instructions::quote_token::update_handler(ctx, is_active, min_raise)
    }

    // ==========================================================================================
    // The launch, in order
    // ==========================================================================================

    /// Launch step 1: create the Real RWA — the legal, compliance-restricted security token.
    ///
    /// Aegis builds it so its shape is guaranteed correct, then hands the issuer all four
    /// Upside roles. Aegis keeps no authority over the legal token.
    pub fn create_rwa(ctx: Context<CreateRwa>, args: CreateRwaArgs) -> Result<()> {
        instructions::create_rwa::handler(ctx, args)
    }

    /// Launch step 2: lock the entire Real RWA supply in the Aegis escrow vault.
    ///
    /// Verifies the issuer's Upside compliance setup first — in particular that the redemption
    /// path out of the vault is open — then mints the full supply into escrow.
    pub fn fund_vault(ctx: Context<FundVault>, args: FundVaultArgs) -> Result<()> {
        instructions::fund_vault::handler(ctx, args)
    }

    /// Launch step 3: create and validate the Meteora DBC config for this launch.
    pub fn create_rwa_config(
        ctx: Context<CreateRwaConfig>,
        args: CreateRwaConfigArgs,
    ) -> Result<()> {
        instructions::create_rwa_config::handler(ctx, args)
    }

    /// Abandons a launch before any wrapper exists and returns the asset to the issuer.
    ///
    /// Valid only at `Funded` and `Configured`. Beyond those stages buyers hold wrapper tokens
    /// backed by the escrowed asset, and it is no longer the issuer's alone to withdraw.
    pub fn abort_launch(ctx: Context<AbortLaunch>) -> Result<()> {
        instructions::abort_launch::handler(ctx)
    }

    /// Launch step 4: open the sale.
    ///
    /// Meteora creates the cRWA mint and mints the whole supply into its pool. Aegis then reads
    /// the result back and refuses to proceed unless supply, decimals and mint authority are
    /// exactly what the peg requires. Compute-heavy — raise the budget above the 200k default.
    pub fn launch_pool(ctx: Context<LaunchPool>, args: LaunchPoolArgs) -> Result<()> {
        instructions::launch_pool::handler(ctx, args)
    }

    /// Launch step 5: settle the unsold allocation and open the bridge.
    ///
    /// Collects the wrapper the curve never sold, burns it, and records the matching asset as
    /// owed to the issuer, so total supply keeps meaning what it claims. The asset stays in the
    /// vault, so opening the bridge never depends on the issuer being registered.
    /// Permissionless: it squares the books and moves nothing to the caller. Must follow
    /// Meteora's migration, which Meteora itself enforces.
    pub fn finalize_graduation(ctx: Context<FinalizeGraduation>) -> Result<()> {
        instructions::finalize_graduation::handler(ctx)
    }

    // ==========================================================================================
    // After graduation: the bridge and the claims
    // ==========================================================================================

    /// Bridge, wrap direction: deposit the asset, receive the wrapper one for one.
    ///
    /// Open to any approved holder. Puts a ceiling on the wrapper's market price, because a
    /// premium can always be sold into.
    pub fn bridge_deposit(ctx: Context<BridgeDeposit>, amount: u64) -> Result<()> {
        instructions::bridge::deposit_handler(ctx, amount)
    }

    /// Bridge, unwrap direction: burn the wrapper, receive the asset one for one.
    ///
    /// The protocol's compliance gate. This is the moment someone takes ownership of a regulated
    /// security, so the redeemer's registration is verified by Aegis directly rather than left
    /// to the token's hook. Puts a floor under the wrapper's market price.
    pub fn bridge_redeem(ctx: Context<BridgeRedeem>, amount: u64) -> Result<()> {
        instructions::bridge::redeem_handler(ctx, amount)
    }

    /// The issuer collects the asset behind their unsold wrapper, once they are a registered
    /// holder. Pays only what the vault holds above the wrapper supply, so cRWA holders are
    /// always covered first.
    pub fn claim_unsold(ctx: Context<ClaimUnsold>) -> Result<()> {
        instructions::claim_unsold::handler(ctx)
    }

    /// Claims the protocol's share of the bonding curve's trading fees.
    ///
    /// Permissionless: the destination is pinned to the platform fee recipient, so a stranger
    /// calling it only pays to move the protocol's money to the protocol.
    pub fn claim_partner_trading_fee(ctx: Context<ClaimPartnerTradingFee>) -> Result<()> {
        instructions::claim::claim_trading_fee_handler(ctx)
    }

    /// Claims the protocol's share of the migration fee taken off the raise at graduation.
    pub fn claim_partner_migration_fee(ctx: Context<ClaimPartnerQuote>) -> Result<()> {
        instructions::claim::claim_migration_fee_handler(ctx)
    }
}
