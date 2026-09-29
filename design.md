# Aegis Protocol — Architecture & Implementation Specification

**Status:** pre-implementation architecture. Derived from source, not from marketing docs.
**Date:** 2026-09-27
**Target:** Meteora DBC bounty (superteam.fun/earn/listing/meteora-dbc)

---

## 0. Sources of truth

Everything in this document was verified against source, not documentation prose.

| Dependency | Version pinned | Where to read it |
|---|---|---|
| Meteora Dynamic Bonding Curve | git `f552f20aa3c1c7631427c3827aeea7c58b902813` | `~/.cargo/git/checkouts/dynamic-bonding-curve-7f6f273ca8a21cb1/f552f20/programs/dynamic-bonding-curve/src` |
| Meteora DAMM v2 (`cp-amm`) | via DBC's `libs/damm-v2` | same checkout, `libs/damm-v2/src` |
| Upside RWA suite | docs only (no source available) | docs.upside.gg/solana-rwa |
| Anchor / Solana | anchor-cli 1.0.2, solana-cli 3.1.14, rust 1.93.0 | `Anchor.toml`, `rust-toolchain.toml` |

**Program IDs (verified):**

```
DBC                        dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
DAMM v2                    cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
DBC protocol fee program   pFee3tb7qh5z53jRF4PbLwmNd148Q8ypLNZbqsMeinA
Upside Access Control      4X79YRjz9KNMhdjdxXg2ZNTS3YnMGYdwJkBHnezMJwr3
Upside Transfer Restr.     6yEnqdEjX3zBBDkzhwTRGJwv1jRaN4QE4gywmgdcfPBZ
Upside Tokenlock           AoodM6rkg968933giHnigMEwp9kiGi68ZEx9bPqk71Gt
Upside Dividends           FUjkkUVKa9Pofs5mBdiYQe2cBVwzrhX8SunAZhGXRkog
Aegis (this program)       FRR7Ff4HW8nPdutTGQmRGoEzkkoqTk57Vy7bfpnMtFy
```

> `programs/aegis/src/instructions/create_rwa_config.rs` currently sets
> `UPSIDE_TRANSFER_HOOK_ID` to the Aegis treasury pubkey. That is a placeholder and
> must become `6yEnqdEjX3zBBDkzhwTRGJwv1jRaN4QE4gywmgdcfPBZ`.

---

## 1. Seven hard constraints the integration imposes

These are not preferences. They are enforced by DBC's on-chain code and they invalidate
parts of the original design brief. **Read this section before writing any instruction.**

### C1 — Aegis does not create the cRWA mint. DBC does.

`InitializeVirtualPoolWithToken2022TransferHookCtx` declares:

```rust
#[account(
    init, signer, payer = payer,
    mint::decimals   = config.load()?.token_decimal,
    mint::authority  = pool_authority,
    extensions::transfer_hook::authority  = pool_authority,
    extensions::transfer_hook::program_id = config.load()?.transfer_hook_program,
)]
pub base_mint: Box<InterfaceAccount<'info, Mint>>,
```

The cRWA mint is created *inside* the DBC instruction, from a fresh keypair, with DBC's
`pool_authority` as mint authority and hook authority. Consequences:

* Aegis cannot pre-create cRWA, cannot choose its extensions, cannot set its own hook.
* The "Step 1: Token Genesis — Aegis initializes both mints" step in the brief is **only
  true for the Real RWA**. cRWA is born at pool-init time, in step 2.
* The hook program on cRWA is whatever `config.transfer_hook_program` says — fixed at
  config-creation time, which is the one lever Aegis controls.

### C2 — The whole cRWA supply is minted at pool init, into the pool vault.

`process_initialize_virtual_pool_with_token2022` ends with a `mint_to` of
`config.get_initial_base_supply()` into `base_vault`. With `token_supply: Some(..)` set
(fixed supply), `get_initial_base_supply()` returns `pre_migration_token_supply` exactly.

So: **cRWA total supply == `pre_migration_token_supply` from block one.** There is no
"Aegis mints the shadow supply and routes it into the curve" step — DBC does it.
Aegis's job is to make sure the Real RWA vault holds the matching amount *before* this
happens, and to reconcile leftovers after.

### C3 — The transfer hook is permanently revoked when the curve completes.

In `process_swap.rs`, on the swap that fills the curve:

```rust
if pool_loader.is_transfer_hook_pool() {
    revoke_transfer_hook(token_base_program, base_mint, pool_authority)?;
}
```

`revoke_transfer_hook` sets the hook `program_id` to `None` **and** sets
`AuthorityType::TransferHookProgramId` to `None`. Irreversible. DAMM v2 cannot host a
mint with a live transfer hook, so DBC strips it.

**This kills "Model 2 = permanent synced KYC on cRWA."** Model 2 gates the *primary
issuance window only*. After graduation, cRWA is a plain, permissionless Token-2022 mint
forever, in both models. Compliance after graduation can only live at the Real RWA layer
and at the Aegis unwrap gate.

Rename the models to say what they actually do:

| Was | Is |
|---|---|
| Model 1 "Permissionless cRWA" | **Open Issuance** — no hook; KYC enforced only at unwrap |
| Model 2 "Synced KYC" | **Gated Issuance** — Upside hook during the curve; KYC at unwrap; hook auto-revoked at graduation |

### C4 — Mint authority on cRWA is assigned by `token_update_authority`, and the only Aegis-controllable option requires a transfer-hook config.

```rust
pub enum TokenAuthorityOption {
    CreatorUpdateAuthority = 0,          // mint authority -> None
    Immutable = 1,                       // mint authority -> None
    PartnerUpdateAuthority = 2,          // mint authority -> None
    CreatorUpdateAndMintAuthority = 3,   // mint authority -> pool.creator
    PartnerUpdateAndMintAuthority = 4,   // mint authority -> config.fee_claimer
}
```
and in `ConfigParameters::validate`:
```rust
require!(is_transfer_hook || !token_authority_option.has_mint_authority(), ...);
```

* **Option 3 is a rug vector.** `creator` is the issuer's wallet. It hands the issuer
  unlimited cRWA minting. The current code uses `3`. **This must change.**
* **Option 4 gives mint authority to `config.fee_claimer`.** That is the only way Aegis
  can ever mint cRWA — which the 2-way ETF bridge requires. Therefore `fee_claimer`
  **must be an Aegis PDA that Aegis can sign for**, not a plain treasury wallet.
* Options 3 and 4 are rejected on a non-transfer-hook config. So **a mintable cRWA
  forces `create_config_with_transfer_hook`**, even for Open Issuance.

