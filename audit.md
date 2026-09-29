# Aegis Protocol — Security Review

**Date:** 2026-09-28
**Scope:** `programs/aegis` (11 instructions), `programs/aegis-hook` (2 instructions)
**Method:** adversarial source review, plus exploit tests executed against the real Meteora DBC,
Meteora DAMM v2 and Upside binaries dumped from mainnet.
**Result:** 3 vulnerabilities found and fixed, 5 lower-severity findings, 2 accepted risks.

Every fix has a regression test that performs the original attack. Suite: 142 integration tests,
13 unit tests.

---

## Summary

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Critical** | Exact-equality backing check let anyone permanently disable the bridge — two independent exploit paths | Fixed |
| 2 | Low | Hook companion account was front-runnable, blocking launches | Fixed |
| 3 | Low | `update_platform_config` reached the config without a seeds check | Fixed |
| 4 | Informational | No events emitted anywhere | Fixed |
| 5 | Informational | `initialize_platform` is first-caller-wins | Open, deployment procedure |
| 6 | Informational | `migration_fee_pct` could be zero, so the issuer raised nothing | Fixed |
| 7 | Informational | `fee_recipient` was unvalidated and could be made unpayable | Fixed |
| 8 | Informational | `QuoteToken::is_legacy_spl` is recorded but never read | Resolved as documentation |
| 9 | Informational | A share of a zero migration fee produced an opaque Meteora error | Fixed |
| 10 | **High** | Aegis could not claim any of the revenue it accrues | Fixed |
| 11 | Medium | Admin transfer is single-step; a typo loses the protocol permanently | Open, acknowledged |
| 12 | Medium | No abort path: a launch abandoned after funding locked the asset forever | Fixed |
| 13 | Medium | The issuer can close the vault's holder record, halting the bridge | Open, acknowledged under A |
| A | Accepted | The issuer retains seizure, freeze and dilution powers over the asset | By design, detected |
| B | Accepted | Program upgrade authority is a trust assumption | Deployment procedure |

---

## 1. Critical — an exact-equality invariant let anyone brick the bridge permanently

**Location:** `state/launch.rs::assert_peg`, `instructions/bridge.rs::settle`,
`instructions/finalize_graduation.rs`, `instructions/launch_pool.rs`, `instructions/fund_vault.rs`

### What was wrong

Aegis kept a ledger (`real_rwa_locked`, `crwa_minted`) and asserted it *equalled* on-chain state
after every bridge operation:

```rust
require_eq!(launch.real_rwa_locked, escrow_vault.amount, ...);
require_eq!(launch.crwa_minted,     crwa_mint.supply,   ...);
```

Both of those quantities can be changed by people Aegis does not control. Once either moved by a
single unit, the assertion was false and stayed false. Every `bridge_deposit` and `bridge_redeem`
reverted from then on, for everybody, permanently. Holders could never unwrap, and the asset
behind their tokens became unreachable.

### Two independent ways to trigger it

**Path A — donate the asset into the escrow vault.** The `investor -> vault` transfer rule has to
exist for deposits to work, which means any approved holder can also send the asset directly into
the vault without involving Aegis at all. Verified:

```
DONATION ACCEPTED: true
VAULT 13222140495 -> 13222140496
BRIDGE AFTER DONATION: BROKEN — VaultUnderfunded
```

One millionth of a token. Cost: one transaction.

**Path B — burn your own wrapper.** Anyone may burn tokens they own. No hook, no permission, no
Aegis involvement, one instruction. Verified:

```
SELF-BURN ACCEPTED: true
BRIDGE AFTER SELF-BURN: BROKEN — CrwaSupplyMismatch
```

Any holder of a single cRWA could permanently strand every other holder.

### Why it was wrong

Exact equality was the wrong invariant. The safety property is **backing**: every wrapper token
in circulation must be covered by at least one unit of the asset in the vault. Over-collateralisation
harms nobody; only a *shortfall* matters.

The deeper mistake is one already identified elsewhere in this codebase, applied inconsistently:
**treating an unsolicited inflow as an error hands an attacker a way to cause one.** The same
reasoning had already been used to make `finalize_graduation` absorb donated wrapper tokens; it
was not carried over to the bridge.

### Fix

