# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read `design.md` first

`design.md` is the architecture spec for this protocol. It was derived from reading the
pinned Meteora DBC source, not from documentation prose, and it documents seven hard
constraints (C1–C7) that the DBC integration imposes plus sixteen known defects (B1–B16)
in the current code. Several of those constraints invalidate the "obvious" reading of the
product description. **Do not design or fix anything in `programs/aegis` without checking
it against `design.md` §1 and §7 first.**

## Commands

```bash
anchor build                        # builds to target/deploy/aegis.so, IDLs to target/idl/
cargo test                          # Anchor.toml's [scripts] test — litesvm, no validator
cargo test -p aegis <name>          # single test
cargo check -p aegis                # fast type check; use this while iterating
yarn lint / yarn lint:fix           # prettier over TS/JS only
anchor deploy --provider.cluster devnet
```

Tests are Rust `litesvm` tests under `programs/aegis/tests/`, not the usual
`ts-mocha` Anchor suite — `Anchor.toml` overrides `test` to `cargo test`. Tests
`include_bytes!` the built `.so`, so **`anchor build` must run before `cargo test`**.

Toolchain is pinned: rust 1.93.0 (`rust-toolchain.toml`), anchor-cli 1.0.2,
solana-cli 3.1.x. `anchor-lang`/`anchor-spl` are 1.0.2 — APIs differ from the 0.29/0.30
examples most documentation shows.

## Layout

```
programs/aegis/src/
  lib.rs            #[program] mod aegis_orchestrator  (note: lib name is `aegis` — B14)
  instructions/     one file per instruction, each exporting `handler` + an Accounts struct
  state/            #[account] structs
  constants.rs      program IDs, PDA seeds, limits
  errors.rs         AegisError
```

Convention: `lib.rs` holds only doc comments and a one-line delegation to
`instructions::<name>::handler`. All validation and CPI logic lives in the instruction
module. Keep it that way.

## The dependency that matters

`Cargo.toml` pins Meteora DBC by git rev:

```toml
dynamic-bonding-curve = { git = "https://github.com/MeteoraAg/dynamic-bonding-curve", features = ["cpi"] }
```

resolved to `f552f20aa3c1c7631427c3827aeea7c58b902813` in `Cargo.lock`. The checkout is on
disk and is the authoritative reference for every DBC question:

```
~/.cargo/git/checkouts/dynamic-bonding-curve-7f6f273ca8a21cb1/f552f20/programs/dynamic-bonding-curve/src
```

**Read that source rather than guessing or searching the web.** The files that answer most
questions:

| Question | File |
|---|---|
| What `ConfigParameters` fields mean and which combinations are rejected | `instructions/partner/create_config/process_create_config.rs` |
| Who ends up with cRWA mint authority, and when the supply is minted | `instructions/initialize_pool/process_initialize_virtual_pool_with_token2022.rs` |
| When the transfer hook is revoked (it is — permanently, at curve completion) | `instructions/swap/process_swap.rs` → `revoke_transfer_hook` |
| LP position ownership and permanent locking at graduation | `instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs` |
| Enum discriminants (`TokenAuthorityOption`, `MigrationFeeOption`, `CollectFeeMode`, …) | `state/config.rs` |
| Fee-parameter validation rules | `base_fee/fee_scheduler.rs`, `params/fee_parameters.rs` |
| Every numeric limit | `constants.rs` |

Magic `u8` values in `ConfigParameters` are enum discriminants from `state/config.rs`.
Always annotate them with the variant name in a comment, and verify the number against the
enum rather than trusting an existing comment — several comments in the current code are
wrong (see `design.md` §7, B4/B5).

## Architecture in one paragraph

Aegis is an orchestrator, not an AMM. It owns no curve math and no pool state. It sits
between an RWA issuer, Meteora DBC, and Upside's Token-2022 compliance programs, and its
entire job is to (a) constrain the `ConfigParameters` an issuer can hand to DBC so the
launch cannot be predatory, (b) hold the physical asset's token in an escrow that is
registered with Upside as the `lockup_escrow_account` — which is what makes it immune to
the issuer's `force_transfer` / `freeze` / `burn` powers — and (c) run a mint/burn bridge
that keeps the escrow balance exactly equal to the wrapper token's supply. Two tokens:
the **Real RWA** (issuer-minted, Upside-gated, permanently compliance-restricted) and
**cRWA** (created *by DBC*, traded on the curve and then on DAMM v2). The single invariant
the whole protocol rests on is `escrow_vault.amount == crwa_mint.supply`.

## Non-obvious facts that will bite you

These are all verified in the DBC source and explained in `design.md` §1:

- **Aegis does not create the cRWA mint.** DBC creates it inside
  `initialize_virtual_pool_with_token2022_transfer_hook` from a keypair you pass as a
  signer, and sets its own `pool_authority` as mint and hook authority.
- **The entire cRWA supply is minted at pool init**, into the pool's base vault. There is
  no separate "mint the shadow supply" step.
- **The transfer hook on cRWA is permanently revoked when the curve completes** —
  `program_id` *and* `TransferHookProgramId` authority both set to `None`. Any design that
  assumes lasting KYC on cRWA is wrong.
- **`config.fee_claimer` is four roles at once**: partner fee recipient, partner LP
  position owner, partner migration-fee claimant, and (with `token_update_authority = 4`)
  the cRWA mint authority. It must be an Aegis PDA that can sign CPIs, not a wallet.
- **`token_update_authority = 3` gives the issuer unlimited cRWA minting.** Use `4`.
- **`migration_quote_threshold` becomes DEX liquidity, not issuer proceeds.** The issuer's
  capital comes from `MigrationFee` + surplus + trading fees. `migration_fee: Default`
  means the issuer raises nothing.
- `token_decimal` is constrained to `6..=9` by DBC, and must equal the Real RWA's decimals
  or the 1:1 peg is off by orders of magnitude.
- Traders on a transfer-hook pool must call `swap2_with_transfer_hook` with hook accounts
  in `remaining_accounts`, not `swap`/`swap2`.

## Conventions

- Every validation failure gets a named `AegisError` variant with a message an issuer can
  act on. Never bubble a raw DBC error up to a user.
- Never use `unwrap_or` in a security check. Saturating on overflow makes checks fail
  *open* — this is an existing bug (B8). Use `.ok_or(AegisError::MathOverflow)?`.
- `U256` (`ruint`) for curve math; Q64.64 fixed point for all sqrt prices. A price
  multiple `M` is a sqrt multiple `sqrt(M)` — see `design.md` §5.1.
- Store PDA bumps in state and reuse them; don't re-derive in CPI paths.
- Assert the peg invariant at the end of every instruction that moves either token.
- Program IDs and seeds belong in `constants.rs`, never inline in an instruction file.
