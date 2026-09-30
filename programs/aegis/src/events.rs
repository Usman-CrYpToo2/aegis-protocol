//! Events.
//!
//! Nothing in the protocol depends on these; they exist so a frontend or indexer can follow a
//! launch without polling every account, and so there is a durable record of who did what.
//!
//! Note on what cannot be emitted: a failed transaction produces no logs that survive, so there
//! is no event for a backing shortfall or a broken compliance setup. Those are observable by
//! comparing the vault balance against the wrapper supply, which any watcher can do from two
//! account reads.

use anchor_lang::prelude::*;

use crate::state::RwaCurveArchetype;

#[event]
pub struct PlatformInitialized {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub creation_fee_lamports: u64,
}

#[event]
pub struct PlatformConfigUpdated {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub creation_fee_lamports: u64,
    pub is_paused: bool,
}

#[event]
pub struct QuoteTokenApproved {
    pub mint: Pubkey,
    pub decimals: u8,
    pub is_legacy_spl: bool,
}

#[event]
pub struct QuoteTokenStatusChanged {
    pub mint: Pubkey,
    pub is_active: bool,
}

#[event]
pub struct RwaCreated {
    pub launch: Pubkey,
    pub real_rwa_mint: Pubkey,
    pub issuer: Pubkey,
    pub total_supply: u64,
    pub decimals: u8,
}

#[event]
pub struct VaultFunded {
    pub launch: Pubkey,
    pub real_rwa_mint: Pubkey,
    pub escrow_vault: Pubkey,
    pub amount: u64,
    pub vault_group: u64,
    pub investor_group: u64,
}

#[event]
pub struct LaunchConfigured {
    pub launch: Pubkey,
    pub meteora_config: Pubkey,
    pub quote_mint: Pubkey,
    pub archetype: RwaCurveArchetype,
    pub target_raise: u64,
    pub sqrt_start_price: u128,
    pub sqrt_end_price: u128,
    /// The price at which the sale actually closes, which is what the last buyer pays.
    pub migration_sqrt_price: u128,
    pub migration_fee_pct: u8,
}

#[event]
pub struct PoolLaunched {
    pub launch: Pubkey,
    pub crwa_mint: Pubkey,
    pub virtual_pool: Pubkey,
    /// Equal to the escrowed asset at this moment, by construction.
    pub crwa_supply: u64,
}

#[event]
pub struct Graduated {
    pub launch: Pubkey,
    /// Unsold wrapper destroyed.
    pub unsold_burned: u64,
    /// Real RWA behind that wrapper, now owed to the issuer and collectable with `claim_unsold`.
    pub issuer_unsold: u64,
    pub real_rwa_locked: u64,
    pub crwa_minted: u64,
}

#[event]
pub struct UnsoldClaimed {
    pub launch: Pubkey,
    pub issuer: Pubkey,
    pub amount: u64,
    /// Still owed to the issuer. Non-zero only if the vault held less than they were owed.
    pub remaining: u64,
}

#[event]
pub struct BridgeDeposited {
    pub launch: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub real_rwa_locked: u64,
    pub crwa_minted: u64,
}

#[event]
pub struct BridgeRedeemed {
    pub launch: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub real_rwa_locked: u64,
    pub crwa_minted: u64,
}

#[event]
pub struct PartnerRevenueClaimed {
    pub launch: Pubkey,
    /// 0 trading fee, 1 migration fee. See `instructions::claim::RevenueKind`.
    pub kind: u8,
    pub quote_mint: Pubkey,
    pub amount: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct LaunchAborted {
    pub launch: Pubkey,
    pub real_rwa_mint: Pubkey,
    pub issuer: Pubkey,
    pub returned: u64,
}