The invariant is now an inequality, and the ledger is re-read from the chain rather than tracked
by arithmetic:

```rust
pub fn assert_backing(&self) -> Result<()> {
    require_gte!(self.real_rwa_locked, self.crwa_minted, AegisError::BackingShortfall);
    Ok(())
}
```

```rust
fn settle(...) -> Result<()> {
    crwa_mint.reload()?;
    escrow_vault.reload()?;
    launch.crwa_minted    = crwa_mint.supply;
    launch.real_rwa_locked = escrow_vault.amount;
    launch.assert_backing()
}
```

Equality checks on the vault balance in `launch_pool` and `fund_vault` were relaxed to `>=` for
the same reason. Local checks that a *specific transfer* moved the expected amount were kept —
those are statements about one operation, not about global state.

A shortfall still halts the bridge, deliberately. If the vault covered only part of the supply,
first-come-first-served redemption would pay the fastest holders and strand the rest; halting is
the fairer failure.

### Regression tests

`tests/security.test.ts` performs both attacks and asserts the bridge keeps working and the
launch ends over-collateralised, plus a third test confirming a genuine shortfall still halts.

---

## 2. Low — the hook's companion account was front-runnable

**Location:** `programs/aegis-hook/src/lib.rs`

Token-2022 resolves a hook's accounts through a per-mint account derived from the mint address.
`launch_pool` creates it by CPI in the same transaction that creates the mint.

The mint address is visible in the launch transaction before it lands. A watcher could call
`aegis_hook::initialize_extra_account_meta_list` for that mint first, and because the account used
`init`, the launch's own creation failed and the entire launch reverted.

Nothing was gained by the attacker — the account is owned by the hook program, so the only way to
create it is through that instruction, which always writes the same empty list. But the issuer had
to retry with a fresh mint keypair, and the attack was repeatable at the cost of a transaction.

**Fix:** the instruction is now idempotent (`init_if_needed`, with the list re-written and verified
on the already-initialised path). Regression test: an attacker claims the address first, and the
launch proceeds to `Live` regardless.

---

## 3. Low — `update_platform_config` reached the config without a seeds check

**Location:** `instructions/update_platform_config.rs`

Every other instruction loads the platform config by PDA seeds. This one accepted any account of
the right type whose recorded admin signed. Not exploitable today, because `initialize_platform`
creates the only possible config at a fixed PDA with `init` — but it was the one asymmetric path,
and it would stop being harmless the moment a second config became creatable.

**Fix:** seeds and bump added.

---

## 4. Informational — no events — **fixed**

The program emitted no events, so a frontend or indexer had to poll account state and there was no
durable record of who did what.

**Fix:** eleven events in `events.rs`, covering the platform, the quote-token whitelist and every
stage of a launch through both bridge directions. Each carries the resulting backing figures so a
watcher can follow the peg from logs alone.

One thing that cannot be done this way, contrary to the first draft of this report: a failed
transaction leaves no durable log, so there is no event for a backing shortfall or a broken
compliance setup. Those remain observable by comparing the vault balance against the wrapper
supply — two account reads, no transaction.

---

## 5. Informational — `initialize_platform` is first-caller-wins — **open, handled by procedure**

Whoever calls it first becomes the protocol admin, so a watcher who sees the program deployed could
claim it before the deployer's own transaction lands.

**Decision: not fixed in code.** An on-chain fix was implemented and then reverted. Requiring the
signer to be the program's upgrade authority means parsing the loader's programdata account by byte
offset, and — because Anchor's IDL generator silently omits both `Account<ProgramData>` and a
self-referencing `Program<'info, crate::program::Aegis>` — doing so with an unchecked account and a
hand-rolled parse. It also forced the test harness to write raw bytes into a loader account to
simulate a deployed program. That is a lot of machinery, in the most security-sensitive
instruction, for a window that lasts one transaction and is closed by an ordinary deploy script.

**Procedure instead:** initialize the platform in the same script as the deploy, and verify
`platform_config.admin` before announcing the program address. If the protocol is ever deployed
somewhere the deploy and initialization cannot be scripted together, revisit this — a hardcoded
admin pubkey compiled into the program is the simpler of the two on-chain options.

The Anchor IDL behaviour is worth recording regardless: the idiomatic upgrade-authority pattern
produces an IDL missing two accounts, and therefore a client that silently sends the wrong ones.

