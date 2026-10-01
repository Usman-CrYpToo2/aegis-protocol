//! Compliance verification against Upside's live on-chain state.
//!
//! Aegis does not own the compliance layer. The issuer configures it — groups, rules, holder
//! records — because those are regulatory decisions belonging to the issuer of a security, and
//! because the issuer can rewrite them at any time regardless of what we do.
//!
//! What Aegis can do is refuse to proceed when the configuration would trap assets. That is
//! what this module is: a read-only gate, run at every point where acting on a misconfigured
//! launch would cost someone money.
//!
//! Call sites: `fund_vault` (before the asset is locked), `launch_pool` (state can change in
//! between), `bridge_deposit` and `bridge_redeem` (where a broken rule actually hurts a holder),
//! `abort_launch` and `claim_unsold`.
//!
//! The supply-cap check is separate — `require_supply_cap_unchanged` — and runs only where a new
//! buyer is about to enter. See its documentation for why.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::transfer_hook::TransferHook;
use anchor_spl::token_2022::spl_token_2022::state::AccountState;
use anchor_spl::token_interface::{get_mint_extension_data, Mint, TokenAccount};

use crate::access_control::accounts::AccessControl;
use crate::errors::AegisError;
use crate::state::Launch;
use crate::transfer_restrictions::accounts::{
    SecurityAssociatedAccount, TransferRestrictionData, TransferRule,
};

/// Everything the gate needs to read. Grouped into a struct so the checks stay in one place
/// instead of being copy-pasted into three instructions and drifting apart.
pub struct ComplianceInputs<'a, 'info> {
    pub launch: &'a Launch,
    pub real_rwa_mint: &'a InterfaceAccount<'info, Mint>,
    pub access_control: &'a AccessControl,
    pub transfer_restriction_data: &'a TransferRestrictionData,
    pub vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub vault_saa: &'a SecurityAssociatedAccount,
    /// The rule governing vault -> investor. This is the redemption path; if it is shut, every
    /// holder is stuck holding a wrapper they can never unwrap.
    pub redeem_rule: &'a TransferRule,
    pub aegis_authority: &'a Pubkey,
    pub transfer_restriction_data_key: &'a Pubkey,
}

pub fn verify_compliance(input: ComplianceInputs) -> Result<()> {
    let ComplianceInputs {
        launch,
        real_rwa_mint,
        access_control,
        transfer_restriction_data,
        vault,
        vault_saa,
        redeem_rule,
        aegis_authority,
        transfer_restriction_data_key,
    } = input;

    let mint_key = real_rwa_mint.key();

    // ------------------------------------------------------------------
    // The registry belongs to this token and is live.
    // ------------------------------------------------------------------
    require_keys_eq!(
        transfer_restriction_data.security_token_mint,
        mint_key,
        AegisError::ComplianceRegistryMismatch
    );
    require_keys_eq!(
        access_control.mint,
        mint_key,
        AegisError::ComplianceRegistryMismatch
    );
    // A paused registry blocks every transfer, including redemptions.
    require!(
        !transfer_restriction_data.paused,
        AegisError::TransfersPaused
    );

    // ------------------------------------------------------------------
    // The hook is still Upside's.
    //
    // Upside sets the mint's transfer-hook *authority* to the same wallet it gives metadata
    // authority, which is the issuer. So the issuer can repoint the hook at another program
    // using Token-2022 directly, which would silently remove the KYC gate. We cannot prevent
    // that, so we check it every time it matters.
    // ------------------------------------------------------------------
    let mint_info = real_rwa_mint.to_account_info();
    let hook = get_mint_extension_data::<TransferHook>(&mint_info)
        .map_err(|_| error!(AegisError::MissingTransferHookExtension))?;
    let hook_program: Option<Pubkey> = hook.program_id.into();
    require!(
        hook_program == Some(crate::transfer_restrictions::ID),
        AegisError::UnauthorizedTransferHook
    );

    // ------------------------------------------------------------------
    // The vault is ours, usable, and unencumbered.
    // ------------------------------------------------------------------
    require_keys_eq!(vault.mint, mint_key, AegisError::VaultMintMismatch);
    require_keys_eq!(vault.owner, *aegis_authority, AegisError::VaultNotOwnedByAegis);
    require!(
        vault.state != AccountState::Frozen,
        AegisError::VaultFrozen
    );
    // A delegate could move the escrowed asset out from under the peg.
    require!(vault.delegate.is_none(), AegisError::VaultHasDelegate);

    // ------------------------------------------------------------------
    // The vault is a registered holder, and the redemption path is open.
    // ------------------------------------------------------------------
    require_eq!(
        vault_saa.group,
        launch.vault_group,
        AegisError::VaultGroupChanged
    );

    require_keys_eq!(
        redeem_rule.transfer_restriction_data,
        *transfer_restriction_data_key,
        AegisError::ComplianceRegistryMismatch
    );
    require_eq!(
        redeem_rule.transfer_group_id_from,
        launch.vault_group,
        AegisError::WrongRedeemRule
    );
    require_eq!(
        redeem_rule.transfer_group_id_to,
        launch.investor_group,
        AegisError::WrongRedeemRule
    );

    // `locked_until` is a sentinel: 0 means forbidden, 1 means allowed immediately, anything
    // larger is a unix timestamp the transfer must wait for.
    require!(
        redeem_rule.locked_until != 0,
        AegisError::RedemptionPathClosed
    );
    let now = Clock::get()?.unix_timestamp as u64;
    require!(
        redeem_rule.locked_until <= 1 || redeem_rule.locked_until <= now,
        AegisError::RedemptionPathLocked
    );

    Ok(())
}

/// The supply cap is still exactly the launch supply.
///
/// Deliberately **not** part of `verify_compliance`. Upside's `set_max_total_supply` can only
/// ever raise the cap, so once the issuer issues more shares — a lawful corporate action — this
/// can never pass again. Checked everywhere, it made that one action permanently block
/// redemption, deposits, graduation and abort.
///
/// Dilution does not break the peg: every cRWA is still backed by one Real RWA in the vault.
/// What a raised cap changes is the price a *new* buyer is paying for, so the check belongs only
/// where someone is about to enter a launch — `fund_vault` and `launch_pool`, before anyone has
/// bought. Holders who are already in must always be able to leave.
pub fn require_supply_cap_unchanged(launch: &Launch, access_control: &AccessControl) -> Result<()> {
    require_eq!(
        access_control.max_total_supply,
        launch.total_supply,
        AegisError::SupplyCapRaised
    );
    Ok(())
}
