//! Curve construction.
//!
//! Aegis builds the bonding curve itself rather than validating one supplied by the issuer.
//!
//! That is a security decision, not a convenience. Every predatory curve needs *shape*: a hidden
//! price spike needs a steep final segment, a liquidity trap needs a thin one, non-monotonic
//! pricing needs segments out of order. Meteora permits up to sixteen segments, so accepting a
//! curve as input means defending against every arrangement of sixteen free variables, and any
//! check we fail to write is a hole.
//!
//! A single segment of constant liquidity has no shape to manipulate. The price rises smoothly
//! from start to finish, monotonic by construction, with no segment that can be starved of
//! liquidity. The attacks are not rejected — they are unrepresentable. That also happens to be
//! the right shape for a real-world asset book-build, where the point is an orderly price band
//! rather than a reflexive pump.
//!
//! The issuer therefore supplies three economic terms — an opening price, how far the price may
//! rise, and how much to raise — and this module derives the rest.
//!
//! All arithmetic mirrors Meteora's own. Sqrt prices are Q64.64 and liquidity is Q64.64, so a
//! quote amount is `L * Δ√P >> 128`, not `>> 64`. Meteora's public helpers are called directly
//! wherever possible so that Aegis and Meteora cannot disagree about the same curve.

use anchor_lang::prelude::*;
use dynamic_bonding_curve::constants::{MAX_SQRT_PRICE, MIN_SQRT_PRICE};
use dynamic_bonding_curve::params::liquidity_distribution::{
    get_base_token_for_swap, get_migration_threshold_price, LiquidityDistributionParameters,
};
use dynamic_bonding_curve::state::PoolConfig;
use ruint::aliases::U256;

use crate::errors::AegisError;
use crate::state::RwaCurveArchetype;

/// Basis-point denominator for the expansion factor.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Fixed-point resolution used by Meteora. A quote amount is `L * Δ√P >> (RESOLUTION * 2)`
/// because both liquidity and sqrt price carry 64 fractional bits.
const RESOLUTION_X2: usize = 128;

impl RwaCurveArchetype {
    /// Maximum permitted expansion of the *sqrt* price, in basis points.
    ///
    /// Expressed against the sqrt price rather than the price so the check needs no square root
    /// on-chain. A sqrt multiple of `m` is a price multiple of `m²`:
    ///
    /// | archetype       | sqrt bps | price multiple |
    /// |-----------------|----------|----------------|
    /// | `FixedPar`      | 10_099   | ~1.02x         |
    /// | `BookBuilding`  | 11_180   | ~1.25x         |
    /// | `GrowthCapital` | 12_247   | ~1.50x         |
    pub const fn max_sqrt_expansion_bps(&self) -> u32 {
        match self {
            // Par-value instruments: the price is meant to barely move.
            RwaCurveArchetype::FixedPar => 10_099,
            // Book-building: a real but bounded discovery range.
            RwaCurveArchetype::BookBuilding => 11_180,
            // Growth capital: the widest band Aegis will underwrite.
            RwaCurveArchetype::GrowthCapital => 12_247,
        }
    }

    /// The price multiple this archetype allows, in basis points. Display only — the on-chain
    /// check uses the sqrt figure above.
    pub const fn max_price_expansion_bps(&self) -> u32 {
        let m = self.max_sqrt_expansion_bps();
        (m * m) / BPS_DENOMINATOR
    }
}

/// A fully determined curve, ready to hand to Meteora.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurvePlan {
    pub sqrt_start_price: u128,
    /// Price at the far end of the segment. Trading stops at or before this point.
    pub sqrt_end_price: u128,
    pub liquidity: u128,
    /// Price at which the raise target is reached, computed by Meteora's own routine. This —
    /// not `sqrt_end_price` — is the price retail actually pays at the close of the sale, so it
    /// is the figure the archetype ceiling is enforced against.
    pub migration_sqrt_price: u128,
    /// Base tokens consumed between the opening price and the migration price.
    pub base_tokens_sold: u64,
    /// Base tokens Meteora requires be available for swapping, including its 25% buffer for
    /// trades that overshoot the threshold.
    pub base_tokens_with_buffer: u64,
}

impl CurvePlan {
    /// The single-segment curve, in the form Meteora's `ConfigParameters` expects.
    pub fn to_meteora_curve(&self) -> Vec<LiquidityDistributionParameters> {
        vec![LiquidityDistributionParameters {
            sqrt_price: self.sqrt_end_price,
            liquidity: self.liquidity,
        }]
    }
}