---

## 6. Informational — a launch could raise the issuer nothing — **fixed**

`migration_fee_pct` could be zero. Because Meteora turns the migration threshold into pool
liquidity and Aegis locks that liquidity permanently, such a launch delivers no capital to the
issuer at all — a silent and expensive surprise rather than an attack.

**Fix:** `PlatformConfig::min_migration_fee_pct`, defaulting to 1%, enforced in
`create_rwa_config`. An issuer who genuinely wants zero is still possible, but only once the
protocol admin lowers the floor — a deliberate decision rather than an accident.

---

## 7. Informational — `fee_recipient` was unvalidated — **fixed**

`update_platform_config` accepted any non-default pubkey. Setting one owned by another program
would make the lamport transfer in `create_rwa` fail, halting **every launch** until an admin
noticed. An admin footgun, not an external attack.

**Fix:** the new recipient is supplied as an *account* rather than a bare pubkey, constrained to
be system-owned. A pubkey cannot be validated; an account can.

---

## 8. Informational — `QuoteToken::is_legacy_spl` is never read — **resolved as documentation**

Nothing on-chain uses it; Meteora validates the quote token program against the mint during pool
creation. Wiring it into `launch_pool` would add an account to an already-large instruction to
produce a marginally clearer error for a case Meteora already rejects correctly.

**Resolution:** kept and documented as client-facing metadata, so a frontend can choose the right
token program without a second account fetch. The field's doc comment now says so.

## 9. Informational — a share of a zero migration fee gave an opaque error — **fixed**

Found while writing the regression test for finding 6. Meteora rejects a non-zero
`creator_fee_percentage` when `fee_percentage` is zero, and Aegis passed the combination straight
through, so the issuer saw `InvalidMigratorFeePercentage` from inside Meteora rather than anything
naming the contradiction.

**Fix:** checked in `create_rwa_config` with a dedicated error.

---

## 10. High — Aegis could not claim any of the revenue it accrues — **fixed**

**Location:** the instructions did not exist.

Meteora pays the "partner" side of a launch to whatever address is recorded as `fee_claimer`. For
Aegis that is the per-launch `aegis_authority` PDA, which is what makes it possible to hold cRWA
mint authority. Four streams accrue there:

* partner trading fees from the bonding curve (`claim_partner_trading_fee2`)
* the partner share of the migration fee (`withdraw_migration_fee`, partner flag)
* the partner share of surplus above the raise target (`partner_withdraw_surplus`)
* the 20% DAMM v2 liquidity position, which is permanently locked but continues earning fees

**Every one of those requires `fee_claimer` to sign.** A PDA can only be signed for by the program
that owns it, and Aegis has no instruction that does. The money is unreachable.

Measured on a 10,000-token raise:

```
partner_quote_fee (Aegis):  40,404,041     (~0.4% of the raise)
DAMM v2 position owner:     the Aegis PDA
Aegis instructions able to sign as fee_claimer:  NONE
```

The asymmetry is what makes this easy to miss: the issuer's side is a plain wallet, so they call
Meteora directly and collect everything. Only the protocol's own revenue is stranded, and nothing
fails loudly — the fees simply accumulate where nobody can reach them.

**Not an exploit**, and nothing is lost permanently while the program remains upgradeable. But as
shipped the protocol earns nothing, which is a product failure rather than a rounding error.

**Fix:** three instructions in `instructions/claim.rs` that sign as `aegis_authority` and forward
to `platform_config.fee_recipient`:

* `claim_partner_trading_fee`
* `claim_partner_migration_fee`

Both are **permissionless**. The destination is pinned to the recorded fee recipient, so a
stranger calling one only pays to move the protocol's money to the protocol — which makes them
safe to crank and removes any dependence on a single wallet staying live. Tested: a stranger can
call them, and receives nothing.

A third instruction, `claim_partner_surplus`, was written and then removed. Meteora books as
"surplus" anything a sale takes in beyond its migration threshold, but `curve::plan_curve`
generates a segment whose total quote capacity *is* the threshold, so surplus is structurally
zero and the instruction could never move money. The note explaining this now sits in
`curve.rs` at the line that pins capacity, because widening that segment is what would make
surplus real again.

