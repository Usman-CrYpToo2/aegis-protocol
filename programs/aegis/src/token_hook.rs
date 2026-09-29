//! Transferring a Token-2022 mint that carries a transfer hook.
//!
//! The SPL crate ships an `onchain::invoke_transfer_checked` helper that does this, but
//! anchor-spl 1.2 depends on the Token-2022 *interface* crate, which does not include it. So the
//! same work is done here, against `spl-transfer-hook-interface` directly.
//!
//! The mechanics are worth understanding rather than treating as boilerplate: Token-2022 does not
//! know which accounts a hook needs. The hook publishes that list in a per-mint validation
//! account, and the *caller* must supply every account on it. Miss one and the transfer fails
//! with an error that points at the token program rather than at the hook.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022::instruction::transfer_checked;
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

/// `transfer_checked`, with any transfer hook on the mint resolved and invoked.
///
/// `hook_accounts` must contain the hook program, the mint's validation account, and every
/// account the validation list resolves to. They are matched by address rather than position,
/// so the order does not matter — only that nothing is missing.
///
/// Safe for a mint with no hook: the helper simply adds nothing.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked_with_hook<'info>(
    token_program: &AccountInfo<'info>,
    source: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    hook_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut instruction = transfer_checked(
        token_program.key,
        source.key,
        mint.key,
        destination.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;

    let mut account_infos = vec![
        source.clone(),
        mint.clone(),
        destination.clone(),
        authority.clone(),
    ];

    if let Some(hook_program_id) = get_transfer_hook_program_id(&mint)? {
        add_extra_accounts_for_execute_cpi(
            &mut instruction,
            &mut account_infos,
            &hook_program_id,
            source,
            mint.clone(),
            destination,
            authority,
            amount,
            hook_accounts,
        )?;
    }

    invoke_signed(&instruction, &account_infos, signer_seeds)?;
    Ok(())
}

/// Reads the hook program from the mint's own extension, so the hook that runs is whichever one
/// the mint actually points at rather than one the caller asserts.
fn get_transfer_hook_program_id(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    use anchor_spl::token_2022::spl_token_2022::extension::{
        transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Mint;

    // A legacy SPL mint has no extensions at all.
    if mint.owner != &anchor_spl::token_2022::ID {
        return Ok(None);
    }

    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint>::unpack(&data)
        .map_err(|_| error!(crate::errors::AegisError::CrwaMintMalformed))?;

    match state.get_extension::<TransferHook>() {
        Ok(hook) => Ok(Option::<Pubkey>::from(hook.program_id)),
        Err(_) => Ok(None),
    }
}
