//! Aegis permissive transfer hook.
//!
//! This program exists for one structural reason, not a functional one.
//!
//! Aegis needs the authority to mint cRWA, because the bridge creates a wrapper token whenever
//! someone deposits the underlying asset. Meteora only grants that authority on configs created
//! through its transfer-hook variant — its plain launches hard-lock mint authority to nobody, so
//! that buyers get a guaranteed fixed supply. That variant demands a real, executable hook
//! program, so Aegis must supply one.
//!
//! cRWA is the freely tradable wrapper: compliance lives on the Real RWA, which this program
//! never touches. So the hook approves everything. It is deliberately inert.
//!
//! Its life is short. Meteora permanently revokes the hook from the cRWA mint the moment the
//! bonding curve completes, because the AMM it graduates to cannot host hooked mints. After that
//! this program is never invoked for that token again.
//!
//! Security notes:
//! - `execute` takes no authority and can be called by anyone. That is correct: it is invoked by
//!   Token-2022 during a transfer and its only job is to not block it. It reads nothing, writes
//!   nothing, and holds no state.
//! - `initialize_extra_account_meta_list` is permissionless. It can only create the canonical
//!   PDA for a mint, and only ever writes an empty list, so there is nothing to seize or forge.
//!   Front-running it is a no-op: the resulting account is byte-identical whoever creates it.
use anchor_lang::prelude::*;
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("PHoRUD1bk52nZmdkQ2qGTjMx71wKDM8bEzfeACzFXk5");

/// Token-2022 resolves a hook's extra accounts through a per-mint account at this seed. Without
/// it, every transfer of the mint fails, so it must exist before the first trade.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

#[program]
pub mod aegis_hook {
    use super::*;

    /// Creates the (empty) extra-account list for a mint.
    ///
    /// Must be called after the cRWA mint exists and before its first transfer. Meteora creates
    /// that mint inside its own pool-initialization instruction, so this cannot run any earlier.
    ///
    /// Idempotent. The account address is derived from the mint, which appears in the launch
    /// transaction before that transaction lands, so a watcher could otherwise create it first
    /// and make the launch revert. Nothing is gained by doing so — the account is owned by this
    /// program, so the only way to create it is through this instruction, and this instruction
    /// always writes the same empty list — but failing on it would have handed anyone a cheap,
    /// repeatable way to block launches.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        // An empty list: this hook needs no accounts beyond the ones Token-2022 always passes.
        //
        // Writing over an already-initialized account is a no-op in substance, since the list is
        // the same every time and nobody else can own this address. `init` would fail instead,
        // which is the behaviour being avoided.
        if ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &[]).is_err() {
            // Already initialized by an earlier call. Only this instruction can ever have
            // written it, since the account is owned by this program — but that is confirmed
            // rather than assumed.
            ExtraAccountMetaList::update::<ExecuteInstruction>(&mut data, &[])?;
        }
        Ok(())
    }

    /// The transfer-hook entry point, invoked by Token-2022 on every transfer of a mint that
    /// points here.
    ///
    /// The discriminator is fixed by the SPL transfer-hook interface rather than derived from
    /// the function name, because Token-2022 calls it by that exact selector.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(_ctx: Context<Execute>, _amount: u64) -> Result<()> {
        // Intentionally permissive. See the module docs: compliance is enforced on the Real RWA,
        // not on the wrapper.
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: written through the SPL TLV helper, which owns the layout. The seeds pin it to the
    /// canonical address Token-2022 will look for.
    #[account(
        init_if_needed,
        payer = payer,
        space = ExtraAccountMetaList::size_of(0).unwrap(),
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: identity only. Used as a seed; no data is read from it.
    pub mint: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// The account layout is dictated by the SPL transfer-hook interface. Token-2022 always passes
/// these five in this order, so nothing here is ours to choose or constrain.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: interface-defined; not read.
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: interface-defined; not read.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: interface-defined; not read.
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: interface-defined; not read.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: interface-defined; not read.
    pub extra_account_meta_list: UncheckedAccount<'info>,
}
