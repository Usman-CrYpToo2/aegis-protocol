# Step 1 findings — Upside escrow & trust model

**Date:** 2026-09-27
**Method:** source review of the deployed programs, not documentation.

## How this was verified

The Upside RWA programs turned out to be open source. The deployed mainnet binaries match
this repository exactly (program IDs verified against `declare_id!`):

* Repo: `https://github.com/upsideos/upsideos-solana-rwa` (redirects from
  `CoMakery/solana-security-token`), commit `ce74f27`
* Local clone used for this review: `/tmp/ust`
* Binaries dumped from mainnet for comparison: `/tmp/upside/{ac,tr,tl}.so`

Because the source is available, every answer below is a code citation rather than a
devnet experiment. This is stronger evidence than a transaction signature would have been.

## Program availability

| Program | Mainnet | Devnet |
|---|---|---|
| Access Control `4X79…Jwr3` | yes | **no** |
| Transfer Restrictions `6yEn…cfPBZ` | yes | **no** |
| Tokenlock `Aood…71Gt` | yes | yes |
| Dividends `FUjk…Rkog` | yes | **no** |

Devnet is not a usable test environment. Testing must be done in `litesvm` with the
mainnet binaries loaded, which we already do for Meteora DBC. Also note: none of the four
programs publish an on-chain Anchor IDL (`anchor idl fetch` fails for all). IDLs must come
from the repo or be generated from it.

---

## Q1 — Can an Aegis-owned vault be registered as the lockup escrow?

### **No. Definitively not.**

There are two `set_lockup_escrow_account` instructions, one per program, and both enforce
the same thing.

`programs/access-control/src/instructions/access_control/set_lockup_escrow_account.rs`
and `programs/transfer-restrictions/src/instructions/transfer_restrictions/set_lockup_escrow_account.rs`:

```rust
let discriminator = TokenLockData::DISCRIMINATOR;
let tokenlock_account_data = tokenlock_account.try_borrow_data()?;
if sol_memcmp(&discriminator, &tokenlock_account_data, discriminator.len()) != 0 {
    return Err(...IncorrectTokenlockAccount.into());
}
let escrow_account = TokenLockDataWrapper::escrow_account(&tokenlock_account_data);
if escrow_account != *ctx.accounts.escrow_account.to_account_info().key {
    return Err(...MismatchedEscrowAccount.into());
}
```

with the account context requiring `*tokenlock_account.owner == tokenlock_accounts::ID`.

So the escrow must be the escrow recorded inside a real Tokenlock account. And
`programs/tokenlock/src/instructions/initialize_tokenlock.rs` requires:

```rust
let (pda, bump_seed) = Pubkey::find_program_address(
    &[TOKENLOCK_PDA_SEED, mint_address.as_ref(),
      tokenlock_account.to_account_info().key.as_ref()],
    ctx.program_id,
);
if escrow_account.owner != pda { return Err(IncorrectEscrowAccount.into()); }
```

The escrow's owner must be a PDA of the **Tokenlock** program. An Aegis PDA can never own
it. The documentation's description of an arbitrary `escrow_account` pubkey is wrong.

**Documentation correction:** the docs say `set_lockup_escrow_account` requires the
*Transfer Admin* role. The source requires **Contract Admin** in both programs.

### Can Tokenlock itself serve as the Aegis vault instead?

No, for a structural reason: **the Tokenlock escrow has no deposit path.** It is funded
only by `mint_release_schedule`, which CPIs into `access_control::mint_securities` and mints
*new* tokens. There is no instruction that moves existing tokens into the escrow.

Tokens leave only via `tokenlock::transfer`, which requires
`authority.key == timelock_account.target_account`, enforces the release schedule
(`unlocked_balance_of >= value`), and independently CPIs
`enforce_transfer_restrictions` on the destination.

That is workable for a one-way vesting vault. It cannot support Aegis's two-way bridge,
because users could never deposit their Real RWA into it.

---

## Q2 — Is the escrow slot single-use?

**No, and this matters more than Q1.** The docs claim it "can only be set once." The source
allows a Contract Admin to re-point it at a different escrow at any time. The access-control
version's only guard is `ValueUnchanged` if you pass the same account; the
transfer-restrictions version creates a `SecurityAssociatedAccount` seeded on the escrow
account, so a *different* escrow simply creates a different SAA and succeeds.

Consequence: even if Aegis could become the escrow, the issuer's Contract Admin could move
the pointer away afterwards and strip the immunity. Escrow status was never a hard
guarantee. The original design's central assumption was wrong in two independent ways.

---

## Q3 — Which direction does the escrow bypass apply?

**Source only.** `programs/transfer-restrictions/src/instructions/transfer_hook/execute.rs`:

```rust
// transfer restriction for lockup escrow account is validated inside tokenlock program
if transfer_restriction_data.lockup_escrow_account == Some(ctx.accounts.source_account.key()) {
    return Ok(());
}
```

Transfers *out of* escrow skip the hook. Transfers *into* escrow are fully checked — the
destination needs a `SecurityAssociatedAccount` and a permitted `TransferRule`. The Tokenlock
documentation page was closer to correct than the Transfer Restrictions page: outbound
transfers are still checked, just by Tokenlock's own explicit CPI rather than by the hook.

The escrow does get an SAA in group 0, created by `set_lockup_escrow_account`, so it can
legally receive tokens provided some rule permits `source_group → 0`.

---

## Bonus findings (all verified in source)

