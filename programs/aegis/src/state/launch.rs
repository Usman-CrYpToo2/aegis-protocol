use anchor_lang::prelude::*;

/// How far a launch has progressed. Stages only ever move forward, and every instruction
/// asserts the exact stage it is valid in.
///
/// The stages exist because token genesis cannot happen in one shot: Meteora creates the cRWA
/// mint itself, inside its own pool-initialization instruction, so the wrapper token does not
/// exist until `Live`.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum LaunchStage {
    /// `create_rwa` done. Real RWA mint exists, issuer holds all four Upside roles.
    ///
    /// The issuer's compliance setup happens off-chain from here, through Upside. Aegis does not
    /// track it as a stage because the issuer can change it at any time; it is verified at each
    /// gate instead of being recorded once.
    TokenCreated,
    /// `fund_vault` done. The full Real RWA supply is locked in the escrow vault.
    Funded,
    /// `create_rwa_config` done. A validated Meteora config exists for this launch.
    Configured,
    /// `launch_pool` done. cRWA exists and the bonding curve is trading.
    Live,
    /// Migrated to DAMM v2. The bridge is open.
    Graduated,
    /// Abandoned before any wrapper existed, with the asset returned to the issuer. Terminal:
    /// no instruction accepts this stage.
    Aborted,
}

/// Which price-expansion ceiling the curve must respect. See the math firewall.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RwaCurveArchetype {
    /// ~1.02x max price expansion. Par-value instruments.
    FixedPar,
    /// ~1.25x. Book-building style raises.
    BookBuilding,
    /// ~1.50x. Growth capital.
    GrowthCapital,
}

/// Per-launch state, at PDA ["launch", real_rwa_mint].
///
/// Keyed on the Real RWA mint so that "one launch per asset" is structural, and so the
/// backing of a launch can be verified from a single account.
#[account]
#[derive(InitSpace)]
pub struct Launch {
    /// The asset issuer. Holds all four Upside roles and full legal control of the Real RWA.
    pub issuer: Pubkey,

    /// The legal, compliance-restricted token. Created by Upside via `create_rwa`.
    pub real_rwa_mint: Pubkey,

    /// The tradable wrapper. `Pubkey::default()` until `Live` — Meteora creates it at pool init.
    pub crwa_mint: Pubkey,

    /// Meteora DBC config account. Default until `ConfigCreated`.
    pub meteora_config: Pubkey,

    /// Meteora DBC virtual pool. Default until `Live`.
    pub virtual_pool: Pubkey,

    /// Quote token for the raise (USDC). Default until `ConfigCreated`.
    pub quote_mint: Pubkey,

    /// Token-2022 account holding the Real RWA, owned by the launch's `aegis_authority` PDA.
    /// Default until `ComplianceReady`.
    pub escrow_vault: Pubkey,

    /// Total Real RWA to be issued, and the cRWA supply that must back it.
    /// Equals Upside's `max_total_supply`, so there is no headroom to mint into.
    pub total_supply: u64,

    /// Running ledger of Real RWA held in `escrow_vault`.
    pub real_rwa_locked: u64,

    /// Running ledger of cRWA in existence.
    pub crwa_minted: u64,
    /// Real RWA in the vault that belongs to the issuer, not to cRWA holders: the asset behind
    /// the wrapper the curve never sold. Recorded by `finalize_graduation`, paid out by
    /// `claim_unsold`.
    ///
    /// Kept in the vault rather than sent at graduation, so opening the bridge never depends on
    /// the issuer being registered. It is never backing for cRWA: `claim_unsold` pays only what
    /// the vault holds above the cRWA supply, so holders are always covered first.
    pub issuer_unsold: u64,

    /// Upside transfer group the escrow vault sits in. Read from the vault's holder record at
    /// `fund_vault` and pinned from then on, so a later group change is detectable.
    pub vault_group: u64,

    /// Upside transfer group that KYC-approved investors sit in. Declared by the issuer at
    /// `fund_vault`. Redemption is only permitted into this group.
    pub investor_group: u64,

    /// Shared by both mints. Must be 6..=9 (Meteora) and identical on both sides (peg).
    pub decimals: u8,

    pub stage: LaunchStage,

    /// Set at `create_rwa_config`. Placeholder value until then.
    pub archetype: RwaCurveArchetype,

    pub bump: u8,

    /// Bump for ["authority", launch]. Stored so CPI signing does not re-derive it.
    pub authority_bump: u8,
}

impl Launch {
    /// The invariant the whole protocol rests on: **every cRWA in existence is backed by at
    /// least one Real RWA in the vault.**
    ///
    /// Deliberately an inequality, not an equality. Both sides of the ledger can be moved by
    /// people Aegis does not control, and only one direction is dangerous:
    ///
    /// * After graduation the vault also holds the issuer's unclaimed unsold stock
    ///   (`issuer_unsold`) until they collect it.
    /// * Anyone may burn wrapper tokens they own, which lowers supply.
    /// * Any approved holder may send the asset straight into the vault, which raises the
    ///   escrowed balance. Both leave the launch over-collateralised, which harms nobody.
    /// * Only the issuer, through the powers a securities issuer legally retains, can take the
    ///   asset *out* of the vault. That is the case worth stopping.
    ///
    /// An earlier version required exact equality, which meant a single donated token or a
    /// single self-burn permanently halted every deposit and redemption. Treating an unsolicited
    /// inflow as an error hands an attacker a way to cause one — the same lesson as the leftover
    /// collection in `finalize_graduation`.
    ///
    /// Only meaningful from `Live` onward. Between `Funded` and `Live` the vault is full while
    /// no cRWA exists yet, because Meteora does not mint the wrapper until pool creation.
    pub fn assert_backing(&self) -> Result<()> {
        require_gte!(
            self.real_rwa_locked,
            self.crwa_minted,
            crate::errors::AegisError::BackingShortfall
        );
        Ok(())
    }
}