**Resolution:** Aegis always uses `create_config_with_transfer_hook`. Open Issuance
passes an Aegis-owned *permissive* hook program (see §4.4); Gated Issuance passes the
Upside Transfer Restrictions program. Both get `token_update_authority = 4` and
`fee_claimer = aegis_mint_authority` PDA. Both end up hook-free after graduation (C3),
which is exactly what we want for Open Issuance anyway.

### C5 — `fee_claimer` is overloaded. It is four things at once.

`config.fee_claimer` is simultaneously:

1. the partner trading-fee recipient (`claim_partner_trading_fee`),
2. the partner **DAMM v2 position NFT owner** after migration (`set_authority_for_position`),
3. the partner migration-fee claimant (`withdraw_migration_fee` with `flag = 0`),
4. with option 4, the **cRWA mint authority**.

A single Aegis PDA has to wear all four hats. It must be able to sign CPIs, own an ATA,
own a Token-2022 NFT account, and be a mint authority. A program PDA can do all of these.
Design it as one PDA per launch: `aegis_authority` (§3).

### C6 — DBC is a liquidity-bootstrapping mechanism, not a capital-raise mechanism.

At graduation, `migration_quote_threshold` worth of USDC goes **into the DAMM v2 pool as
liquidity**, and the brief then permanently locks 100% of that liquidity. Net USDC
delivered to the issuer: approximately **zero**.

An RWA issuer raising capital against a building needs the capital. The three channels
that actually pay out:

| Channel | Instruction | Cap | Notes |
|---|---|---|---|
| **Migration fee** | `withdraw_migration_fee` | `fee_percentage <= 99` | Taken off the migration quote *before* it becomes liquidity. Split by `creator_fee_percentage`. **This is the primary capital channel.** |
| Surplus | `creator_withdraw_surplus` / `partner_withdraw_surplus` | 80% distributable (`PARTNER_AND_CREATOR_SURPLUS_SHARE`) | Only the USDC raised *above* the threshold. |
| Trading fees | `claim_creator_trading_fee` / `claim_partner_trading_fee` | `creator_trading_fee_percentage` | Ongoing, small. |

The current code sets `migration_fee: Default` (= 0). **That means the issuer raises
nothing.** Aegis must expose `migration_fee` as a first-class, validated launch
parameter — it is the whole point of the product.

### C7 — 100% permanent LP lock permanently destroys part of the physical asset's claim.

Permanently locked DAMM v2 liquidity can never be withdrawn — principal, not just fees.
That locked position holds both cRWA and USDC. The cRWA inside it is backed 1:1 by Real
RWA in the Aegis vault that **nobody can ever redeem**. The issuer is not locking
liquidity; they are donating a slice of the building, forever.

DBC's own floor is far lower:
```rust
pub const MIN_LOCKED_LIQUIDITY_BPS: u16 = 1000; // 10% at t+1 day
```

**Recommendation (hybrid lock).** Keep anti-rug guarantees without permanent asset
destruction:

```
partner_permanent_locked_liquidity_percentage = 20   // Aegis, permanent
creator_liquidity_vesting_info                = 80%  // issuer, vested 24 months
creator_permanent_locked_liquidity_percentage = 0
partner_liquidity_percentage                  = 0
creator_liquidity_percentage                  = 0
```
Sum must equal 100 (`sum_liquidity_percentage == 100` is enforced, and
`vesting_percentage` counts toward the sum). `MAX_LOCK_DURATION_IN_SECONDS` is 2 years,
so 24 months is the ceiling. Locked-at-1-day is then 2000 bps ≥ the 1000 bps floor. ✅

The issuer cannot rug on day one (nothing is liquid on day one), the retail buyer gets a
2-year liquidity guarantee, and the asset is not permanently impaired. If the product
decision is still 100% permanent, that is a legitimate choice — but it must be disclosed
to the issuer in those words, and §6 invariant I5 must be relaxed accordingly.

---

## 2. Corrected token model

```
                        ┌──────────────────────────────────┐
   physical asset  ───▶ │  Real RWA  (Token-2022)          │
   (off-chain deed)     │  mint authority : Upside AC PDA  │
                        │  hook           : Upside TR      │  permanent, never revoked
                        │  perm. delegate : Upside AC PDA  │
                        └───────────────┬──────────────────┘
                                        │ locked 1:1
                        ┌───────────────▼──────────────────┐
                        │  Aegis Escrow Vault (ATA)        │
                        │  owner : aegis_authority PDA     │
                        │  registered as Upside            │
                        │  `lockup_escrow_account`         │
                        └───────────────┬──────────────────┘
                                        │ backs
                        ┌───────────────▼──────────────────┐
                        │  cRWA  (Token-2022, made by DBC) │
                        │  mint authority : aegis_authority│  (option 4)
                        │  hook  : until graduation only   │  (C3)
                        └──────────────────────────────────┘
```

**Why the escrow registration matters more than the brief says.** Upside's Real RWA mint
carries a **Permanent Delegate** extension, and the Reserve Admin has
`force_transfer_between`, `burn_securities`, and `freeze_wallet`. An issuer-controlled
Reserve Admin could otherwise seize or freeze the Real RWA sitting in Aegis's vault,
destroying the backing while cRWA keeps trading. Per the Upside docs those three
instructions are **blocked against escrow accounts**:

* `force_transfer_between` — "neither source nor destination can be escrow accounts"
* `burn_securities` — "cannot burn from tokenlock escrow accounts"
* `freeze_wallet` — "cannot freeze the lockup escrow account"

So registering the Aegis vault as `lockup_escrow_account` is not a convenience to dodge
KYC friction. **It is the entire trust-minimization guarantee.** Without it, Aegis is a
custodian with a rug switch it does not control.

**⚠ Blocking dependency (verify on devnet before building anything else):**
`set_lockup_escrow_account` "can only be set once" and there is **one escrow slot per
mint**. Three things must be confirmed against the real program:

1. Does it accept an arbitrary pubkey, or does it validate that the escrow is a
   Tokenlock-derived PDA (`["tokenlock", mint, tokenlock_account]`)? The docs describe
   the latter shape but the instruction signature suggests the former. If it validates,
   **Aegis cannot be the escrow and the whole trust model must be redesigned** (fallback
   in §8).
2. Does the hook's escrow bypass apply to transfers *out of* escrow? The Transfer
   Restrictions page says escrow transfers "skip all validation checks"; the Tokenlock
   page says "transfers from escrow to users remain subject to transfer restrictions."
   These contradict. Aegis's unwrap path depends on the answer.
3. Is the slot already consumed if the issuer previously used Upside Tokenlock for
   employee vesting? If so that mint can never be launched through Aegis.

`instructions/verify_compliance_setup.rs` (§4.3) exists to make all three failures
loud and pre-launch instead of silent and post-launch.

