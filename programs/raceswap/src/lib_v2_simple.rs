use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use anchor_lang::system_program;

declare_id!("Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk");

/// Simplified Raceswap - Non-custodial Jupiter wrapper
/// Key design: USER signs for Jupiter, not a PDA
#[program]
pub mod raceswap {
    use super::*;

    /// Execute a Jupiter swap with treasury fee
    /// This is the SIMPLEST working version - single leg only
    pub fn execute_swap(ctx: Context<ExecuteSwap>, params: ExecuteSwapParams) -> Result<()> {
        msg!("ExecuteSwap: amount={}, min_out={}", params.amount, params.min_out);

        // 1. Take treasury fee in SOL (0.2% = 20 bps)
        let treasury_fee_lamports = (params.amount as u64)
            .checked_mul(20)
            .unwrap()
            .checked_div(10_000)
            .unwrap();

        if treasury_fee_lamports > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                treasury_fee_lamports,
            )?;
            msg!("Treasury fee paid: {} lamports", treasury_fee_lamports);
        }

        // 2. Execute Jupiter swap via CPI
        // USER is the signer - their signer privilege passes through automatically
        // No PDA signing needed!
        let jupiter_ix = Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: params.jupiter_accounts,
            data: params.jupiter_data,
        };

        // Collect all account infos for the CPI
        let mut account_infos = vec![ctx.accounts.jupiter_program.to_account_info()];
        account_infos.extend(ctx.remaining_accounts.iter().map(|a| a.clone()));

        msg!("Invoking Jupiter with {} accounts", account_infos.len());
        invoke(&jupiter_ix, &account_infos)?;

        msg!("Swap completed successfully!");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Treasury wallet - receives SOL fees
    #[account(
        mut,
        address = pubkey!("Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L")
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Jupiter v6 program
    #[account(address = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"))]
    pub jupiter_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    // remaining_accounts contains all Jupiter accounts
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteSwapParams {
    pub amount: u64,
    pub min_out: u64,
    pub jupiter_accounts: Vec<AccountMeta>,
    pub jupiter_data: Vec<u8>,
}

#[error_code]
pub enum RaceswapError {
    #[msg("Invalid amount")]
    InvalidAmount,
}