**F1. Force transfer and burn require the mint authority to be the Access Control PDA.**
Both `force_transfer_between` and `burn_securities` carry
`constraint = security_mint.mint_authority == COption::Some(access_control.key())`. There is
no instruction to revoke the mint authority, and it is set to the AC PDA at initialization.
So this constraint is always satisfied — it is not an escape hatch.

**F2. The supply cap can only ever be raised.**
`set_max_total_supply` rejects any value `<= current`:
```rust
if max_total_supply <= ctx.accounts.access_control_account.max_total_supply {
    return Err(NewMaxTotalSupplyMustExceedCurrentTotalSupply.into());
}
```
A Reserve Admin can therefore always raise the cap and mint more. **Dilution of every
holder's claim is permanently possible for as long as anyone holds Reserve Admin.** This is
independent of the escrow question and is arguably a larger problem than force transfer.

**F3. The permanent delegate short-circuits the hook entirely.**
`execute.rs` begins by returning `Ok(())` if the transfer's authority equals the mint's
permanent delegate. Force transfers therefore bypass every compliance check, by design.

**F4. A plain Aegis PDA vault can hold the Real RWA perfectly well.**
It needs a `SecurityAssociatedAccount` (`initialize_security_associated_account`) and
transfer rules in both directions. Escrow status was never needed for *function* — only for
*immunity*. So the bridge design works; it is only the safety claim that was overstated.

**F5. `revoke_role` has no self-protection and no last-admin protection.** ← **the way out**
```rust
if !authority_wallet_role.has_role(Roles::ContractAdmin) { return Err(Unauthorized) }
if role > Roles::All as u8 { return Err(InvalidRole) }
if wallet_role.role & role != role { return Err(CannotRevokeRole) }
wallet_role.role ^= role;
```
A Contract Admin may pass `user_wallet = itself` and `role = 15 (All)` and zero its own
roles in a single transaction. Nothing prevents revoking the last administrator. Once every
`WalletRole` is zero, the affected powers are **permanently and irreversibly gone**, because
re-granting requires Contract Admin.

**F6. Role requirements, as actually implemented:**

| Power | Role required |
|---|---|
| `mint_securities`, `burn_securities`, `force_transfer_between`, `set_max_total_supply` | ReserveAdmin |
| `freeze_wallet`, `thaw_wallet` | TransferAdmin or WalletsAdmin |
| `grant_role`, `revoke_role`, `initialize_transfer_restrictions_data`, `initialize_tokenlock`, `set_lockup_escrow_account` | ContractAdmin |
| `initialize_transfer_restriction_group`, `initialize_transfer_rule`, `set_allow_transfer_rule`, `set_holder_max`, `set_holder_group_max` | TransferAdmin |
| `revoke_holder`, `revoke_security_associated_account`, `set_address_permission` | TransferAdmin or WalletsAdmin |
| `pause` | ContractAdmin or TransferAdmin |

---

## Conclusion

The escrow-based trust model in `design.md` §2 is **not achievable** and must be replaced.

The replacement is stronger, not weaker. Instead of protecting one vault account via escrow
status, Aegis should require **permanent renunciation of the dangerous roles** before a
launch goes live, and verify it on-chain. Specifically:

* `ReserveAdmin` revoked from every wallet → no minting, no dilution (F2), no force
  transfer, no burn, for anyone, forever.
* `ContractAdmin` revoked from every wallet → the above becomes irreversible, since
  `grant_role` needs Contract Admin.
* `TransferAdmin` / `WalletsAdmin` retained, because onboarding new investors and
  maintaining transfer rules requires them after launch. These roles can still freeze
  accounts and pause transfers, so they should be held by an Aegis-controlled multisig or a
  jointly-controlled one — **not** by the issuer alone.

This protects every holder rather than only the Aegis vault, and it is verifiable by anyone
by reading the `WalletRole` PDAs.

The cost is that the token becomes genuinely fixed-supply. That is correct for a single
building or a closed credit facility, and wrong for an open-ended fund that issues new
shares. It therefore becomes a launch archetype the issuer chooses, with different
disclosure for each.

### What changes in the design

| `design.md` reference | Change |
|---|---|
| §2, the escrow diagram and rationale | replace with role renunciation |
| §2 blocking dependency, items 1–3 | resolved: Q1 no, Q2 no, Q3 source-only |
| §4.3 `verify_compliance_setup` | rewrite: verify revoked roles and supply cap instead of escrow registration |
| §4.5 `fund_escrow` | vault needs an SAA; add a rule check; drop escrow assumptions |
| §4.9 `bridge_redeem` | Aegis's own SAA check is now mandatory, not belt-and-braces |
| §6 invariant I4 | replace "escrow registered" with "ReserveAdmin and ContractAdmin unheld" |
| §8 fallback list | superseded |
| §10 test fixtures | add the three Upside binaries; devnet is unusable |

### New open questions

| # | Question |
|---|---|
| N1 | Does a `WalletRole` account with `role == 0` behave identically to no account at all in every check? (It should — `has_role` is a bitmask test — but confirm in litesvm.) |
| N2 | If `TransferAdmin` is held by Aegis, is Aegis then a regulated transfer agent? Legal question, not technical. |
| N3 | Can `max_total_supply` be set exactly equal to the launch supply at `initialize_access_control` time, so the cap is tight before Reserve Admin is revoked? |
| N4 | Who holds `TransferAdmin` in practice, and what is the process when a new investor needs onboarding after launch? |