---

## 3. Account architecture

### 3.1 PDAs

| Account | Seeds | Type | Lifetime |
|---|---|---|---|
| `platform_config` | `["platform_config"]` | singleton | forever |
| `curve_preset` | `["curve_preset", name]` | admin-curated | forever |
| `launch` | `["launch", real_rwa_mint]` | per-launch state machine | forever |
| `aegis_authority` | `["authority", launch]` | signer-only PDA, 0 data | forever |
| `escrow_vault` | ATA(`real_rwa_mint`, `aegis_authority`, Token-2022) | escrow | forever |
| `fee_vault` | `["fee_vault"]` | protocol SOL fees | forever |

One PDA per launch (`aegis_authority`) carries all four `fee_claimer` roles from C5 plus
escrow ownership. Keyed on `launch` so a compromised or misconfigured launch cannot touch
another launch's assets.

> Keying `launch` on `real_rwa_mint` (not on the Meteora config) makes the 1:1 invariant
> checkable from a single account, and makes "one launch per asset" structural.

### 3.2 `PlatformConfig`

Keep the existing shape, add what the instructions actually need:

```rust
#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,       // NEW: two-step handover, see §7
    pub fee_recipient: Pubkey,
    pub creation_fee_lamports: u64,
    pub is_paused: bool,
    pub aegis_lp_share_pct: u8,      // NEW: partner LP %, replaces the hardcoded 20
    pub max_migration_fee_pct: u8,   // NEW: ceiling on C6 capital extraction
    pub bump: u8,
}
```

### 3.3 `Launch` — the state machine

The 2-step factory in the brief is really **five** steps, because C1/C2 force token
genesis to happen inside pool init and because the Upside intermission has to be verified,
not trusted.

```rust
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum LaunchStage {
    ConfigCreated,      // create_rwa_config done; Meteora config exists & is validated
    ComplianceVerified, // verify_compliance_setup done; escrow slot confirmed ours
    Funded,             // issuer minted the full Real RWA supply into escrow_vault
    Live,               // launch_rwa_pool done; cRWA exists, curve trading
    Graduated,          // migration done; hook revoked; bridge open
}

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub issuer: Pubkey,
    pub real_rwa_mint: Pubkey,
    pub crwa_mint: Pubkey,            // Pubkey::default() until Live
    pub meteora_config: Pubkey,
    pub virtual_pool: Pubkey,         // default until Live
    pub quote_mint: Pubkey,
    pub escrow_vault: Pubkey,

    pub total_supply: u64,            // == pre_migration_token_supply
    pub real_rwa_locked: u64,         // running balance; the 1:1 ledger
    pub crwa_minted: u64,             // running; bridge + initial supply

    pub archetype: RwaCurveArchetype,
    pub stage: LaunchStage,
    pub kyc_model: KycModel,          // Open | Gated
    pub decimals: u8,
    pub leftover_reconciled: bool,
    pub bump: u8,
    pub authority_bump: u8,
}
```

`real_rwa_locked` and `crwa_minted` are the on-chain proof of the peg. Every instruction
that moves either side updates both, and invariant I1 (§6) is asserted at the end of each.

---

## 4. Instruction specification

Ten instructions. For each: who signs, what it validates, what it CPIs, what it writes.

### 4.0 `initialize_platform`

*Exists. Correct as written.* Two additions:

* set `pending_admin = Pubkey::default()`
* seed `aegis_lp_share_pct = 20`, `max_migration_fee_pct = 80`

### 4.1 `update_platform_config`

*Exists. One security change:* admin transfer must be two-step.
`admin: Some(new)` writes `pending_admin`, and a separate `accept_admin` instruction
signed by `pending_admin` commits it. A single-step handover to a typo'd pubkey bricks the
protocol permanently.

### 4.2 `create_rwa_config`

**Signers:** `issuer`, `meteora_config` (fresh keypair).
**Creates:** `launch` (stage `ConfigCreated`), Meteora `ConfigWithTransferHook` via CPI.

This instruction exists but needs substantial correction. Full corrected parameter set:

```rust
ConfigParameters {
    // ---- fees -------------------------------------------------------------
    pool_fees: PoolFeeParameters {
        base_fee: BaseFeeParameters {
            base_fee_mode:       0,           // FeeSchedulerLinear, flat when others are 0
            cliff_fee_numerator: 10_000_000,  // 1% of FEE_DENOMINATOR (1e9)
            first_factor:        0,           // number_of_period
            second_factor:       0,           // period_frequency
            third_factor:        0,           // reduction_factor
        },
        dynamic_fee: None,
    },
    collect_fee_mode: 0,          // QuoteToken — keeps base fees at 0, protects the peg
    activation_type:  1,          // Timestamp
    token_type:       1,          // Token2022
    token_decimal:    args.decimals,          // MUST be 6..=9, MUST equal Real RWA decimals

    // ---- migration --------------------------------------------------------
    migration_option: 1,          // DammV2 — option 0 is hard-rejected as deprecated
    migration_fee_option: 6,      // Customizable
    migrated_pool_fee: MigratedPoolFee {
        collect_fee_mode: 0,
        dynamic_fee:      0,
        pool_fee_bps:     100,    // MUST be 10..=1000; 0 fails validation
    },
    migrated_pool_base_fee_mode: 0,
    migrated_pool_market_cap_fee_scheduler_params: Default::default(),
    compounding_fee_bps: 0,

    // ---- capital raise (C6) -----------------------------------------------
    migration_fee: MigrationFee {
        fee_percentage:         args.migration_fee_pct,   // <= platform max, <= 99
        creator_fee_percentage: args.issuer_fee_split,    // <= 100
    },

    // ---- liquidity (C7) ---------------------------------------------------
    partner_permanent_locked_liquidity_percentage: platform.aegis_lp_share_pct, // 20
    creator_permanent_locked_liquidity_percentage: 0,
    partner_liquidity_percentage: 0,
    creator_liquidity_percentage: 0,
    partner_liquidity_vesting_info: Default::default(),
    creator_liquidity_vesting_info: LiquidityVestingInfoParams {
        vesting_percentage: 100 - platform.aegis_lp_share_pct,  // 80
        bps_per_period, number_of_periods, frequency, cliff_duration_from_migration_time,
    },
    // sum of the six above MUST == 100

    // ---- supply (C2) ------------------------------------------------------
    token_supply: Some(TokenSupplyParams {
        pre_migration_token_supply:  args.total_supply,
        post_migration_token_supply: args.total_supply,
    }),
    locked_vesting: Default::default(),   // no cRWA vesting — breaks the 1:1 ledger

    // ---- authority (C4) ---------------------------------------------------
    token_update_authority: 4,    // PartnerUpdateAndMintAuthority -> fee_claimer
    creator_trading_fee_percentage: 50,
    pool_creation_fee: 0,         // Aegis charges its own in lamports
    sqrt_start_price: args.start_sqrt_price,
    curve: args.curve,
    padding: [0; 2],
    enable_first_swap_with_min_fee: false,
}
```

