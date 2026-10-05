use anchor_lang::prelude::*;

// ==========================================
// METEORA ECOSYSTEM PROGRAM IDS (MAINNET)
// ==========================================

/// The official Meteora Dynamic Bonding Curve (DBC) Program ID.
pub const METEORA_DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

/// The official Meteora DAMM v2 Program ID (cp_amm). Migration target once the curve completes.
pub const METEORA_DAMM_V2_PROGRAM_ID: Pubkey =
    pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

// NOTE: Upside program IDs are intentionally NOT declared here. `declare_program!` in lib.rs
// reads them from the IDLs in `idls/`, exposing `access_control::ID` and
// `transfer_restrictions::ID`. Duplicating them would let the two copies drift apart.

// ==========================================
// AEGIS PROTOCOL PDA SEEDS
// ==========================================

/// Global platform configuration singleton.
pub const PLATFORM_CONFIG_SEED: &[u8] = b"platform_config";

/// Per-launch state, keyed on the Real RWA mint. One launch per asset, structurally.
pub const LAUNCH_SEED: &[u8] = b"launch";

/// Admin-approved quote token, keyed on the quote mint. Existence is the whitelist.
pub const QUOTE_TOKEN_SEED: &[u8] = b"quote_token";

/// Signer-only PDA that owns the escrow vault and acts as Meteora's `fee_claimer`
/// (which also makes it the cRWA mint authority). One per launch.
pub const AEGIS_AUTHORITY_SEED: &[u8] = b"authority";

// ==========================================
// UPSIDE ACCESS CONTROL ROLE BITMASK
// ==========================================
// Mirrors `access_control::Roles`. Verified against
// upsideos-solana-rwa/programs/access-control/src/contexts/common.rs

pub const ROLE_CONTRACT_ADMIN: u8 = 1;
pub const ROLE_RESERVE_ADMIN: u8 = 2;
pub const ROLE_WALLETS_ADMIN: u8 = 4;
pub const ROLE_TRANSFER_ADMIN: u8 = 8;

/// The three roles Aegis hands the issuer on top of ContractAdmin, which Upside grants the
/// payer automatically. The issuer ends up with all four: full legal control of the security.
/// Aegis deliberately holds none of them.
pub const ISSUER_DELEGATED_ROLES: u8 =
    ROLE_RESERVE_ADMIN | ROLE_WALLETS_ADMIN | ROLE_TRANSFER_ADMIN;

// ==========================================
// UPSIDE TRANSFER GROUPS (Aegis convention)
// ==========================================

/// Group 0 is created automatically by `initialize_transfer_restrictions_data`. Unused by Aegis.
pub const GROUP_UNASSIGNED: u64 = 0;
/// KYC-approved investors. The only group allowed to receive Real RWA on unwrap.
pub const GROUP_INVESTOR: u64 = 1;
/// The Aegis escrow vault, and nothing else.
pub const GROUP_VAULT: u64 = 2;

/// `locked_until` sentinel meaning "allowed immediately". 0 means "forbidden".
pub const RULE_ALLOW_IMMEDIATELY: u64 = 1;

// ==========================================
// AEGIS PROTOCOL LIMITS
// ==========================================

/// Meteora DBC hard limit on curve segments (`MAX_CURVE_POINT`).
pub const MAX_CURVE_SEGMENTS: usize = 16;

/// Meteora DBC rejects `token_decimal` outside 6..=9, and the Real RWA must match the cRWA
/// exactly or the 1:1 peg is off by orders of magnitude.
pub const MIN_RWA_DECIMALS: u8 = 6;
pub const MAX_RWA_DECIMALS: u8 = 9;

/// Token-2022 metadata bounds. Kept tight to bound rent and CPI compute.
pub const MAX_TOKEN_NAME_LEN: usize = 32;
pub const MAX_TOKEN_SYMBOL_LEN: usize = 10;
pub const MAX_TOKEN_URI_LEN: usize = 200;

// ==========================================
// METEORA-IMPOSED BOUNDS
// ==========================================
// Mirrored from the pinned Meteora DBC revision. Aegis checks them at configuration time so a
// bad value is rejected by this program with a readable error, instead of surfacing as an
// opaque Meteora failure part-way through a CPI.

/// Meteora's floor on the curve's base fee (`constants::fee::MIN_FEE_BPS`). 0.25%.
pub const METEORA_MIN_FEE_BPS: u16 = 25;

/// Aegis's own ceiling on the curve fee. Meteora would allow up to 99%, which is a fee only in
/// name; a placement fee above 10% is not something the protocol should be able to set.
pub const MAX_CURVE_FEE_BPS: u16 = 1_000;

/// Meteora's bounds on the graduated pool's swap fee (`MIN/MAX_MIGRATED_POOL_FEE_BPS`).
pub const METEORA_MIN_POOL_FEE_BPS: u16 = 10;
pub const METEORA_MAX_POOL_FEE_BPS: u16 = 1_000;

/// Meteora requires at least 10% of graduated liquidity to still be locked one day after
/// migration. Aegis's own permanent share is what guarantees that floor, so it can never be
/// configured below it — an issuer is otherwise free to vest every unit of their own share.
pub const MIN_AEGIS_LP_SHARE_PCT: u8 = 10;

/// Vesting is expressed in 30-day periods. Meteora caps the total lock at two years
/// (`MAX_LOCK_DURATION_IN_SECONDS`), so 24 periods is the most that can be scheduled.
pub const MAX_VESTING_MONTHS: u16 = 24;

/// One vesting period, in seconds. 30 days.
pub const VESTING_PERIOD_SECONDS: u64 = 30 * 24 * 60 * 60;
