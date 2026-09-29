use anchor_lang::prelude::*;

/// An admin-approved quote token, at PDA ["quote_token", mint].
///
/// Existence of this account is the whitelist: no account, no launch. Keyed on the mint rather
/// than held as a list inside `PlatformConfig` so the set can grow without reallocating, and so
/// checking one costs a single account read.
///
/// Approval is not only a business decision. Meteora refuses quote mints it cannot handle
/// permissionlessly, so the check that happens at approval time is also the check that stops an
/// issuer from configuring a launch that Meteora would reject halfway through.
#[account]
#[derive(InitSpace)]
pub struct QuoteToken {
    pub mint: Pubkey,

    /// Copied at approval so callers do not need to load the mint to reason about amounts.
    pub decimals: u8,

    /// Whether new launches may use this token. Deactivating is preferred over closing the
    /// account: launches already configured against this quote token keep working, and the
    /// address cannot be re-approved with different data behind an operator's back.
    pub is_active: bool,

    /// True when the mint is owned by the legacy SPL Token program rather than Token-2022.
    ///
    /// Client-facing only: the program never reads it, because Meteora validates the quote token
    /// program against the mint itself during pool creation. It is recorded so a frontend can
    /// build the launch transaction without a second account fetch.
    pub is_legacy_spl: bool,

    /// Smallest raise permitted in this token, in its own smallest units.
    ///
    /// Held per token rather than globally because the number is meaningless without the
    /// token's decimals: a million units of a six-decimal stablecoin is a dollar, and of a
    /// nine-decimal token it is a thousandth of one.
    pub min_raise: u64,

    /// Unix timestamp of approval. Useful for audit trails; never read by the program.
    pub approved_at: i64,

    pub bump: u8,
}