Two decisions worth recording:

* **The base side is never claimed.** `create_rwa_config` pins fee collection to quote-only, so
  base fees are structurally zero. The claim asks for exactly zero on that side rather than an
  unbounded maximum, and then asserts nothing arrived. If that assumption ever breaks, fees stop
  arriving rather than wrapper tokens appearing in an unaccounted account.
* **The default issuer share of the migration fee moved from 100% to 80%.** At 100 the protocol's
  share is zero — legitimate, but it made the claim a silent no-op, which is how this class of
  bug hides.

**Still open:** fees earned by the 20% DAMM v2 liquidity position after graduation. Same PDA, but
claimed through DAMM v2 rather than the bonding curve, which is a separate integration.

---

## 11. Medium — admin transfer is single-step — **acknowledged, not fixed**

**Location:** `instructions/update_platform_config.rs`

`admin: Some(pubkey)` writes the new admin immediately. A mistyped or otherwise wrong address ends
protocol administration permanently: no pause switch, no quote-token approvals, no parameter
changes, ever.

**Acknowledged and deferred.** The fix is a two-step handover: write `pending_admin`, and require
the incoming admin to sign an `accept_admin` instruction. The `PlatformConfig` field for it was
designed in and never added.

Deferred because the exposure is one careless admin transaction, not an attacker, and the admin
is the protocol operator. It should be added before the admin key is ever handed to anyone else.

---

## 12. Medium — a launch abandoned after funding locked the asset forever — **fixed**

**Location:** the state machine, `state/launch.rs`

Only three instructions move the asset out of the escrow vault, and each requires a late stage:
`finalize_graduation` needs `Live`, and both bridge directions need `Graduated`.

`fund_vault` escrows the **entire** supply at stage `Funded`. If the issuer then stops — changes
their mind, loses their key, fails to configure a curve the firewall accepts — the asset is locked
in the vault with no path out. No cRWA exists at that point, so there is nothing to redeem against
it either.

Both `Funded` and `Configured` are safe to abort from, precisely because the wrapper does not exist
yet and no buyer can be harmed. There is no reason to make abandonment permanent.

**Fix:** `abort_launch`, valid only at `Funded` and `Configured`, signed by the issuer, returning
the entire vault balance through the same compliance path as any other exit.

The stage boundary is the whole safety argument, and it is asserted twice: by stage, and by
`crwa_minted == 0`. At those stages no wrapper exists, so there is no holder whose claim this
could erase. From `Live` onward the asset backs somebody else's holding and is no longer the
issuer's alone to withdraw. Tested at both `Live` and `Graduated`.

The launch moves to a terminal `Aborted` stage rather than being closed. The record is the only
durable trace that the asset was ever escrowed, and every other instruction is gated on a stage
`Aborted` is not, so nothing can act on it again.

---

## 13. Medium — the issuer can close the vault's holder record — **acknowledged, not fixable here**

**Location:** external — Upside's `revoke_security_associated_account`

That instruction carries `close = payer`, so the vault's `SecurityAssociatedAccount` can be
deleted outright rather than merely revoked. Once it is gone, `verify_compliance` cannot load it
and every bridge operation fails.

**Acknowledged.** This sits under accepted risk A and cannot be fixed in Aegis — the instruction
belongs to Upside, and the vault must be a registered holder to hold the asset at all. It is named
separately because it is cheaper than the issuer's other levers, and because the failure mode is an
account that does not exist rather than a value that looks wrong, which reads as a bug rather than
as interference. It is recoverable, but only by the issuer re-creating the record.

---

## A. Accepted risk — the issuer retains control of the asset

The issuer holds all four Upside roles, because an RWA is a legal security and its issuer must be
able to execute corporate actions, court-ordered transfers, lost-key recovery and sanctions
freezes. Consequently the issuer can:

* force-transfer the asset out of the Aegis vault
* raise the supply cap and dilute holders
* freeze the vault, or pause all transfers
* close the redemption rule
* repoint the asset's transfer hook (Upside makes the issuer the hook authority)

**This cannot be prevented.** Registering the Aegis vault as a lockup escrow — which would have
granted immunity from seizure, burning and freezing — is not available: Upside's
`set_lockup_escrow_account` requires the escrow to belong to their Tokenlock program, and that
program has no deposit path. Recorded in `findings-step1.md`.