**CPI accounts** (`CreateConfigWithTransferHookCtx`):

```
config               = meteora_config          (signer, fresh keypair, pays own rent)
fee_claimer          = aegis_authority PDA     ← C5: not the treasury wallet
leftover_receiver    = aegis_authority PDA     ← so Aegis can burn leftovers (§4.7)
quote_mint           = USDC
transfer_hook_program= Upside TR | Aegis permissive hook   ← must be `executable`
payer                = issuer
event_authority      = PDA(["__event_authority"], DBC_ID)
program              = DBC
```

**Validation Aegis must add before the CPI:**

| # | Check | Error |
|---|---|---|
| V1 | `meteora_dbc_program.key() == METEORA_DBC_PROGRAM_ID` | `InvalidDbcProgram` |
| V2 | `!platform_config.is_paused` | `ProtocolPaused` |
| V3 | transfer `platform_config.creation_fee_lamports` → `fee_recipient` | — |
| V4 | `real_rwa_mint` owner is Token-2022; has TransferHook ext pointing at Upside TR | `MissingTransferHookExtension` |
| V5 | `real_rwa_mint.decimals == args.decimals`, and `6 <= decimals <= 9` | `DecimalMismatch` |
| V6 | `real_rwa_mint` supply == 0 (fresh mint, no pre-distribution) | `MintNotFresh` |
| V7 | `args.migration_fee_pct <= platform_config.max_migration_fee_pct` | `MigrationFeeTooHigh` |
| V8 | curve invariants — §5 | various |
| V9 | `quote_mint` is legacy SPL, or Token-2022 with only Metadata extensions | `UnsupportedQuoteMint` |

> **V1 is a live critical vulnerability in the current code.** `meteora_dbc_program` is an
> `UncheckedAccount` with no address constraint, and `meteora_event_authority` is derived
> *from the passed program key*, so it validates nothing. An attacker passes their own
> program, Aegis CPIs into it with `issuer` as payer, and `aegis_config_state` is written
> as if a real Meteora config existed. Fix: `Program`-typed or `address =` constrained.

> **V9 note:** `is_supported_quote_mint` accepts any legacy-SPL mint outright. A Token-2022
> quote mint is only accepted if its *only* extensions are `MetadataPointer` /
> `TokenMetadata` and its transfer fee is zero; otherwise DBC demands a `TokenBadge`.
> USDC (legacy SPL) passes. Document this so nobody tries a Token-2022 stablecoin.

### 4.3 `verify_compliance_setup` — **new, and non-negotiable**

**Signers:** `issuer` (or permissionless — it only reads).
**Stage:** `ConfigCreated` → `ComplianceVerified`.

The brief's "Intermission" is a trust hole: the issuer goes to the Upside dashboard and
Aegis just hopes they did it right. This instruction closes it by reading Upside's state
directly before any asset is locked.

Deserialize `TransferRestrictionData` at `PDA(["trd", real_rwa_mint], UPSIDE_TR_ID)` and assert:

| Check | Why |
|---|---|
| `security_token_mint == launch.real_rwa_mint` | right registry |
| `lockup_escrow_account == Some(launch.escrow_vault)` | **the whole trust model (§2)** |
| `!paused` | can't fund into a frozen mint |
| `max_holders == 0 \|\| max_holders >= threshold` | holder cap won't strand buyers |

Also read `AccessControl` at `PDA(["ac", real_rwa_mint], UPSIDE_AC_ID)` and assert
`max_supply >= launch.total_supply`, so `mint_securities` in §4.4 cannot fail mid-launch.

Only on success does `stage` advance. Funding and launching both require
`stage >= ComplianceVerified`. Idempotent and re-runnable.

### 4.4 The Aegis permissive hook (Open Issuance)

C4 forces every config to be a transfer-hook config. For Open Issuance we need a hook
that allows everything. Options:

* **(a) Ship a 30-line `aegis_hook` program.** `execute` returns `Ok(())`; one
  `initialize_extra_account_meta_list` writing an empty list. Must not be the DBC, SPL
  Token, or Token-2022 program (explicitly rejected), and must be `executable`.
* (b) Pass Upside TR with a Group-0 → Group-0 `locked_until = 1` rule, so everything is
  allowed in practice. Cheaper to build, but every trade pays for hook accounts and
  depends on Upside state staying permissive.

**Recommend (a).** It is trivially auditable, costs nothing at trade time, and it is
revoked at graduation anyway (C3), so it has a ~days-long lifetime.

> Both paths mean traders during the curve must call **`swap2_with_transfer_hook`**, not
> `swap`/`swap2`, and pass extra hook accounts as `remaining_accounts` described by a
> `TransferHookAccountsInfo { slices: Vec<RemainingAccountsSlice> }` with
> `AccountsType::TransferHookBase` (and `TransferHookBaseReferral` if a referral account
> is used). The frontend/SDK must resolve `ExtraAccountMetaList` at
> `PDA(["extra-account-metas", crwa_mint], hook_program)` and build these slices. This is
> the single most common integration failure — put it in the SDK on day one.

### 4.5 `fund_escrow`

**Signers:** `issuer`.
**Stage:** `ComplianceVerified` → `Funded`.

The issuer mints the full Real RWA supply into `escrow_vault` via Upside's
`mint_securities` (Reserve Admin role required — the issuer holds it, Aegis does not).
Aegis then *verifies*, it does not mint:

```
require!(escrow_vault.mint  == launch.real_rwa_mint);
require!(escrow_vault.owner == aegis_authority);
require!(escrow_vault.amount == launch.total_supply);   // exact, not >=
require!(escrow_vault.delegate.is_none());              // no lingering delegate
launch.real_rwa_locked = escrow_vault.amount;
launch.stage = Funded;
```

`amount == total_supply` exactly: over-funding means unaccounted Real RWA sitting in a
vault whose accounting says otherwise. Two acceptable designs — either require exactness
and make the frontend mint the precise number, or accept `>=` and sweep the excess back
to the issuer in the same instruction. **Prefer exactness**; it keeps I1 trivially true.

> Aegis cannot hold the Reserve Admin role, because Reserve Admin also carries
> `force_transfer_between` over every holder's wallet. Aegis holding it would make Aegis
> the rug risk. The issuer mints; Aegis verifies and locks. That asymmetry is the design.

