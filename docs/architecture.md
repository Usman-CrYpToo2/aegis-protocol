# Aegis architecture

Diagrams of how Aegis works, drawn from the program source. Every instruction, account, seed and cross-program call shown here exists in the code; file paths point to where it happens. For the overview, start with the [README](../README.md).

1. [System overview](#1-system-overview)
2. [Accounts and authorities](#2-accounts-and-authorities)
3. [Launch lifecycle](#3-launch-lifecycle)
4. [Launching an asset](#4-launching-an-asset)
5. [Trading during the sale](#5-trading-during-the-sale)
6. [Graduation](#6-graduation)
7. [The bridge](#7-the-bridge)
8. [The compliance gate](#8-the-compliance-gate)
9. [Where the money goes](#9-where-the-money-goes)
10. [Who controls what](#10-who-controls-what)

## 1. System overview

Every party, every program, and the instructions that connect them. Solid arrows are calls; dotted arrows are reads or calls made by the token program itself.

```mermaid
flowchart LR
    subgraph People
        ADM["Platform admin"]
        ISS["Issuer"]
        BUY["Buyer or trader"]
        HOL["Approved holder"]
        ANY["Anyone"]
    end

    APP["Aegis web app<br/>static site, builds and sends<br/>every transaction from the wallet"]

    subgraph AEGIS["Aegis programs"]
        AG["aegis<br/>orchestrator"]
        HK["aegis_hook<br/>permissive transfer hook"]
        FC["aegis_faucet<br/>devnet test tokens"]
    end

    subgraph METEORA["Meteora"]
        DBC["Dynamic Bonding Curve"]
        DAMM["DAMM v2"]
    end

    subgraph UPSIDE["Upside"]
        AC["Access Control"]
        TR["Transfer Restrictions"]
    end

    T22["Token-2022"]

    People --> APP
    ADM -->|"initialize_platform<br/>update_platform_config<br/>whitelist_quote_token<br/>update_quote_token"| AG
    ISS -->|"create_rwa, fund_vault<br/>create_rwa_config, launch_pool<br/>abort_launch, claim_unsold"| AG
    ISS -->|"register, groups, rules,<br/>approve, freeze, pause"| UPSIDE
    ISS -->|"withdraw cash share<br/>as pool creator"| DBC
    BUY -->|"swap2_with_transfer_hook"| DBC
    BUY -->|"swap, after graduation"| DAMM
    HOL -->|"bridge_redeem<br/>bridge_deposit"| AG
    ANY -->|"migration_damm_v2"| DBC
    ANY -->|"finalize_graduation<br/>claim_partner_trading_fee<br/>claim_partner_migration_fee"| AG
    ANY -->|"drip"| FC

    AG -->|"initialize_access_control<br/>grant_role, mint_securities"| AC
    AG -->|"create_config_with_transfer_hook<br/>initialize_virtual_pool_with_token2022_transfer_hook<br/>withdraw_leftover, claim_trading_fee2<br/>withdraw_migration_fee"| DBC
    AG -->|"initialize_extra_account_meta_list"| HK
    AG -.->|"reads the register, rules<br/>and holder records"| TR
    AG -->|"transfer_checked, mint_to, burn"| T22
    DBC -->|"migration creates the pool"| DAMM
    T22 -.->|"execute, on every<br/>security transfer"| TR
    T22 -.->|"execute, on wrapper transfers<br/>until graduation"| HK
```

## 2. Accounts and authorities

What each account is, which program owns it, and who holds authority over it. One `Launch` and one `aegis_authority` exist per asset, so a launch can never touch another launch's escrow.

```mermaid
flowchart TB
    subgraph AEGISPROG["Owned by the aegis program"]
        PC["PlatformConfig<br/>seeds: platform_config<br/>admin, fee_recipient, fees, bounds, pause"]
        QT["QuoteToken<br/>seeds: quote_token, mint<br/>approved currency, min raise"]
        L["Launch<br/>seeds: launch, security mint<br/>stage, mints, Meteora accounts,<br/>real_rwa_locked, crwa_minted,<br/>issuer_unsold, vault_group, investor_group"]
        AA["aegis_authority<br/>seeds: authority, launch<br/>signer-only PDA, no data, no private key"]
    end

    subgraph SEC["The security"]
        SM["Security mint (Real RWA)<br/>Token-2022, Upside transfer hook,<br/>supply cap = issue size"]
        EV["Escrow vault<br/>ATA of aegis_authority<br/>holds the whole issue"]
        UAC["Upside AccessControl<br/>roles and max supply"]
    end

    subgraph WRAP["The wrapper"]
        WM["Wrapper mint (cRWA)<br/>Token-2022, created by Meteora<br/>freeze authority: none"]
        EAM["Extra account metas<br/>seeds: extra-account-metas, wrapper mint<br/>empty list, owned by aegis_hook"]
    end

    subgraph MET["Owned by Meteora"]
        CFG["DBC config<br/>fee_claimer = aegis_authority<br/>leftover_receiver = aegis_authority<br/>hook program = aegis_hook"]
        VP["Virtual pool<br/>creator = issuer"]
        DP["DAMM v2 pool"]
        PP["Protocol position<br/>10% of liquidity, locked forever"]
        CP["Issuer position<br/>locked forever and/or vested"]
    end

    subgraph REG["Owned by Upside Transfer Restrictions"]
        TRD["Registry<br/>seeds: trd, security mint"]
        G1["Group 1: Investors"]
        G2["Group 2: Escrow vault"]
        R21["Rule 2 to 1: redemption path"]
        R12["Rule 1 to 2: deposit path"]
        VSAA["Vault approval record<br/>seeds: saa, escrow vault"]
        HSAA["Holder approval records<br/>seeds: saa, holder account"]
    end

    ISS(["Issuer wallet"])

    L -->|"one per"| SM
    AA -->|"owns"| EV
    EV -->|"holds"| SM
    AA -->|"mint authority"| WM
    UAC -->|"mints, under Reserve Admin"| SM
    ISS -->|"all four Upside roles"| UAC
    ISS -->|"transfer-hook authority"| SM
    CFG --> VP
    VP -->|"graduates into"| DP
    DP --> PP
    DP --> CP
    AA -->|"owns"| PP
    ISS -->|"owns"| CP
    AA -.->|"fee_claimer"| CFG
    WM --- EAM
    TRD --> G1
    TRD --> G2
    G2 --> R21
    G1 --> R12
    VSAA -->|"vault is in"| G2
    HSAA -->|"approved holders are in"| G1
    L -.->|"pins vault_group = 2,<br/>investor_group = 1"| TRD
```

The group numbers are Aegis's convention (`GROUP_INVESTOR = 1`, `GROUP_VAULT = 2` in [`constants.rs`](../programs/aegis/src/constants.rs)). `fund_vault` reads the vault's group from its approval record and pins both numbers on the `Launch`, so a later change is detected.

## 3. Launch lifecycle

Stages only move forward. Every instruction requires the exact stage it is valid in ([`state/launch.rs`](../programs/aegis/src/state/launch.rs)).

```mermaid
stateDiagram-v2
    [*] --> TokenCreated: create_rwa
    TokenCreated --> Funded: fund_vault
    Funded --> Configured: create_rwa_config
    Configured --> Live: launch_pool
    Live --> Graduated: finalize_graduation, after Meteora migration
    Funded --> Aborted: abort_launch
    Configured --> Aborted: abort_launch
    Aborted --> [*]

    note right of TokenCreated
        Security exists, issuer holds every Upside role.
        Issuer sets up the register directly with Upside.
    end note
    note right of Funded
        Whole issue in escrow. No wrapper exists yet.
    end note
    note right of Live
        Wrapper exists, the curve trades on Meteora.
        assert_backing holds from here on.
    end note
    note right of Graduated
        DAMM v2 pool is live, the hook is revoked.
        bridge_redeem, bridge_deposit and claim_unsold open.
    end note
```

`abort_launch` is only reachable before any wrapper exists. From `Live` on, buyers hold wrapper backed by the escrow, so the asset is no longer the issuer's alone to withdraw.

## 4. Launching an asset

The eight transactions an issuer sends, in order. Steps 2 to 5 are signed by the issuer directly against Upside; Aegis does not configure compliance for the issuer, it verifies it at step 6.

```mermaid
sequenceDiagram
    actor I as Issuer
    participant A as aegis
    participant AC as Upside Access Control
    participant TR as Upside Transfer Restrictions
    participant D as Meteora DBC
    participant H as aegis_hook
    participant T as Token-2022

    rect rgba(127,127,127,0.08)
    Note over I,T: Transaction 1, create: the security
    I->>A: create_rwa(name, symbol, uri, decimals, total supply)
    A->>A: charge the launch fee in SOL to fee_recipient
    A->>AC: initialize_access_control (mint with Upside hook, max supply = issue size)
    A->>AC: grant_role Reserve, Wallets and Transfer Admin (issuer is already Contract Admin, Aegis keeps none)
    A->>A: create Launch, stage TokenCreated
    end

    rect rgba(127,127,127,0.08)
    Note over I,TR: Transactions 2 to 5, compliance setup: signed by the issuer, sent to Upside
    I->>TR: registry and the hook's extra account metas
    I->>TR: group 1 Investors, group 2 Escrow, rule 2 to 1, rule 1 to 2
    I->>TR: escrow vault as a holder in group 2
    I->>TR: issuer as a holder in group 1
    end

    rect rgba(127,127,127,0.08)
    Note over I,T: Transaction 6, fund: lock the whole issue
    I->>A: fund_vault(investor group)
    A->>TR: read registry, hook, vault record, redemption rule
    A->>A: verify_compliance and supply cap check
    A->>AC: mint_securities(whole issue) into the escrow vault, issuer signs as Reserve Admin
    A->>A: pin vault_group and investor_group, stage Funded
    end

    rect rgba(127,127,127,0.08)
    Note over I,D: Transaction 7, terms: fix the sale with Meteora
    I->>A: create_rwa_config(opening price, price range, target raise, archetype, cash share, liquidity split, vesting, pool fee)
    A->>A: check every term against PlatformConfig bounds and the archetype ceiling
    A->>A: build a one-segment curve (curve.rs)
    A->>D: create_config_with_transfer_hook (fee_claimer and leftover_receiver = aegis_authority, mint authority option 4)
    A->>A: stage Configured
    end

    rect rgba(127,127,127,0.08)
    Note over I,T: Transaction 8, open: create the wrapper and start the sale
    I->>A: launch_pool(wrapper name, symbol, uri)
    A->>A: verify_compliance and supply cap check again
    A->>D: initialize_virtual_pool_with_token2022_transfer_hook (issuer is pool creator)
    D->>T: create the wrapper mint and mint the whole supply into the pool
    A->>H: initialize_extra_account_meta_list(wrapper mint)
    A->>A: require supply = issue size = escrow balance
    A->>A: require mint authority = aegis_authority, no freeze authority, decimals match
    A->>A: assert_backing, stage Live
    end
```

The app sends these as one wallet approval using durable nonces, but each is its own transaction and progress is read back from the chain, so a launch can resume after any step ([`app/src/chain/issue.ts`](../app/src/chain/issue.ts)).

## 5. Trading during the sale

The Aegis program is not in the trade path. Buyers call Meteora directly; Token-2022 invokes the permissive hook on each wrapper transfer.

```mermaid
sequenceDiagram
    actor B as Buyer
    participant D as Meteora DBC
    participant T as Token-2022
    participant H as aegis_hook

    B->>D: swap2_with_transfer_hook(amount, PartialFill)
    D->>D: price from the one-segment curve
    D->>D: take the 1% fee in the quote token
    D->>T: transfer_checked wrapper from the pool to the buyer
    T->>H: execute
    H-->>T: approve, no checks, no state
    D-->>B: wrapper received
    Note over B,D: Sells go the other way at the curve's price. Fees accrue only in the quote token,<br/>so the wrapper supply in the pool is never skimmed.
```

Buys use `PartialFill`, so the buy that completes the sale is filled up to the target instead of failing. Because Aegis sizes the curve so total quote capacity matches the target, Meteora books no surplus and no surplus claim exists ([`curve.rs`](../programs/aegis/src/curve.rs)).

## 6. Graduation

Two permissionless transactions, sent by anyone once the curve is full. Neither moves any security, so no compliance setting can hold graduation back.

```mermaid
sequenceDiagram
    actor B as Last buyer
    actor X as Anyone
    participant D as Meteora DBC
    participant P as Meteora DAMM v2
    participant A as aegis
    participant T as Token-2022

    B->>D: buy that fills the curve
    D->>T: revoke the wrapper's transfer hook, permanently
    Note over D,T: From here the wrapper is a plain Token-2022 mint, open to anyone.

    X->>D: migration_damm_v2
    D->>D: withhold the migration fee (issuer's cash share)
    D->>P: create the pool at the sale's final price
    P->>P: protocol position, owned by aegis_authority, locked forever
    P->>P: issuer position, locked forever and/or vesting

    X->>A: finalize_graduation
    A->>A: require stage Live
    A->>D: withdraw_leftover to aegis_authority (wrapper the curve never sold)
    A->>T: burn the leftover wrapper
    A->>A: issuer_unsold += leftover, the security stays in escrow
    A->>A: re-read escrow and supply, assert_backing
    A->>A: stage Graduated, bridge open
```

The unsold security stays in escrow instead of being sent to the issuer, so opening the bridge never depends on the issuer being a registered holder ([`finalize_graduation.rs`](../programs/aegis/src/instructions/finalize_graduation.rs)). The issuer collects it later with `claim_unsold`.

## 7. The bridge

Open after graduation to wallets in the launch's investor group. Redemption puts a floor under the wrapper's market price, and deposit puts a ceiling on it ([`bridge.rs`](../programs/aegis/src/instructions/bridge.rs)).

### Redeem: wrapper to security

```mermaid
sequenceDiagram
    actor U as Approved holder
    participant A as aegis
    participant T as Token-2022
    participant TR as Upside Transfer Restrictions

    U->>A: bridge_redeem(amount)
    A->>A: require stage Graduated
    A->>A: require the holder's approval record is in investor_group
    A->>A: verify_compliance (section 8)
    A->>T: burn amount of wrapper, signed by the holder
    A->>T: transfer_checked amount of security, escrow to holder, signed by aegis_authority
    T->>TR: execute: holder groups and the rule from group 2 to group 1
    TR-->>T: allowed
    A->>A: require the escrow released exactly amount
    A->>A: re-read supply and escrow, assert_backing
    A-->>U: security received, 1 for 1, no fee
```

### Deposit: security to wrapper

```mermaid
sequenceDiagram
    actor U as Approved holder
    participant A as aegis
    participant T as Token-2022
    participant TR as Upside Transfer Restrictions

    U->>A: bridge_deposit(amount)
    A->>A: require stage Graduated
    A->>A: require the holder's approval record is in investor_group
    A->>A: verify_compliance, and the deposit rule from group 1 to group 2 is open
    A->>T: transfer_checked amount of security, holder to escrow, signed by the holder
    T->>TR: execute: holder groups and the rule from group 1 to group 2
    TR-->>T: allowed
    A->>A: measure what the escrow actually received
    A->>T: mint_to exactly that much wrapper, signed by aegis_authority
    A->>A: re-read supply and escrow, assert_backing
    A-->>U: wrapper received, 1 for 1, no fee
```

Burning first on redeem means that if the security cannot be released, the burn is undone with the rest of the transaction. On deposit the wrapper minted is what arrived, not what was asked for.

## 8. The compliance gate

`verify_compliance` reads Upside's live state every time acting on a broken setup would cost someone money. The issuer owns that state and can change it at any time, so it is checked at each gate rather than recorded once ([`compliance.rs`](../programs/aegis/src/compliance.rs)).

```mermaid
flowchart TD
    S(["verify_compliance"]) --> C1{"Registry belongs to<br/>this security?"}
    C1 -- no --> E1["ComplianceRegistryMismatch"]
    C1 -- yes --> C2{"Registry paused?"}
    C2 -- yes --> E2["TransfersPaused"]
    C2 -- no --> C3{"Security's transfer hook<br/>still Upside's?"}
    C3 -- no --> E3["UnauthorizedTransferHook"]
    C3 -- yes --> C4{"Vault: right mint, owned by<br/>aegis_authority, not frozen,<br/>no delegate?"}
    C4 -- no --> E4["VaultMintMismatch, VaultNotOwnedByAegis,<br/>VaultFrozen or VaultHasDelegate"]
    C4 -- yes --> C5{"Vault still in the<br/>pinned vault group?"}
    C5 -- no --> E5["VaultGroupChanged"]
    C5 -- yes --> C6{"Rule from vault group to<br/>investor group exists?"}
    C6 -- no --> E6["WrongRedeemRule"]
    C6 -- yes --> C7{"Rule open now?<br/>locked_until 1, or a time passed"}
    C7 -- "0, forbidden" --> E7["RedemptionPathClosed"]
    C7 -- "future time" --> E8["RedemptionPathLocked"]
    C7 -- yes --> OK(["pass"])
```

| Gate | `verify_compliance` | Supply cap unchanged | `assert_backing` |
|---|---|---|---|
| `fund_vault` | yes | yes | |
| `launch_pool` | yes | yes | yes |
| `bridge_redeem` | yes | | yes |
| `bridge_deposit` | yes, plus the deposit rule | | yes |
| `abort_launch` | yes | | yes |
| `claim_unsold` | yes | | yes |
| `finalize_graduation` | not needed, moves no security | | yes |

The supply cap check runs only where a new buyer is about to enter. Upside's cap can only be raised, so checking it on the bridge would let one lawful share issue block every holder's exit for good.

## 9. Where the money goes

Default settings from `initialize_platform`; the admin can change them for new launches, and the issuer chooses within the bounds.

```mermaid
flowchart LR
    ISS(["Issuer"]) -->|"launch fee in SOL<br/>1 SOL default, 0.001 on devnet"| FR(["Platform fee recipient"])

    BUY(["Buyers"]) -->|"quote token"| CURVE["Bonding curve<br/>quote reserve"]
    CURVE -->|"1% fee on every trade"| FEE{"Curve fee"}
    FEE -->|"20%"| MP(["Meteora protocol"])
    FEE -->|"80%, partner side"| PS["Held for aegis_authority"]
    PS -->|"claim_partner_trading_fee<br/>anyone can send it"| FR

    CURVE -->|"at graduation"| MIG{"Raise"}
    MIG -->|"cash share, 1% to 90%,<br/>issuer's choice"| MF["Migration fee"]
    MF -->|"issuer withdraws on Meteora<br/>as pool creator"| ISS
    MF -.->|"protocol share, 0% default<br/>claim_partner_migration_fee"| FR
    MIG -->|"the rest"| POOL["DAMM v2 pool liquidity"]
    POOL -->|"10%"| PL["Protocol position<br/>locked forever"]
    POOL -->|"90%"| IL["Issuer position<br/>locked forever and/or<br/>vested over 3 to 24 months"]
    IL -->|"pool trading fees,<br/>0.1% to 3%"| ISS

    ESC[("Escrow")] -->|"claim_unsold, after graduation,<br/>only the excess over wrapper supply"| ISS
```

The protocol's DAMM v2 position also earns pool trading fees. It is owned by `aegis_authority`, and the program does not yet have an instruction to claim them ([`claim.rs`](../programs/aegis/src/instructions/claim.rs)), so they accrue in the position.

## 10. Who controls what

| Power | Held by | Limits |
|---|---|---|
| Change fees, bounds, currencies; pause | Platform admin | Only reaches launches that have not opened their sale. No authority over any security, escrow or wrapper. |
| All four Upside roles: mint, approve, freeze, pause, force transfer, burn | Issuer | Securities law requires them. They reach the escrow too; if the escrow ever falls short, `assert_backing` stops the bridge and `claim_unsold` absorbs the loss first. |
| Point the security's transfer hook elsewhere | Issuer, as hook authority | Detected by `verify_compliance` at every gate. |
| Mint wrapper | `aegis_authority`, only in `bridge_deposit` | Exactly what the escrow received. |
| Move security out of the escrow | `aegis_authority` | Only in `bridge_redeem`, `abort_launch` and `claim_unsold`, each through the compliance gate. |
| Freeze the wrapper | Nobody | `launch_pool` requires the freeze authority to be empty. |
| Withdraw graduated liquidity on day one | Nobody | Protocol share locked forever; issuer share locked or vested. |