**What Aegis does instead is detect all of it.** `verify_compliance` runs at `fund_vault`,
`launch_pool`, `bridge_deposit` and `bridge_redeem`, and checks the registry is unpaused, the hook
is still Upside's, the supply cap is unchanged, the vault is unfrozen and undelegated, and the
redemption path is open. `assert_backing` catches a drained vault. Each one halts rather than
proceeding into a broken state.

This is the honest claim: **Aegis guarantees the launch mechanics, not the issuer's conduct**, and
guarantees that misconduct is visible immediately rather than discovered at redemption.

One helpful property confirmed during review: Token-2022 extensions cannot be added after a mint
is initialised, so the asset can never *gain* a transfer fee, a pause extension or a close
authority after creation. Those risks are closed at genesis by Upside's mint construction.

---

## B. Accepted risk — program upgrade authority

Both programs are upgradeable. Holders trust that code as much as they trust the peg. Before
mainnet the authority should be transferred to a multisig, or revoked outright.

---

## What was verified and found sound

* **Arithmetic** — no unchecked arithmetic in program code; `checked_*` or `ok_or` throughout;
  `U256` for curve math. No `unwrap`, `expect` or `panic!` outside tests.
* **Curve construction** — single constant-liquidity segment, generated rather than accepted, so
  price spikes, liquidity traps and non-monotonic pricing are unrepresentable rather than merely
  rejected. Archetype ceilings enforced against the price where the sale actually closes, computed
  with Meteora's own routine. 13 unit tests including the boundary cases.
* **Stage machine** — strictly linear; every instruction requires one exact stage; no path skips or
  repeats a step.
* **CPI targets** — Meteora DBC, Meteora DAMM v2's pool authority, Upside's Transfer Restrictions
  and the Aegis hook are all pinned by address. Upside program addresses come from the IDLs via
  `declare_program!`, so there is no second copy to drift.
* **PDA derivation** — every Aegis and foreign PDA is constrained by seeds, with `seeds::program`
  where the owner is another program. `aegis_authority` is derived canonically in
  `create_rwa_config`, where the stored bump does not yet exist.
* **Mint authority** — `launch_pool` reads the finished mint back and refuses unless authority
  landed on the Aegis PDA, decimals match, freeze authority is unset and the entire supply is in
  Meteora's vault. Meteora offers an option that would have handed minting to the issuer; the test
  suite proves it was not taken.
* **Reentrancy** — the only external code reached during a token movement is Upside's hook and the
  Aegis hook, neither of which calls back.
* **Account substitution** — tested for the Meteora program, the hook program, the pool authority,
  a config from another launch, a quote mint from another launch, a launch record at the wrong
  address, an Upside registry at the wrong address, and a role account belonging to someone else.
* **Permissionless instructions** — `finalize_graduation` was reviewed on the assumption a stranger
  calls it at the worst possible moment; it moves nothing to the caller and changes nobody's
  entitlement. Meteora's own `withdraw_leftover` is likewise permissionless, and Aegis now tolerates
  a stranger calling it first (fixed earlier in development, regression-tested).

---

## Compute costs (measured)

| Instruction | CU |
|---|---|
| `launch_pool` | 126,818 |
| `bridge_deposit` | 118,371 |
| `bridge_redeem` | 103,022 |

All under the 200,000 default, so a compute-budget instruction is not required. The test harness
raises it anyway as headroom against Meteora's costs shifting.

---

## Remaining before mainnet

1. **Transfer upgrade authority to a multisig** (B), and script the deploy so that
   `initialize_platform` runs immediately after it (finding 5).
2. **Commission an external audit.** This review was performed by the same party that wrote the
   code, which is worth exactly what it sounds like. Two critical bugs were found in code that
   already had 135 passing tests; the next two will be found by someone who did not write it.
3. Accepted risk A should be stated plainly in the product UI, not only in this document. Buyers
   are trusting the issuer's conduct, and the protocol guarantees detection rather than prevention.
4. Add the two-step admin handover (finding 11) before the admin key changes hands.
5. Add a DAMM v2 position fee claim, so post-graduation liquidity revenue is reachable (finding 10,
   remaining part).
