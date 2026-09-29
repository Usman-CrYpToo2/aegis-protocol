use anchor_lang::prelude::*;

#[error_code]
pub enum AegisError {
    // ==========================================
    // AUTHORIZATION ERRORS
    // ==========================================
    #[msg("You are not authorized to perform this administrative action.")]
    UnauthorizedAccess,

    #[msg("The caller does not own this RWA launch record.")]
    UnauthorizedIssuer,

    // ==========================================
    // PRESET & CONFIGURATION ERRORS
    // ==========================================
    #[msg("The requested DBC curve preset does not exist.")]
    PresetNotFound,

    #[msg("The requested DBC curve preset is currently deactivated by the protocol.")]
    PresetInactive,

    #[msg("The provided RWA valuation target must be greater than zero.")]
    InvalidValuationTarget,

    // ==========================================
    // COMPLIANCE & TOKEN-2022 ERRORS
    // ==========================================
    #[msg("Institutional RWAs must use the Token-2022 standard.")]
    InvalidTokenStandard,

    #[msg("The Token-2022 mint is missing the mandatory Transfer Hook extension for KYC.")]
    MissingTransferHookExtension,

    #[msg("The Transfer Hook points to an unauthorized program ID. Must point to Aegis KYC Hook.")]
    UnauthorizedTransferHook,

    // ==========================================
    // MATH & SYSTEM ERRORS
    // ==========================================
    #[msg("A mathematical overflow occurred during fee or curve calculation.")]
    MathOverflow,

    #[msg("Failed to serialize the curve segments for the Meteora CPI.")]
    CurveSerializationFailed,

    #[msg("Unauthorized: caller is not the protocol administrator.")]
    Unauthorized,

    #[msg("Admin cannot be the default/zero public key.")]
    InvalidAdmin,


    #[msg("Fee recipient cannot be the default/zero public key.")]
    InvalidFeeRecipient,

    #[msg("Transfer hook program does not match the official Upside registry")]
    InvalidUpsideTransferHook,
    #[msg("Missing Upside Transfer Hook Program in account context")]
    MissingTransferHookProgram,
    #[msg("Starting price must be greater than zero")]
    InvalidStartPrice,
    #[msg("Migration quote threshold must be greater than zero")]
    InvalidQuoteThreshold,
    #[msg("Curve must contain between 2 and 16 segments")]
    InvalidSegmentCount,
    #[msg("Curve is non-monotonic; prices must strictly increase")]
    NonMonotonicCurve,
    #[msg("Curve contains a zero-liquidity segment")]
    ZeroLiquiditySegment,
    #[msg("Curve quote capacity is mathematically smaller than the migration threshold")]
    CurveCapacityTooSmall,
    #[msg("Curve final price exceeds the authorized maximum multiplier for this RWA archetype")]
    PriceExpansionExceedsRwaLimit,

    // ==========================================
    // LAUNCH LIFECYCLE
    // ==========================================
    #[msg("The protocol is paused. No new launches can be created.")]
    ProtocolPaused,

    #[msg("This launch is not at the stage required for this action.")]
    InvalidLaunchStage,

    #[msg("Backing shortfall: the escrowed Real RWA no longer covers the cRWA in circulation.")]
    BackingShortfall,

    // ==========================================
    // RWA TOKEN CREATION
    // ==========================================
    #[msg("RWA decimals must be between 6 and 9. Meteora rejects anything outside this range.")]
    InvalidRwaDecimals,

    #[msg("Total supply must be greater than zero.")]
    InvalidTotalSupply,

    #[msg("Token name is too long.")]
    TokenNameTooLong,

    #[msg("Token symbol is too long.")]
    TokenSymbolTooLong,

    #[msg("Token metadata URI is too long.")]
    TokenUriTooLong,

    // ==========================================
    // COMPLIANCE GATE
    // ==========================================
    #[msg("The Upside compliance registry does not belong to this token.")]
    ComplianceRegistryMismatch,

    #[msg("Transfers of the Real RWA are paused by the issuer.")]
    TransfersPaused,

    #[msg("The issuer raised the supply cap above the launch supply. Holders would be diluted.")]
    SupplyCapRaised,

    #[msg("The escrow vault holds the wrong mint.")]
    VaultMintMismatch,

    #[msg("The escrow vault is not owned by the Aegis authority PDA.")]
    VaultNotOwnedByAegis,

    #[msg("The escrow vault has been frozen by the issuer.")]
    VaultFrozen,

    #[msg("The escrow vault has a delegate, which could move the backing asset.")]
    VaultHasDelegate,

    #[msg("The escrow vault has been moved to a different transfer group.")]
    VaultGroupChanged,

    #[msg("The supplied transfer rule is not the vault-to-investor redemption rule.")]
    WrongRedeemRule,

    #[msg("The redemption path is closed: no transfer rule permits vault to investor.")]
    RedemptionPathClosed,

    #[msg("The redemption path is time-locked and not yet open.")]
    RedemptionPathLocked,

