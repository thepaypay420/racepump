use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use anchor_lang::system_program;

declare_id!("Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk");

#[program]
pub mod raceswap {
    use super::*;

    pub fn execute_swap<'info>(ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>, params: ExecuteSwapParams) -> Result<()> {
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

        // 2. Convert serializable account metas to AccountMeta
        let jupiter_accounts: Vec<AccountMeta> = params.jupiter_accounts
            .iter()
            .map(|acc| AccountMeta {
                pubkey: acc.pubkey,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            })
            .collect();

        // 3. Execute Jupiter swap via CPI
        let jupiter_ix = Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: jupiter_accounts,
            data: params.jupiter_data,
        };

        // Collect all account infos for the CPI
        let mut account_infos = vec![ctx.accounts.jupiter_program.to_account_info()];
        account_infos.extend(ctx.remaining_accounts.iter().cloned());

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
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteSwapParams {
    pub amount: u64,
    pub min_out: u64,
    pub jupiter_accounts: Vec<SerializableAccountMeta>,
    pub jupiter_data: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SerializableAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[error_code]
pub enum RaceswapError {
    #[msg("Invalid amount")]
    InvalidAmount,
}