### 4.6 `launch_rwa_pool`

**Signers:** `issuer`, `crwa_mint` (fresh keypair — C1 requires it as a signer).
**Stage:** `Funded` → `Live`.
**CPI:** `initialize_virtual_pool_with_token2022_transfer_hook`.

```
config                = launch.meteora_config
pool_authority        = DBC const pool_authority PDA
creator               = issuer            (owner of 80% LP position + creator fees)
base_mint             = crwa_mint         (init'd by DBC — fresh keypair signer)
quote_mint            = USDC
pool                  = PDA(["pool", config, max(base,quote), min(base,quote)], DBC)
base_vault            = PDA(["token_vault", base_mint, pool], DBC)
quote_vault           = PDA(["token_vault", quote_mint, pool], DBC)
transfer_hook_program = must equal config.transfer_hook_program
payer                 = issuer
```
with `InitializePoolParameters { name, symbol, uri }`.

**Aegis pre-checks:** stage is `Funded`; `!is_paused`; `escrow_vault.amount` still equals
`launch.total_supply` (re-read — it could have moved between §4.5 and now).

**Aegis post-checks (the 1:1 assertion):**
```
crwa_mint.supply       == launch.total_supply     // == pre_migration_token_supply, C2
crwa_mint.mint_authority == Some(aegis_authority) // C4 option 4 landed correctly
escrow_vault.amount    == crwa_mint.supply        // I1
```
Then write `crwa_mint`, `virtual_pool`, `crwa_minted = total_supply`, `stage = Live`.

Asserting `mint_authority == aegis_authority` here is what makes the ETF bridge possible
later. If DBC's semantics ever change, this instruction fails loudly instead of shipping
an unbackable token.

### 4.7 `reconcile_leftover`

**Signers:** permissionless (crank).
**Stage:** `Graduated`. Runs once.

After migration, DBC's `withdraw_leftover` transfers unsold cRWA to
`config.leftover_receiver`'s ATA — **a transfer, not a burn**, and only valid while
`migration_progress == CreatedPool` and `is_fixed_token_supply()`. Since
`leftover_receiver = aegis_authority`, the unsold cRWA lands with Aegis.

Leaving it there breaks nothing numerically but leaves Aegis holding tradeable cRWA — an
unacceptable optic and a real risk. So:

1. CPI `withdraw_leftover` into `aegis_authority`'s cRWA ATA.
2. `burn` that entire balance (`aegis_authority` signs — you can always burn your own).
3. Transfer the same amount of Real RWA from `escrow_vault` to the issuer. This is the
   unsold allocation going home.
4. `launch.crwa_minted -= n; launch.real_rwa_locked -= n;` assert I1.
5. `leftover_reconciled = true`.

Step 3 is the one that depends on the escrow-bypass direction question in §2 item 2. If
transfers *out of* escrow are restricted, the issuer's receiving wallet needs a
Security Associated Account and a valid transfer rule — surfaceable at §4.3 time.

### 4.8 `bridge_deposit` — Real RWA → cRWA

**Signers:** `user`. **Stage:** `Graduated`.

```
1. transfer_checked  amount  user_real_ata -> escrow_vault        (Token-2022, hook runs)
2. mint_to           amount  crwa_mint -> user_crwa_ata           (aegis_authority signs)
3. launch.real_rwa_locked += amount;  launch.crwa_minted += amount;  assert I1
```

No KYC gate needed on this direction: to hold Real RWA at all the user already passed
Upside's hook. Step 1's hook enforces it for free. Aegis adds nothing.

Step 1's `transfer_checked` needs the Upside hook's extra accounts in
`remaining_accounts` — same `ExtraAccountMetaList` resolution as §4.4, but for
`real_rwa_mint`. Note that the *destination* is the escrow, so the escrow bypass applies.

### 4.9 `bridge_redeem` — cRWA → Real RWA

**Signers:** `user`. **Stage:** `Graduated`. **This is the KYC gate.**

```
1. burn              amount  user_crwa_ata                        (user signs)
2. verify KYC: read SAA at PDA(["saa", user_real_ata], UPSIDE_TR_ID)
   - must exist, must be owned by Upside TR
   - read TransferRule PDA(["tr", trd, from_group, to_group]) ; require locked_until != 0
     and now >= locked_until
3. transfer_checked  amount  escrow_vault -> user_real_ata        (aegis_authority signs)
4. launch.real_rwa_locked -= amount;  launch.crwa_minted -= amount;  assert I1
```

Step 2 is belt-and-braces: if the escrow bypass turns out to skip validation in the
out-direction (§2 item 2), Aegis's own SAA check is the *only* thing standing between an
un-KYC'd wallet and a security token. **Do not rely on the hook here.** Read Upside's
state explicitly and reject before transferring.

Burn before transfer, always — a failed transfer then reverts the burn atomically, while
transfer-before-burn opens a reentrancy shape if the hook ever CPIs back.

### 4.10 `claim_*` passthroughs

`aegis_authority` is `fee_claimer`, so only Aegis can sign for the partner side. Four thin
wrappers, each splitting proceeds per `platform_config`:

| Aegis ix | CPI | Sends to |
|---|---|---|
| `claim_partner_trading_fee` | `claim_partner_trading_fee2` | `platform_config.fee_recipient` |
| `claim_partner_migration_fee` | `withdraw_migration_fee(flag=0)` | `fee_recipient` |
| `transfer_lp_position` | — | hands the partner position NFT to a locked Aegis account |

The creator-side equivalents need no Aegis wrapper: `virtual_pool.creator` is the issuer's
own wallet and they call DBC directly. That is deliberate — Aegis should not be able to
intercept issuer proceeds.

---

## 5. The math firewall — corrected

The existing `validate_rwa_curve_invariants` is directionally right and has two real
soundness holes plus one conceptual error.

### 5.1 The archetype multipliers are correct — document them

Prices are Q64 **sqrt** prices, so a price multiple *M* corresponds to a sqrt multiple
`sqrt(M)`:

| Archetype | Q64 constant | ÷2⁶⁴ | Price cap |
|---|---|---|---|
| `FixedPar` | 18_630_282_431_666_497_121 | 1.009950 | **1.02×** |
| `BookBuilding` | 20_624_021_201_529_126_488 | 1.118034 | **1.25×** |
| `GrowthCapital` | 22_593_293_654_642_392_307 | 1.224745 | **1.50×** |

These match `sqrt(1.02)`, `sqrt(1.25)`, `sqrt(1.5)` to 6+ digits. Add a `#[test]` that
asserts `(k/2^64)^2 ≈ cap` so nobody "fixes" them later.

### 5.2 Hole 1 — `unwrap_or` makes both firewalls fail *open*

