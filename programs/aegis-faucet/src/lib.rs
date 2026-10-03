//! Aegis devnet faucet.
//!
//! Test networks have no real stablecoins worth testing with: Circle's devnet faucet pays out 20
//! USDC every two hours, less than a single test purchase. This program lets anyone mint test
//! tokens for themselves, so a judge or tester can try a full sale without asking anyone.
//!
//! It is not part of the protocol. The Aegis program never calls it, and it is only ever deployed
//! to devnet.
//!
//! How it works: a token's mint authority is handed to this program's PDA, after which `drip`
//! mints it to whoever asks, up to a per-claim cap. Any mint whose authority is that PDA works,
//! so one deployment serves every test token. A mint whose authority is anything else is refused
//! by the token program itself, because only the authority can sign a mint.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface};

declare_id!("GYsrUAn1S12UCNG4a212HYyvvhQiUdyva1PJbyaZdcLU");

/// Seed of the PDA every faucet mint hands its mint authority to.
pub const FAUCET_SEED: &[u8] = b"faucet";

/// Most whole tokens one claim may mint. Large enough to fill a realistic test sale in one go,
/// small enough that a claim is a deliberate act rather than an unbounded tap.
pub const MAX_WHOLE_TOKENS_PER_CLAIM: u64 = 10_000;

#[program]
pub mod aegis_faucet {
    use super::*;

    /// Mints `amount` (in the token's smallest units) to `destination`.
    ///
    /// Permissionless on purpose: these are test tokens with no value. The cap only bounds a
    /// single claim.
    pub fn drip(ctx: Context<Drip>, amount: u64) -> Result<()> {
        require!(amount > 0, FaucetError::ZeroAmount);
        let cap = 10u64
            .checked_pow(ctx.accounts.mint.decimals as u32)
            .and_then(|unit| unit.checked_mul(MAX_WHOLE_TOKENS_PER_CLAIM))
            .ok_or(FaucetError::MathOverflow)?;
        require!(amount <= cap, FaucetError::AboveClaimCap);

        let seeds: &[&[&[u8]]] = &[&[FAUCET_SEED, &[ctx.bumps.faucet_authority]]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.faucet_authority.to_account_info(),
                },
                seeds,
            ),
            amount,
        )
    }
}

#[derive(Accounts)]
pub struct Drip<'info> {
    #[account(
        mut,
        mint::authority = faucet_authority,
        mint::token_program = token_program,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: a signer-only PDA; it holds no data.
    #[account(seeds = [FAUCET_SEED], bump)]
    pub faucet_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum FaucetError {
    #[msg("Ask for more than zero.")]
    ZeroAmount,
    #[msg("That is more than one claim allows (10,000 tokens). Claim again for more.")]
    AboveClaimCap,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}