    // ==========================================
    // FUNDING
    // ==========================================
    #[msg("Only the issuer recorded on this launch may perform this action.")]
    NotLaunchIssuer,

    #[msg("The escrow vault balance does not equal the launch supply after minting.")]
    VaultUnderfunded,

    #[msg("The Real RWA total supply does not equal the launch supply. Tokens exist elsewhere.")]
    SupplyMintedElsewhere,

    #[msg("The investor group must differ from the vault group.")]
    InvalidGroupConfiguration,

    // ==========================================
    // QUOTE TOKEN WHITELIST
    // ==========================================
    #[msg("This quote token has not been approved by the protocol admin.")]
    QuoteTokenNotWhitelisted,

    #[msg("This quote token has been deactivated by the protocol admin.")]
    QuoteTokenInactive,

    #[msg("The quote token is already in that state.")]
    QuoteTokenStatusUnchanged,

    #[msg("Meteora cannot accept this quote mint: it must be legacy SPL, or Token-2022 carrying only metadata extensions.")]
    UnsupportedQuoteMint,

    // ==========================================
    // CURVE CONSTRUCTION
    // ==========================================
    #[msg("The price expansion must be greater than zero; a flat curve cannot be launched.")]
    PriceExpansionTooSmall,

    #[msg("The resulting price exceeds Meteora's maximum representable sqrt price.")]
    PriceExceedsMaxSqrtPrice,

    #[msg("The sale would close above the end of the curve. This should be unreachable.")]
    MigrationPriceAboveCurve,

    #[msg("The curve would sell no tokens at all.")]
    CurveSellsNothing,

    #[msg("The token supply is too small for this raise. Lower the target or widen the price band.")]
    SupplyTooSmallForCurve,

    // ==========================================
    // LAUNCH CONFIGURATION
    // ==========================================
    #[msg("A percentage field exceeded its permitted maximum.")]
    InvalidPercentage,

    #[msg("The migration fee exceeds the protocol ceiling.")]
    MigrationFeeTooHigh,

    #[msg("The migration fee is below the protocol floor. At zero the issuer raises nothing.")]
    MigrationFeeTooLow,

    #[msg("The Meteora DBC program account is not the official program.")]
    InvalidDbcProgram,

    #[msg("The transfer hook program is not the Aegis hook.")]
    InvalidHookProgram,

    #[msg("The quote mint does not match the approved quote token record.")]
    QuoteMintMismatch,

    // ==========================================
    // POOL LAUNCH
    // ==========================================
    #[msg("The supplied Meteora config is not the one recorded on this launch.")]
    WrongMeteoraConfig,

    #[msg("The cRWA mint Meteora produced could not be parsed.")]
    CrwaMintMalformed,

    #[msg("cRWA supply does not equal the escrowed Real RWA. The 1:1 backing would be broken.")]
    CrwaSupplyMismatch,

    #[msg("cRWA decimals do not match the Real RWA. The peg would be off by a power of ten.")]
    CrwaDecimalsMismatch,

    #[msg("cRWA mint authority is not the Aegis PDA. The issuer could print unbacked tokens.")]
    CrwaMintAuthorityMismatch,

    #[msg("cRWA has a freeze authority, which could be used to strand holders.")]
    CrwaFreezeAuthoritySet,

    // ==========================================
    // GRADUATION
    // ==========================================
    #[msg("The issuer is not registered in the investor group and cannot receive the asset back.")]
    IssuerNotRegistered,

    // ==========================================
    // BRIDGE
    // ==========================================
    #[msg("Bridge amount must be greater than zero.")]
    ZeroBridgeAmount,

    #[msg("This wallet is not an approved holder of the security.")]
    HolderNotApproved,

    #[msg("The deposit path is closed: no transfer rule permits investor to vault.")]
    DepositPathClosed,

    #[msg("The deposit path is time-locked and not yet open.")]
    DepositPathLocked,

    #[msg("The vault received nothing from the deposit.")]
    NothingReceived,

    // ==========================================
    // REVENUE AND ABORT
    // ==========================================
    #[msg("Meteora paid a base-token fee despite quote-only collection being configured.")]
    UnexpectedBaseFee,

    #[msg("The launch already has wrapper tokens in circulation and cannot be aborted.")]
    LaunchAlreadyLive,

    // ==========================================
    // CONFIGURATION BOUNDS
    // ==========================================
    #[msg("A fee expressed in basis points is outside its permitted range.")]
    InvalidFeeBps,

    #[msg("The vesting length is outside the range the protocol permits.")]
    InvalidVestingMonths,

    #[msg("The issuer's liquidity split must account for exactly the issuer's share.")]
    InvalidLiquiditySplit,

    #[msg("The issuer locks less liquidity permanently than the protocol requires.")]
    PermanentLockTooLow,

    #[msg("The target raise is below the minimum set for this quote token.")]
    RaiseBelowMinimum,
}