```rust
let total_quote_capacity: u64 = total_quote_capacity_u256.try_into().unwrap_or(u64::MAX);
let max_allowed_final_sqrt_price: u128 = max_allowed_final_u256.try_into().unwrap_or(u128::MAX);
```

Both saturate on overflow, and both saturate in the direction that makes the subsequent
`require!` pass. A curve crafted to overflow either conversion bypasses the check it was
supposed to fail. Replace both with `.map_err(|_| AegisError::MathOverflow)?`. A security
check that degrades to "allow" on unexpected input is not a check.

### 5.3 Conceptual error — cap the *migration* price, not the last curve point

The current code bounds `curve.last().sqrt_price`. That is the wrong quantity in both
directions:

* **False negative:** an issuer can place a huge final segment that trading never reaches
  (because trading stops near `migration_quote_threshold`), and get rejected for a price
  that will never print.
* **False positive:** more importantly, the economically meaningful graduation price is
  the price at which the threshold is hit — and that is what retail actually pays.

DBC computes it as `get_migration_threshold_price(migration_quote_threshold, sqrt_start_price, &curve)`
(`params/liquidity_distribution.rs`). Aegis should compute the same value and bound
**that**:

```rust
let migration_sqrt_price = get_migration_threshold_price(
    args.migration_quote_threshold, args.start_sqrt_price, &args.curve,
)?;
let max_allowed = mul_shr_64(start_sqrt_price, archetype.max_sqrt_multiplier_q64())?;
require!(migration_sqrt_price <= max_allowed, AegisError::PriceExpansionExceedsRwaLimit);
require!(migration_sqrt_price <  MAX_SQRT_PRICE, AegisError::InvalidCurve);
```

Reuse DBC's own function rather than reimplementing it — divergence between Aegis's model
of the curve and DBC's actual behaviour is the single most likely source of a launch that
validates and then misprices.

### 5.4 Add: per-segment jump cap (the actual "hidden spike" defence)

Monotonicity alone permits `[1.001×, 1.002×, …, 1.48×]` — a flat curve with a cliff at the
end. Bound each step:

```rust
// each segment may not raise sqrt price by more than MAX_SEGMENT_STEP_BPS
for each (prev, cur) in segments {
    let step_bps = (cur.sqrt_price - prev) * 10_000 / prev;      // U256
    require!(step_bps <= MAX_SEGMENT_STEP_BPS, AegisError::PriceSpikeDetected);
}
```
Suggested: 500 bps (5% in sqrt ≈ 10.25% in price) per segment. With ≤16 segments and a
1.25× total cap, this forces a genuinely smooth book.

### 5.5 Keep, but understand, the capacity check

`Σ L·Δ√P >> 64 >= migration_quote_threshold` is the right formula for quote-token capacity
on a concentrated range, and it is a useful early error. It is however strictly weaker
than DBC's own `migration_sqrt_price < MAX_SQRT_PRICE`. Keep it for the better error
message; don't treat it as the load-bearing check.

### 5.6 Add: minimum liquidity depth

`ZeroLiquiditySegment` only rejects exactly zero. `liquidity = 1` is a de-facto
zero-liquidity trap. Require each segment to carry at least a policy floor as a fraction
of the total — e.g. no segment below `total_liquidity / (4 * segment_count)`.

---

## 6. Invariants

Assert these in code, not in prose. I1 goes in a shared `fn assert_peg(launch)` called at
the end of every instruction that moves either side.

| # | Invariant | Where enforced |
|---|---|---|
| **I1** | `escrow_vault.amount == crwa_mint.supply` | §4.5–4.9, every mutation |
| **I2** | `launch.real_rwa_locked == escrow_vault.amount` and `launch.crwa_minted == crwa_mint.supply` (bookkeeping matches reality) | same |
| **I3** | `crwa_mint.mint_authority == Some(aegis_authority)` for the life of the launch | §4.6 post-check, §4.8 pre-check |
| **I4** | `real_rwa_mint`'s `lockup_escrow_account == escrow_vault` | §4.3, re-checked in §4.5 |
| **I5** | LP locked-at-1-day ≥ platform floor (≥ 1000 bps by DBC; Aegis sets higher) | §4.2 validation |
| **I6** | `stage` only ever advances; no instruction is valid in two stages | every handler |
| **I7** | One `launch` per `real_rwa_mint` | PDA seeds |
| **I8** | `escrow_vault.delegate.is_none()` | §4.5, §4.9 |

I8 deserves a note: the Real RWA mint has a **Permanent Delegate** (Upside Access
Control). That is a mint-level extension Aegis cannot remove; escrow registration is what
neutralises it (§2). I8 catches the separate, ordinary account-level delegate.

---

## 7. Bugs in the current code

Verified against the pinned DBC source. Ordered by severity.

### Critical

**B1 — Unvalidated DBC program (`create_rwa_config.rs`).** `meteora_dbc_program:
UncheckedAccount` with no address constraint; `meteora_event_authority` is derived from
the supplied key, so it self-validates. Arbitrary-program CPI with the issuer as payer.
→ `#[account(address = METEORA_DBC_PROGRAM_ID)]`, or better `Program<'info, DynamicBondingCurve>`.

**B2 — `token_update_authority: 3` hands cRWA mint authority to the issuer.** C4. Option
3 is `CreatorUpdateAndMintAuthority`; `creator` is the issuer's wallet. Unlimited cRWA
minting by the party the protocol is supposed to constrain — the exact rug the product
claims to prevent. → option `4` with `fee_claimer = aegis_authority`.

**B3 — `UPSIDE_TRANSFER_HOOK_ID == AEGIS_TREASURY_PUBKEY`.** Both are
`E4NxfZMC35oWmRzZphcikRP6xN5aADZFoxyYHoMT5Nux`. The "anti-fake-hook verification" in the
Gated path therefore checks that the hook program equals the treasury wallet — which is
not executable, so DBC's `#[account(executable)]` rejects it and Gated Issuance cannot
work at all. → `6yEnqdEjX3zBBDkzhwTRGJwv1jRaN4QE4gywmgdcfPBZ`.

### Will not build / will not execute

**B4 — The fee parameters fail DBC validation.** Current:
`base_fee_mode: 0, first_factor: 100, cliff_fee_numerator: 0, second_factor: 0, third_factor: 0`.
The comment says "100 bps (1%) in Meteora's updated flat mode"; `first_factor` is
`number_of_period`, not bps. `FeeScheduler::validate` requires that if any of
`{number_of_period, period_frequency, reduction_factor}` is non-zero then **all** are →
`InvalidFeeScheduler`. And `cliff_fee_numerator: 0` fails
`min_fee_numerator >= MIN_FEE_NUMERATOR (2_500_000)` → `ExceedMaxFeeBps`.
→ `cliff_fee_numerator: 10_000_000, first_factor: 0`.

