/**
 * Raceswap V3 - Index-Based Non-Custodial Swap Architecture
 * 
 * KEY IMPROVEMENT: Uses account INDICES instead of full metadata
 * - V2: 21 accounts × 34 bytes = 714 bytes
 * - V3: 21 accounts × 1 byte = 21 bytes (97% reduction!)
 * 
 * Architecture:
 * - User owns all tokens throughout swap (non-custodial)
 * - User signs directly for Jupiter (no PDA conflicts)
 * - Simple 0.2% SOL fee collected via system transfer
 * - Accounts passed as indices into remaining_accounts array
 */

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program::invoke,
};

declare_id!("Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk");

#[program]
pub mod raceswap_v3 {
    use super::*;

    pub fn execute_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
        params: ExecuteSwapParams
    ) -> Result<()> {
        msg!("Raceswap V3: Starting swap");
        msg!("Amount: {} lamports", params.amount);
        msg!("Min out: {}", params.min_out);
        msg!("Jupiter accounts: {} (index+writable pairs)", params.jupiter_account_infos.len());

        // 1. Collect 0.2% SOL fee to treasury
        let treasury_fee_lamports = (params.amount as u128)
            .checked_mul(20)
            .unwrap()
            .checked_div(10_000)
            .unwrap() as u64;

        if treasury_fee_lamports > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                treasury_fee_lamports,
            )?;
            msg!("Treasury fee paid: {} lamports", treasury_fee_lamports);
        }

        // 2. Reconstruct Jupiter AccountMeta from account info structs
        let jupiter_accounts: Vec<AccountMeta> = params.jupiter_account_infos
            .iter()
            .map(|info| {
                let acc_info = &ctx.remaining_accounts[info.index as usize];
                // CRITICAL: Only use the permissions we actually have!
                // Ignore Jupiter's desired writable flag - use only what the transaction gave us
                AccountMeta {
                    pubkey: *acc_info.key,
                    is_signer: acc_info.is_signer,
                    is_writable: acc_info.is_writable,  // Use actual permission only!
                }
            })
            .collect();

        msg!("Reconstructed {} AccountMetas from indices", jupiter_accounts.len());

        // 3. Execute Jupiter swap via CPI
        let jupiter_ix = Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: jupiter_accounts,
            data: params.jupiter_data,
        };

        // Collect all account infos for the CPI
        let mut account_infos: Vec<AccountInfo<'info>> = vec![ctx.accounts.jupiter_program.to_account_info()];
        for acc in ctx.remaining_accounts.iter() {
            account_infos.push(acc.clone());
        }

        msg!("Invoking Jupiter with {} accounts", account_infos.len());
        invoke(&jupiter_ix, &account_infos)?;

        msg!("V3 swap completed successfully!");
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
pub struct JupiterAccountInfo {
    pub index: u8,         // Index into remaining_accounts (1 byte)
    pub is_writable: bool, // Whether Jupiter wants it writable (1 byte)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteSwapParams {
    pub amount: u64,
    pub min_out: u64,
    pub jupiter_account_infos: Vec<JupiterAccountInfo>,  // 2 bytes per account (94% savings!)
    pub jupiter_data: Vec<u8>,
}
