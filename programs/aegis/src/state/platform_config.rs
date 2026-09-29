use anchor_lang::prelude::*;

/// Global protocol settings.
///
/// Every economic field here falls into one of two groups, and the distinction matters:
///
/// * **Protocol revenue** — a single value the admin sets. The issuer cannot choose these,
///   because the issuer would always choose zero.
/// * **Bounds on issuer choices** — a floor and a ceiling. Inside them the issuer decides,
///   because these are choices about the issuer's own capital where different issuers
///   legitimately want different answers.
///
/// Anything that protects the backing or the anti-rug guarantees is not here at all. Those are
/// fixed in the program and neither party can move them.
#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    /// The global administrator of the Aegis protocol.
    pub admin: Pubkey,

    /// The protocol treasury. Receives the launch creation fee and every claimed revenue stream.
    pub fee_recipient: Pubkey,

    /// Flat fee charged in lamports to create a launch.
    pub creation_fee_lamports: u64,

    /// Master failsafe switch. If true, new launches revert.
    pub is_paused: bool,

    // ==================================================================
    // Protocol revenue — admin sets one value, issuer cannot choose
    // ==================================================================
    /// Fee charged on every trade during the sale, in basis points. This is the placement fee:
    /// the protocol's main compensation for running the launch. Meteora's own floor is 25 bps.
    pub curve_fee_bps: u16,

    /// The issuer's share of that placement fee, as a percentage.
    ///
    /// Zero by default, and deliberately so. The issuer is already paid by the sale proceeds;
    /// handing them part of the fee buyers pay to buy the issuer's own token is charging twice.
    /// In a traditional placement the agent takes the fee and the issuer takes the proceeds.
    pub issuer_curve_fee_share_pct: u8,

    /// The protocol's share of the migration fee, as a percentage.
    ///
    /// Previously this was passed in by the issuer, which meant any issuer could set it so the
    /// protocol received nothing. It is protocol revenue and belongs here.
    ///
    /// Zero by default, so the fee model is a single legible number: the protocol charges the
    /// placement fee above and nothing else. Raise it if that proves too little.
    pub aegis_migration_fee_share_pct: u8,

    /// Share of the graduated liquidity permanently locked to the protocol, as a percentage.
    ///
    /// This is the only liquidity that stays permanently. Its purpose is not anti-rug — the
    /// bridge already guarantees redemption — but to ensure a trading venue never disappears
    /// entirely for holders who have not completed KYC and therefore cannot use the bridge.
    pub aegis_lp_share_pct: u8,

    // ==================================================================
    // Bounds on issuer choices — the issuer decides inside these
    // ==================================================================
    /// Floor on the share of the raise paid out as cash. At zero the issuer raises nothing,
    /// because everything they raised becomes pool liquidity.
    pub min_migration_fee_pct: u8,

    /// Ceiling on the same. The remainder seeds the trading venue, so this bounds how thin that
    /// venue can be.
    pub max_migration_fee_pct: u8,

    /// Minimum share of the issuer's liquidity that must be locked permanently rather than
    /// vested. Zero by default: vesting already prevents a day-one withdrawal, and permanently
    /// locking a claim on a real asset is a genuine loss rather than a formality.
    pub min_issuer_permanent_pct: u8,

    /// Bounds on how long the issuer's liquidity vests back to them, in months. The floor
    /// protects early holders from the market emptying immediately; the ceiling stops an issuer
    /// from tying up their own capital longer than Meteora permits.
    pub min_vesting_months: u16,
    pub max_vesting_months: u16,

    /// Bounds on the trading fee of the graduated pool, in basis points.
    ///
    /// Worth keeping low. A cRWA should trade close to the value of the asset behind it, and a
    /// high pool fee is exactly how far the price can drift before correcting it is worthwhile.
    pub min_pool_fee_bps: u16,
    pub max_pool_fee_bps: u16,

    pub bump: u8,
}