/// Derives the curve from the issuer's economic terms.
///
/// * `sqrt_start_price` — opening price as Q64.64 sqrt. The frontend converts a human price into
///   this; it is never something an issuer types.
/// * `sqrt_expansion_bps` — how far the sqrt price may travel, in basis points. `10_000` means no
///   movement, which Meteora rejects, so the value must exceed it.
/// * `target_raise` — quote-token atoms to raise. Becomes Meteora's migration threshold.
/// * `total_supply` — the cRWA supply, fixed at `create_rwa` and equal to the escrowed asset.
pub fn plan_curve(
    sqrt_start_price: u128,
    sqrt_expansion_bps: u32,
    target_raise: u64,
    archetype: RwaCurveArchetype,
    total_supply: u64,
) -> Result<CurvePlan> {
    // ------------------------------------------------------------------
    // 1. Opening price must sit inside Meteora's representable range.
    // ------------------------------------------------------------------
    require!(
        sqrt_start_price >= MIN_SQRT_PRICE && sqrt_start_price < MAX_SQRT_PRICE,
        AegisError::InvalidStartPrice
    );
    require!(target_raise > 0, AegisError::InvalidQuoteThreshold);

    // ------------------------------------------------------------------
    // 2. Expansion must be a real rise, and within the archetype's ceiling.
    //
    // This is the price-expansion firewall. Because the curve is a single segment, bounding the
    // endpoint bounds every price anyone can ever pay during the sale — there is no interior
    // shape that could spike above it.
    // ------------------------------------------------------------------
    require!(
        sqrt_expansion_bps > BPS_DENOMINATOR,
        AegisError::PriceExpansionTooSmall
    );
    require!(
        sqrt_expansion_bps <= archetype.max_sqrt_expansion_bps(),
        AegisError::PriceExpansionExceedsRwaLimit
    );

    // ------------------------------------------------------------------
    // 3. End price = start * bps / 10_000, in 256-bit space.
    // ------------------------------------------------------------------
    let sqrt_end_price_256 = U256::from(sqrt_start_price)
        .checked_mul(U256::from(sqrt_expansion_bps))
        .ok_or(AegisError::MathOverflow)?
        .checked_div(U256::from(BPS_DENOMINATOR))
        .ok_or(AegisError::MathOverflow)?;

    let sqrt_end_price: u128 = sqrt_end_price_256
        .try_into()
        .map_err(|_| error!(AegisError::MathOverflow))?;

    require!(
        sqrt_end_price <= MAX_SQRT_PRICE,
        AegisError::PriceExceedsMaxSqrtPrice
    );
    // Integer division could collapse the two prices together for a very small opening price.
    // Meteora requires a strictly rising segment.
    require!(
        sqrt_end_price > sqrt_start_price,
        AegisError::PriceExpansionTooSmall
    );

    let delta_sqrt_price = sqrt_end_price
        .checked_sub(sqrt_start_price)
        .ok_or(AegisError::MathOverflow)?;

    // ------------------------------------------------------------------
    // 4. Liquidity, so that the segment holds exactly the target raise.
    //
    //   quote = L * Δ√P >> 128   =>   L = quote << 128 / Δ√P
    //
    // Rounded *up*, and the direction matters. Rounding down would leave the segment holding
    // marginally less than the target, so the threshold could never be reached and the launch
    // would be stuck mid-curve forever. Rounding up means the curve can hold slightly more, and
    // migration simply triggers a hair below `sqrt_end_price` — safe in the direction that
    // matters, since the ceiling is an upper bound.
    //
    // A consequence worth naming, because a later change here would silently alter protocol
    // revenue: the curve's total quote capacity is pinned to the raise target, give or take the
    // rounding dust above. Meteora books anything a sale takes in *beyond* its threshold as
    // "surplus" and offers a partner claim for it — but with capacity set this way there is
    // structurally nothing to claim, which is why Aegis has no surplus instruction. Widen this
    // segment past the target and that stops being true.
    // ------------------------------------------------------------------
    let numerator = U256::from(target_raise)
        .checked_shl(RESOLUTION_X2)
        .ok_or(AegisError::MathOverflow)?;
    let liquidity_256 = numerator.div_ceil(U256::from(delta_sqrt_price));

    let liquidity: u128 = liquidity_256
        .try_into()
        .map_err(|_| error!(AegisError::MathOverflow))?;
    require!(liquidity > 0, AegisError::ZeroLiquiditySegment);

    let curve = vec![LiquidityDistributionParameters {
        sqrt_price: sqrt_end_price,
        liquidity,
    }];

    // ------------------------------------------------------------------
    // 5. Where the sale actually closes.
    //
    // Computed with Meteora's own routine rather than ours, so the two cannot disagree. This is
    // the price at which the raise target is hit — the price the last buyer pays — and it is
    // what the archetype ceiling ultimately has to hold for.
    // ------------------------------------------------------------------
    let migration_sqrt_price =
        get_migration_threshold_price(target_raise, sqrt_start_price, &curve)?;

    require!(
        migration_sqrt_price < MAX_SQRT_PRICE,
        AegisError::PriceExceedsMaxSqrtPrice
    );
    // Belt and braces. Rounding liquidity up should place this at or below the endpoint; assert
    // it rather than assume it, because everything above rests on the claim.
    require!(
        migration_sqrt_price <= sqrt_end_price,
        AegisError::MigrationPriceAboveCurve
    );
    require!(
        migration_sqrt_price > sqrt_start_price,
        AegisError::InvalidStartPrice
    );

    // ------------------------------------------------------------------
    // 6. Does the fixed supply actually cover the sale?
    //
    // cRWA supply is pinned to the escrowed asset, so it cannot be enlarged to fit the curve.
    // Meteora applies the authoritative check during config creation; running it here first
    // turns an opaque `InvalidTokenSupply` into a message naming the real problem.
    // ------------------------------------------------------------------
    let base_tokens_sold: u64 = get_base_token_for_swap(sqrt_start_price, migration_sqrt_price, &curve)?
        .try_into()
        .map_err(|_| error!(AegisError::MathOverflow))?;
    require!(base_tokens_sold > 0, AegisError::CurveSellsNothing);

    // Meteora lets buyers overshoot the threshold slightly, so it reserves a buffer above the
    // amount the curve strictly needs.
    let base_tokens_with_buffer =
        PoolConfig::get_swap_amount_with_buffer(base_tokens_sold, sqrt_start_price, &curve)?;

    // Strictly less than: the remainder has to cover the tokens seeded into the graduated pool.
    require!(
        base_tokens_with_buffer < total_supply,
        AegisError::SupplyTooSmallForCurve
    );

    Ok(CurvePlan {
        sqrt_start_price,
        sqrt_end_price,
        liquidity,
        migration_sqrt_price,
        base_tokens_sold,
        base_tokens_with_buffer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Price 1.0 in Q64.64 sqrt form.
    const ONE: u128 = 1u128 << 64;

    fn plan(bps: u32, archetype: RwaCurveArchetype) -> Result<CurvePlan> {
        plan_curve(ONE, bps, 1_000_000_000_000, archetype, 10_000_000_000_000)
    }

    #[test]
    fn sqrt_bps_squares_to_the_advertised_price_multiple() {
        // Guards the constants against a well-meaning future edit: these are sqrt multiples, so
        // squaring them must land on 1.02x, 1.25x and 1.50x.
        let cases = [
            (RwaCurveArchetype::FixedPar, 10_200u32),
            (RwaCurveArchetype::BookBuilding, 12_500),
            (RwaCurveArchetype::GrowthCapital, 15_000),
        ];
        for (archetype, expected_price_bps) in cases {
            let actual = archetype.max_price_expansion_bps();
            let diff = actual.abs_diff(expected_price_bps);
            assert!(
                diff <= 2,
                "{archetype:?}: sqrt bps {} squares to {actual}, expected ~{expected_price_bps}",
                archetype.max_sqrt_expansion_bps()
            );
        }
    }

    #[test]
    fn end_price_matches_the_requested_expansion() {
        let p = plan(11_000, RwaCurveArchetype::BookBuilding).unwrap();
        assert_eq!(p.sqrt_end_price, ONE * 11_000 / 10_000);
        assert!(p.sqrt_end_price > p.sqrt_start_price);
    }

    #[test]
    fn the_sale_closes_at_or_below_the_endpoint() {
        // The property the whole firewall depends on: nobody can be charged more than the
        // archetype ceiling, because the sale cannot run past the end of the segment.
        for bps in [10_001, 10_099, 11_000, 11_180] {
            let archetype = if bps <= 10_099 {
                RwaCurveArchetype::FixedPar
            } else {
                RwaCurveArchetype::BookBuilding
            };
            let p = plan(bps, archetype).unwrap();
            assert!(
                p.migration_sqrt_price <= p.sqrt_end_price,
                "bps {bps}: migration {} exceeded endpoint {}",
                p.migration_sqrt_price,
                p.sqrt_end_price
            );
            assert!(p.migration_sqrt_price > p.sqrt_start_price);
        }
    }

    #[test]
    fn rejects_expansion_beyond_the_archetype() {
        assert!(plan(10_100, RwaCurveArchetype::FixedPar).is_err());
        assert!(plan(11_181, RwaCurveArchetype::BookBuilding).is_err());
        assert!(plan(12_248, RwaCurveArchetype::GrowthCapital).is_err());
    }

    #[test]
    fn accepts_expansion_exactly_at_the_archetype_ceiling() {
        assert!(plan(10_099, RwaCurveArchetype::FixedPar).is_ok());
        assert!(plan(11_180, RwaCurveArchetype::BookBuilding).is_ok());
        assert!(plan(12_247, RwaCurveArchetype::GrowthCapital).is_ok());
    }

    #[test]
    fn rejects_a_flat_or_falling_curve() {
        // Meteora requires a strictly rising segment; a flat one would also mean infinite
        // liquidity for any raise.
        assert!(plan(10_000, RwaCurveArchetype::BookBuilding).is_err());
        assert!(plan(9_000, RwaCurveArchetype::BookBuilding).is_err());
    }

    #[test]
    fn rejects_a_start_price_outside_meteoras_range() {
        assert!(plan_curve(
            MIN_SQRT_PRICE - 1,
            11_000,
            1_000_000_000_000,
            RwaCurveArchetype::BookBuilding,
            10_000_000_000_000
        )
        .is_err());
        assert!(plan_curve(
            MAX_SQRT_PRICE,
            11_000,
            1_000_000_000_000,
            RwaCurveArchetype::BookBuilding,
            10_000_000_000_000
        )
        .is_err());
    }

    #[test]
    fn rejects_a_zero_raise() {
        assert!(plan_curve(
            ONE,
            11_000,
            0,
            RwaCurveArchetype::BookBuilding,
            10_000_000_000_000
        )
        .is_err());
    }

    #[test]
    fn rejects_a_supply_too_small_for_the_curve() {
        // The cRWA supply is pinned to the escrowed asset, so an over-ambitious raise has to be
        // refused rather than quietly scaled down.
        let big_raise = 1_000_000_000_000_000u64;
        assert!(plan_curve(
            ONE,
            11_000,
            big_raise,
            RwaCurveArchetype::BookBuilding,
            1_000, // nowhere near enough
        )
        .is_err());
    }

    #[test]
    fn the_curve_holds_at_least_the_target_raise() {
        // Rounding liquidity up must never leave the segment short of the threshold, or the
        // launch could never complete.
        use dynamic_bonding_curve::curve::get_delta_amount_quote_unsigned_256;
        use dynamic_bonding_curve::u128x128_math::Rounding;

        for raise in [1u64, 1_000, 1_000_000_000_000, u32::MAX as u64] {
            let p = plan_curve(
                ONE,
                11_000,
                raise,
                RwaCurveArchetype::BookBuilding,
                u64::MAX,
            )
            .unwrap();
            let capacity = get_delta_amount_quote_unsigned_256(
                p.sqrt_start_price,
                p.sqrt_end_price,
                p.liquidity,
                Rounding::Down,
            )
            .unwrap();
            assert!(
                capacity >= U256::from(raise),
                "raise {raise}: capacity {capacity} below target"
            );
        }
    }

    #[test]
    fn a_larger_raise_needs_more_liquidity_and_sells_more_tokens() {
        let small = plan_curve(ONE, 11_000, 1_000_000_000, RwaCurveArchetype::BookBuilding, u64::MAX).unwrap();
        let large = plan_curve(ONE, 11_000, 2_000_000_000, RwaCurveArchetype::BookBuilding, u64::MAX).unwrap();
        assert!(large.liquidity > small.liquidity);
        assert!(large.base_tokens_sold > small.base_tokens_sold);
        // Same price band either way — raising more does not move the ceiling.
        assert_eq!(large.sqrt_end_price, small.sqrt_end_price);
    }

    #[test]
    fn the_buffer_reserves_more_than_the_curve_strictly_sells() {
        let p = plan(11_000, RwaCurveArchetype::BookBuilding).unwrap();
        assert!(p.base_tokens_with_buffer >= p.base_tokens_sold);
    }

    #[test]
    fn produces_a_single_segment() {
        let p = plan(11_000, RwaCurveArchetype::BookBuilding).unwrap();
        let curve = p.to_meteora_curve();
        // The security property, asserted rather than assumed: one segment, so no interior shape
        // exists for anyone to manipulate.
        assert_eq!(curve.len(), 1);
        assert_eq!(curve[0].sqrt_price, p.sqrt_end_price);
        assert_eq!(curve[0].liquidity, p.liquidity);
    }
}