**B5 — `migration_fee_option: 6` with `migrated_pool_fee: Default`.** Option 6 is
`Customizable`, which runs `MigratedPoolFeeValidator::validate()`, which requires
`pool_fee_bps` in `10..=1000`. Default is 0 → `InvalidMigratedPoolFee`. → set
`pool_fee_bps: 100`, or use a `FixedBps*` option and leave `migrated_pool_fee` zeroed.

**B6 — Liquidity percentages sum to 100 but nothing is checked.** `20 + 80 = 100` happens
to pass today, but the check lives in DBC and the numbers are hardcoded in Aegis. Move
them to `platform_config` and assert the sum in Aegis so a config change cannot produce a
CPI that fails 300 lines deeper with `InvalidFeePercentage`.

### Logic / policy

**B7 — `PlatformConfig` is not enforced in `create_rwa_config`.** `is_paused` is never
read, `creation_fee_lamports` is never charged, `fee_recipient` is bypassed in favour of a
hardcoded `AEGIS_TREASURY_PUBKEY`. The pause switch and the revenue model are both
decorative. → include `platform_config` in the context, check V2, charge V3.

**B8 — `unwrap_or` fails the math firewall open.** §5.2.

**B9 — Price cap applied to the wrong price.** §5.3.

**B10 — `migration_fee: Default` means the issuer raises no capital.** C6.

**B11 — `leftover_receiver = AEGIS_TREASURY_PUBKEY` (a wallet).** Leftover cRWA lands in a
wallet Aegis cannot burn from programmatically, and its Real RWA backing stays locked
forever. → `aegis_authority` PDA + §4.7.

**B12 — No decimal equality check between Real RWA and cRWA.** `token_decimal` is taken
from args and independently constrained to `6..=9` by DBC. A 6-decimal Real RWA with a
9-decimal cRWA makes "1:1" off by 1000×. → V5.

### Hygiene

**B13 — `AegisConfigState::INIT_SPACE` is hand-computed** (108 bytes). Use
`#[derive(InitSpace)]`, and derive `InitSpace` on `RwaCurveArchetype`.

**B14 — `#[program] pub mod aegis_orchestrator` vs `[lib] name = "aegis"`** produces two
IDLs (`target/idl/aegis.json`, `target/idl/aegis_orchestrator.json`) and confuses every
client generator. Pick one name.

**B15 — `curve.len() >= 2`** is stricter than DBC (`> 0`). Fine as policy; say so in a
comment so it doesn't read as a transcription error.

**B16 — `tests/test_initialize.rs` is entirely commented out** and references an
`Initialize` instruction that does not exist.

---

## 8. If the escrow registration is not available

The §2 blocking dependency is the single point of failure for the whole trust model. If
`set_lockup_escrow_account` turns out to validate that the escrow is a Tokenlock PDA — so
an Aegis PDA cannot be registered — then the Real RWA in Aegis's vault is force-transferable
and freezable by the issuer's Reserve Admin, and "trust-minimized" is not an honest claim.

Fallbacks, in order of preference:

1. **Route through Upside Tokenlock.** Create a real tokenlock account whose escrow PDA is
   the registered escrow, and have Aegis hold the release authority. Adds a program
   dependency; preserves the immunity properties.
2. **Require Reserve Admin to be a 2-of-3 multisig** including an Aegis key, verified at
   §4.3. Downgrades from "mathematically prevented" to "contractually constrained," which
   must be stated plainly in the UI.
3. **Ship Open Issuance only, with disclosure.** Aegis is a wrapper with a documented
   issuer-seizure risk. Honest, and still useful, but it is a different product.

Decide this before writing §4.5 onward. Everything downstream assumes option 0 (Aegis
vault is the escrow).

---

## 9. Build order

Each milestone is independently testable. Do not start a milestone before its predecessor
has tests passing.

| # | Milestone | Contents | Exit criterion |
|---|---|---|---|
| **M0** | **Devnet spike** | Resolve all three §2 questions against live Upside programs on devnet. No Aegis code. | Written answers, escrow registration reproduced end-to-end |
| M1 | Platform | `initialize_platform`, `update_platform_config` + `accept_admin`, new `PlatformConfig` fields | litesvm tests incl. unauthorized-admin and handover |
| M2 | Math firewall | §5 rewrite as a pure, dependency-free module | property tests: monotonicity, spike cap, overflow, the three archetype caps |
| M3 | `aegis_hook` | permissive hook program (§4.4) | Token-2022 `transfer_checked` succeeds through it |
| M4 | `create_rwa_config` | corrected params (§4.2), V1–V9 | CPI lands against real DBC on localnet with DBC's .so loaded |
| M5 | `verify_compliance_setup` | §4.3 | passes on a correct Upside mint, fails on each of the four defects |
| M6 | `fund_escrow` + `launch_rwa_pool` | §4.5, §4.6, I1–I3 | cRWA exists, supply == escrow balance, mint authority == `aegis_authority` |
| M7 | Curve → graduation | drive swaps to threshold, migrate to DAMM v2 | hook revoked (assert!), LP positions owned + locked as configured |
| M8 | `reconcile_leftover` | §4.7 | leftover burned, Real RWA returned, I1 holds |
| M9 | ETF bridge | §4.8, §4.9 | I1 holds across randomized deposit/redeem sequences; un-KYC'd redeem rejected |
| M10 | Fee claims | §4.10 | each of the four proceeds paths reaches the right wallet |

M0 first. It is the only milestone that can invalidate the architecture.

---

## 10. Test strategy

**Harness.** `litesvm` (already a dev-dependency) with real program binaries loaded:
`dbcij3…` and `cpamdp…` dumped from mainnet, plus the three Upside programs. `svm.add_program`
each. Anchor's `test = "cargo test"` runs them; no validator needed, so they're fast
enough to run on every save.

```bash
# dump the dependencies once, commit to tests/fixtures/
solana program dump -u m dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN tests/fixtures/dbc.so
solana program dump -u m cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG  tests/fixtures/damm_v2.so
solana program dump -u m 6yEnqdEjX3zBBDkzhwTRGJwv1jRaN4QE4gywmgdcfPBZ tests/fixtures/upside_tr.so
solana program dump -u m 4X79YRjz9KNMhdjdxXg2ZNTS3YnMGYdwJkBHnezMJwr3 tests/fixtures/upside_ac.so
```

**Unit — the math firewall (M2).** Pure functions, no SVM. Property-based (`proptest`):
monotonic curves always pass the monotonicity check; any non-monotonic one always fails;
the price cap binds exactly at the archetype boundary; no input causes a panic or an
overflow-to-allow.

**Integration — the peg (M9).** The one test that matters most: a randomized sequence of
`bridge_deposit` / `bridge_redeem` / curve swaps, asserting I1 and I2 after *every* step.
If that test is green over 10k randomized sequences, the core claim of the protocol holds.

**Negative tests are the deliverable.** For a protocol whose value proposition is "you
cannot rug," the passing tests are less interesting than the reverted ones. At minimum:

* issuer tries to mint cRWA directly → fails (I3)
* issuer tries to withdraw LP before vest → fails
* issuer tries `force_transfer_between` out of the escrow → fails (§2)
* issuer tries `freeze_wallet` on the escrow → fails
* un-KYC'd wallet redeems cRWA → fails (§4.9 step 2)
* `launch_rwa_pool` on an under-funded escrow → fails
* a curve with a terminal price spike → fails (§5.4)
* a fake DBC program passed to `create_rwa_config` → fails (V1)

Each of those maps to a claim in the pitch. A claim without a red test behind it is
marketing.

---

## 11. Open questions

| # | Question | Blocks | Owner |
|---|---|---|---|
| Q1 | Does `set_lockup_escrow_account` accept an arbitrary pubkey, or validate a Tokenlock PDA? | everything (§8) | M0 |
| Q2 | Does the escrow bypass apply to transfers *out of* escrow? Docs contradict. | §4.7, §4.9 | M0 |
| Q3 | Is the escrow slot already consumed on a mint that used Tokenlock for vesting? | issuer eligibility | M0 |
| Q4 | Does `mint_securities` to an escrow destination need an SAA? (docs imply not) | §4.5 | M0 |
| Q5 | Which DAMM v2 dynamic config account satisfies `pool_creator_authority == DBC pool_authority` for `migration_fee_option = 6`? Must be supplied in `remaining_accounts[0]` at migration. | M7 | Meteora |
| Q6 | Migration is permissionless — who cranks `migration_damm_v2` in production, and who pays the `FLASH_RENT_FUND` (1 SOL)? | M7 | Aegis ops |
| Q7 | 100% permanent LP lock vs. hybrid vest (C7)? Product decision with a real economic cost either way. | §4.2 | Product |
| Q8 | `migration_fee_pct` default and ceiling — what fraction of the raise should reach the issuer? | §4.2 | Product |

---

## Appendix A — Launch sequence

```
issuer                     Aegis                      DBC                    Upside
  │                          │                          │                       │
  │─ create Real RWA ───────────────────────────────────────────────────────────▶│  initialize_access_control
  │                          │                          │                       │  + transfer restrictions
  │─ create_rwa_config ─────▶│                          │                       │
  │                          │─ create_config_with_transfer_hook ──────────────▶│
  │                          │   fee_claimer = aegis_authority                  │
  │                          │   leftover_receiver = aegis_authority            │
  │                          │   token_update_authority = 4                     │
  │                          │   [stage: ConfigCreated]                         │
  │                          │                          │                       │
  │─ set_lockup_escrow_account(escrow_vault) ──────────────────────────────────▶│  ← THE trust step
  │─ initialize transfer groups + rules ───────────────────────────────────────▶│
  │                          │                          │                       │
  │─ verify_compliance_setup ▶│── read TransferRestrictionData ────────────────▶│
  │                          │   assert lockup_escrow_account == escrow_vault    │
  │                          │   [stage: ComplianceVerified]                     │
  │                          │                          │                       │
  │─ mint_securities(total_supply → escrow_vault) ─────────────────────────────▶│
  │─ fund_escrow ───────────▶│  assert escrow == total_supply                    │
  │                          │   [stage: Funded]                                 │
  │                          │                          │                       │
  │─ launch_rwa_pool ───────▶│─ initialize_virtual_pool_with_token2022_transfer_hook ▶
  │   (crwa_mint keypair)    │   DBC creates cRWA, mints ALL of it to base_vault │
  │                          │   assert supply == escrow, mint_auth == aegis     │
  │                          │   [stage: Live]                                   │
  ├──────────────────── traders: swap2_with_transfer_hook ───────────────────────▶
  │                          │                          │                       │
  │                     curve completes ──▶ DBC REVOKES THE HOOK (permanent, C3) │
  │                          │                          │                       │
  ├─ (crank) migration_damm_v2 ─────────────────────────▶│  LP: 20% perm-locked → aegis_authority
  │                          │                          │   80% vested → issuer  │
  │                          │   [stage: Graduated]      │                       │
  │                          │                          │                       │
  │─ (crank) reconcile_leftover ▶ withdraw_leftover → burn cRWA → return Real RWA │
  │─ withdraw_migration_fee(flag=1) ────────────────────▶│  ← issuer's capital (C6)
  │                          │                          │                       │
  └── forever: bridge_deposit / bridge_redeem keeps the peg ─────────────────────┘
```

## Appendix B — DBC constants worth memorising

```
MIN_SQRT_PRICE                4295048016
MAX_SQRT_PRICE                79226673521066979257578248091
MAX_CURVE_POINT               16
FEE_DENOMINATOR               1_000_000_000
MIN_FEE_BPS / NUMERATOR       25 / 2_500_000          ← B4
MAX_FEE_BPS / NUMERATOR       9900 / 990_000_000
MIN/MAX_MIGRATED_POOL_FEE_BPS 10 / 1000               ← B5
MIN_LOCKED_LIQUIDITY_BPS      1000  (at t+1 day)      ← C7
MAX_LOCK_DURATION_IN_SECONDS  63_072_000  (2 years)   ← C7
MAX_MIGRATION_FEE_PERCENTAGE  99                      ← C6
SWAP_BUFFER_PERCENTAGE        25
PARTNER_AND_CREATOR_SURPLUS_SHARE  80
PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS  20  (0.2%)
token_decimal range           6..=9                   ← B12
FLASH_RENT_FUND               1 SOL                   ← Q6
```

Seeds (DBC): `config` is a plain keypair, not a PDA. `pool` =
`["pool", config, max(base,quote), min(base,quote)]`. `token_vault` =
`["token_vault", mint, pool]`. `event_authority` = `["__event_authority"]`.

Seeds (Upside TR): `trd` = `["trd", mint]`, `saa` = `["saa", ata]`,
`tr` = `["tr", trd, from_id_le, to_id_le]`, `trg` = `["trg", trd, group_id_le]`.
Seeds (Upside AC): `ac` = `["ac", mint]`, `wallet_role` = `["wallet_role", mint, wallet]`.
Token-2022 hook extra accounts: `["extra-account-metas", mint]` under the hook program.
