use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};
use anchor_lang::system_program;
use anchor_spl::token_interface::{self, TokenAccount, TokenInterface, TransferChecked};
use anchor_spl::token::ID as TOKEN_PROGRAM_ID;
use anchor_spl::token_2022::ID as TOKEN_2022_PROGRAM_ID;
use core::slice::Iter;

declare_id!("Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk");

const CONFIG_SEED: &[u8] = b"raceswap-config";
const AUTHORITY_SEED: &[u8] = b"raceswap-authority";
const FEE_DENOMINATOR: u128 = 10_000;
#[program]
pub mod raceswap {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        params: InitializeConfigParams,
    ) -> Result<()> {
        require!(
            params.reflection_fee_bps <= 1_000,
            RaceswapError::InvalidFeeConfig
        );
        require!(
            params.treasury_fee_bps <= 1_000,
            RaceswapError::InvalidFeeConfig
        );
        require!(
            (params.reflection_fee_bps as u32 + params.treasury_fee_bps as u32)
                < FEE_DENOMINATOR as u32,
            RaceswapError::InvalidFeeConfig
        );

        let config = &mut ctx.accounts.config;
        config.authority = params.authority;
        config.treasury_wallet = params.treasury_wallet;
        config.reflection_fee_bps = params.reflection_fee_bps;
        config.treasury_fee_bps = params.treasury_fee_bps;
        config.bump = ctx.bumps.config;

        let (_, authority_bump) =
            Pubkey::find_program_address(&[AUTHORITY_SEED, config.key().as_ref()], ctx.program_id);
        config.authority_bump = authority_bump;

        emit!(ConfigUpdated {
            authority: config.authority,
            treasury_wallet: config.treasury_wallet,
            reflection_fee_bps: config.reflection_fee_bps,
            treasury_fee_bps: config.treasury_fee_bps,
        });

        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            config.authority,
            RaceswapError::Unauthorized
        );

        if let Some(new_authority) = params.new_authority {
            config.authority = new_authority;
        }

        if let Some(new_treasury_wallet) = params.treasury_wallet {
            config.treasury_wallet = new_treasury_wallet;
        }

        if let Some(reflection_fee_bps) = params.reflection_fee_bps {
            require!(reflection_fee_bps <= 1_000, RaceswapError::InvalidFeeConfig);
            config.reflection_fee_bps = reflection_fee_bps;
        }

        if let Some(treasury_fee_bps) = params.treasury_fee_bps {
            require!(treasury_fee_bps <= 1_000, RaceswapError::InvalidFeeConfig);
            config.treasury_fee_bps = treasury_fee_bps;
        }

        require!(
            (config.reflection_fee_bps as u32 + config.treasury_fee_bps as u32)
                < FEE_DENOMINATOR as u32,
            RaceswapError::InvalidFeeConfig
        );

        emit!(ConfigUpdated {
            authority: config.authority,
            treasury_wallet: config.treasury_wallet,
            reflection_fee_bps: config.reflection_fee_bps,
            treasury_fee_bps: config.treasury_fee_bps,
        });

        Ok(())
    }

    pub fn execute_raceswap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteRaceswap<'info>>,
        params: ExecuteRaceswapParams,
    ) -> Result<()> {
        msg!("ExecuteRaceswap: total_in={}, min_main={}, min_refl={}, disable_refl={}", 
            params.total_input_amount,
            params.min_main_out,
            params.min_reflection_out,
            params.disable_reflection
        );

        // DEBUG: Log account details to debug InvalidAccountData issues
        msg!(">>> RACESWAP DEBUG: input_mint = {}", ctx.accounts.input_mint.key());
        msg!(">>> RACESWAP DEBUG: input_mint.owner = {}", ctx.accounts.input_mint.to_account_info().owner);
        msg!(
            ">>> RACESWAP DEBUG: token_program = {}",
            ctx.accounts.input_token_program.key()
        );
        msg!(
            ">>> RACESWAP DEBUG: user_input = {}",
            ctx.accounts.user_input.key()
        );

        // Runtime check for input mint ownership to support both Token and Token2022
        if *ctx.accounts.input_mint.to_account_info().owner != ctx.accounts.input_token_program.key() {
             msg!("Input mint owner mismatch! Expected {}", ctx.accounts.input_token_program.key());
             return err!(RaceswapError::InvalidInputMintOwner);
        }

        // Manual deserialization of input_mint to avoid InterfaceAccount strictness
        // We strictly read the byte layout of an SPL Token Mint to get decimals.
        // Layout: [MintAuthority(36)] [Supply(8)] [Decimals(1)] ...
        let input_mint_info = ctx.accounts.input_mint.to_account_info();
        let input_mint_data = input_mint_info.try_borrow_data()?;
        
        if input_mint_data.len() < 82 {
             return err!(RaceswapError::InvalidInputMint);
        }
        
        let decimals = input_mint_data[44];

        require!(params.total_input_amount > 0, RaceswapError::InvalidAmount);

        let input_mint_key = params.input_mint;
        let main_output_mint_key = params.main_output_mint;
        let reflection_mint_key = params.reflection_mint;

        let config = &ctx.accounts.config;
        let config_key = config.key();
        let authority_signer_seeds: [&[u8]; 3] = [
            AUTHORITY_SEED,
            config_key.as_ref(),
            &[config.authority_bump],
        ];
        
        // Derive swap_authority PDA (not included in named accounts to prevent auto-signer privilege)
        let (swap_authority_derived, _bump) = Pubkey::find_program_address(
            &[AUTHORITY_SEED, config_key.as_ref()],
            ctx.program_id
        );
        
        // Verify input_vault is owned by swap_authority
        require_keys_eq!(
            ctx.accounts.input_vault.owner,
            swap_authority_derived,
            RaceswapError::InvalidVaultOwner
        );
        
        let total_fee_bps = config.reflection_fee_bps as u128 + config.treasury_fee_bps as u128;
        require!(
            total_fee_bps < FEE_DENOMINATOR,
            RaceswapError::InvalidFeeConfig
        );

        let reflection_enabled = !params.disable_reflection;
        let mut reflection_required = reflection_enabled;

        require_keys_eq!(
            ctx.accounts.user_main_destination.mint,
            main_output_mint_key,
            RaceswapError::InvalidMainAccount
        );
        require_keys_eq!(
            ctx.accounts.user_main_destination.owner,
            ctx.accounts.user.key(),
            RaceswapError::InvalidMainAccount
        );

        let main_dest_info = ctx.accounts.user_main_destination.to_account_info();
        msg!("Output Main: key={}, owner={}, mint={}", 
            main_dest_info.key(), 
            main_dest_info.owner, 
            ctx.accounts.user_main_destination.mint
        );
        require!(
            *main_dest_info.owner == TOKEN_PROGRAM_ID || *main_dest_info.owner == TOKEN_2022_PROGRAM_ID,
            RaceswapError::InvalidMainAccount
        );

        require_keys_eq!(
            ctx.accounts.input_vault.mint,
            input_mint_key,
            RaceswapError::InvalidVaultMint
        );

        require_keys_eq!(
            ctx.accounts.user_input.mint,
            input_mint_key,
            RaceswapError::InvalidUserSource
        );
        require_keys_eq!(
            ctx.accounts.user_input.owner,
            ctx.accounts.user.key(),
            RaceswapError::InvalidUserSource
        );

        let reflection_amount = if !reflection_enabled {
            0u64
        } else {
            ((params.total_input_amount as u128)
                .checked_mul(config.reflection_fee_bps as u128)
                .ok_or(RaceswapError::MathOverflow)?)
            .checked_div(FEE_DENOMINATOR)
            .ok_or(RaceswapError::MathOverflow)? as u64
        };

        if reflection_amount == 0 {
            reflection_required = false;
        }

        if reflection_required {
            require_keys_eq!(
                ctx.accounts.user_reflection_destination.mint,
                reflection_mint_key,
                RaceswapError::InvalidReflectionAccount
            );
            require_keys_eq!(
                ctx.accounts.user_reflection_destination.owner,
                ctx.accounts.user.key(),
                RaceswapError::InvalidReflectionAccount
            );

            let refl_dest_info = ctx.accounts.user_reflection_destination.to_account_info();
            msg!("Output Refl: key={}, owner={}, mint={}", 
                refl_dest_info.key(), 
                refl_dest_info.owner, 
                ctx.accounts.user_reflection_destination.mint
            );
            require!(
                *refl_dest_info.owner == TOKEN_PROGRAM_ID || *refl_dest_info.owner == TOKEN_2022_PROGRAM_ID,
                RaceswapError::InvalidReflectionAccount
            );
        }

        // Calculate treasury fee in SOL
        let treasury_fee_lamports = (params.total_input_amount as u64)
            .checked_mul(20)           // 0.2%
            .unwrap()
            .checked_div(10_000)
            .unwrap();

        params
            .total_input_amount
            .checked_sub(reflection_amount)
            .ok_or(RaceswapError::MathOverflow)?;

        // Transfer total input from user to vault
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.input_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_input.to_account_info(),
                    mint: ctx.accounts.input_mint.to_account_info(),
                    to: ctx.accounts.input_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            params.total_input_amount,
            decimals,
        )?;

        // Pay treasury fee in SOL
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.treasury_fee_destination.to_account_info(),
                },
            ),
            treasury_fee_lamports,
        )?;

        // Reflection swap leg
        let mut remaining_iter = ctx.remaining_accounts.iter();

        let mut reflection_received: u64 = 0;

        if reflection_required {
            let reflection_leg = params
                .reflection_leg
                .as_ref()
                .ok_or(RaceswapError::MissingReflectionLeg)?;

            let before = ctx.accounts.user_reflection_destination.amount;
            perform_jupiter_swap(
                reflection_leg,
                ctx.accounts.jupiter_program.to_account_info(),
                &mut remaining_iter,
                &authority_signer_seeds,
                &swap_authority_derived,
            )?;
            ctx.accounts.user_reflection_destination.reload()?;
            let after = ctx.accounts.user_reflection_destination.amount;
            let delta = after
                .checked_sub(before)
                .ok_or(RaceswapError::InvalidReflectionAccounting)?;
            require!(
                delta >= params.min_reflection_out,
                RaceswapError::ReflectionBelowMinOut
            );
            require!(delta > 0, RaceswapError::ReflectionBelowMinOut);
            reflection_received = delta;
        } else {
            require!(
                params.reflection_leg.is_none(),
                RaceswapError::UnexpectedReflectionLeg
            );
        }

        // Main swap leg
        let main_leg = params.main_leg.ok_or(RaceswapError::MissingMainLeg)?;
        let main_before = ctx.accounts.user_main_destination.amount;
        perform_jupiter_swap(
            &main_leg,
            ctx.accounts.jupiter_program.to_account_info(),
            &mut remaining_iter,
            &authority_signer_seeds,
            &swap_authority_derived,
        )?;
        ctx.accounts.user_main_destination.reload()?;
        let main_after = ctx.accounts.user_main_destination.amount;
        let main_delta = main_after
            .checked_sub(main_before)
            .ok_or(RaceswapError::InvalidMainAccounting)?;
        require!(
            main_delta >= params.min_main_out,
            RaceswapError::MainBelowMinOut
        );

        // Ensure no trailing accounts remain unused
        require!(
            remaining_iter.next().is_none(),
            RaceswapError::AccountMismatch
        );

        emit!(SwapExecuted {
            user: ctx.accounts.user.key(),
            input_mint: input_mint_key,
            main_output_mint: main_output_mint_key,
            reflection_output_mint: reflection_mint_key,
            total_in: params.total_input_amount,
            main_amount: main_delta,
            reflection_amount: reflection_received,
            treasury_amount: treasury_fee_lamports,
        });

        Ok(())
    }
}

fn perform_jupiter_swap<'info>(
    payload: &SerializedInstruction,
    jupiter_program: AccountInfo<'info>,
    remaining_iter: &mut Iter<AccountInfo<'info>>,
    _authority_seeds: &[&[u8]],
    swap_authority_key: &Pubkey,
) -> Result<()> {
    let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(payload.accounts_len as usize + 1);
    let mut metas: Vec<AccountMeta> = Vec::with_capacity(payload.accounts_len as usize);
    infos.push(jupiter_program.clone());

    let mut consumed = 0usize;

    while consumed < payload.accounts_len as usize {
        let account = remaining_iter
            .next()
            .ok_or(RaceswapError::AccountMismatch)?;
        
        // Use Jupiter's flags but FORCE swap_authority to NOT be a signer
        // Our PDA provides signature authority for the wrapper instruction only
        let is_writable = payload.is_writable.get(consumed).copied().unwrap_or(account.is_writable);
        let mut is_signer = payload.is_signer.get(consumed).copied().unwrap_or(false);
        
        // CRITICAL FIX: Force swap_authority PDA to never be a signer in Jupiter's CPI
        // Even if Jupiter's quote marks it as signer, we don't want privilege escalation
        if account.key == swap_authority_key {
            msg!(">>> FOUND SWAP_AUTHORITY in remaining_accounts at index {}, forcing is_signer=false (was {})", consumed, is_signer);
            is_signer = false;
        } else if is_signer {
            msg!(">>> Account {} at index {} has is_signer=true (not swap_authority)", account.key, consumed);
        }
        
        metas.push(AccountMeta {
            pubkey: *account.key,
            is_signer,
            is_writable,
        });
        infos.push(account.clone());
        consumed += 1;
    }

    let ix = Instruction {
        program_id: jupiter_program.key(),
        accounts: metas,
        data: payload.data.clone(),
    };

    // EXPERIMENTAL FIX: Try invoke_signed with NO signer seeds to prevent privilege escalation
    // This tells Solana we're making a CPI but NOT using PDA signing for THIS specific call
    // The empty slice means "no PDAs are signing for this CPI"
    invoke_signed(&ix, &infos, &[]).map_err(|_| RaceswapError::SwapCpiFailed.into())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [CONFIG_SEED],
        bump,
        space = 8 + RaceswapConfig::LEN
    )]
    pub config: Account<'info, RaceswapConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RaceswapConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(params: ExecuteRaceswapParams)]
pub struct ExecuteRaceswap<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RaceswapConfig>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = input_mint.key() == params.input_mint
    )]
    /// CHECK: Manually validated in handler to avoid strict InterfaceAccount checks
    pub input_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        owner = input_token_program.key()
    )]
    pub user_input: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_main_destination: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_reflection_destination: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Known treasury wallet - hard-coded and verified off-chain
    #[account(
        mut,
        address = pubkey!("Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L")
    )]
    pub treasury_wallet: UncheckedAccount<'info>,

    #[account(mut)]
    pub treasury_fee_destination: SystemAccount<'info>,

    #[account(
        mut,
        owner = input_token_program.key()
    )]
    pub input_vault: InterfaceAccount<'info, TokenAccount>,

    // NOTE: swap_authority is NOT included as a named account to prevent Anchor from automatically
    // setting is_signer=true during PDA validation. It must be passed in remaining_accounts instead.
    // This ensures Jupiter's CPI receives AccountInfo with is_signer=false, preventing error 0x1789.

    // Renamed from `token_program` to `input_token_program` to prevent Anchor from automatically 
    // enforcing this program as the owner for all InterfaceAccount<'info, TokenAccount> fields.
    // This allows output accounts (main/reflection) to be owned by a different token program (e.g. Token2022)
    // than the input token program. We explicitly verify output account ownership in the handler.
    pub input_token_program: Interface<'info, TokenInterface>,

    /// CHECK: Jupiter v6 Aggregator - current mainnet program
    #[account(address = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"))]
    pub jupiter_program: UncheckedAccount<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeConfigParams {
    pub authority: Pubkey,
    pub treasury_wallet: Pubkey,
    pub reflection_fee_bps: u16,
    pub treasury_fee_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct UpdateConfigParams {
    pub new_authority: Option<Pubkey>,
    pub treasury_wallet: Option<Pubkey>,
    pub reflection_fee_bps: Option<u16>,
    pub treasury_fee_bps: Option<u16>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SerializedInstruction {
    pub accounts_len: u16,
    pub data: Vec<u8>,
    pub is_writable: Vec<bool>,
    pub is_signer: Vec<bool>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteRaceswapParams {
    pub input_mint: Pubkey,
    pub main_output_mint: Pubkey,
    pub reflection_mint: Pubkey,
    pub total_input_amount: u64,
    pub min_main_out: u64,
    pub min_reflection_out: u64,
    pub disable_reflection: bool,
    pub main_leg: Option<SerializedInstruction>,
    pub reflection_leg: Option<SerializedInstruction>,
}

#[account]
pub struct RaceswapConfig {
    pub authority: Pubkey,
    pub treasury_wallet: Pubkey,
    pub reflection_fee_bps: u16,
    pub treasury_fee_bps: u16,
    pub bump: u8,
    pub authority_bump: u8,
}

impl RaceswapConfig {
    pub const LEN: usize = 32 + 32 + 2 + 2 + 1 + 1;
}

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
    pub treasury_wallet: Pubkey,
    pub reflection_fee_bps: u16,
    pub treasury_fee_bps: u16,
}

#[event]
pub struct SwapExecuted {
    pub user: Pubkey,
    pub input_mint: Pubkey,
    pub main_output_mint: Pubkey,
    pub reflection_output_mint: Pubkey,
    pub total_in: u64,
    pub main_amount: u64,
    pub reflection_amount: u64,
    pub treasury_amount: u64,
}

#[error_code]
pub enum RaceswapError {
    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Reflection leg required")]
    MissingReflectionLeg,
    #[msg("Main leg required")]
    MissingMainLeg,
    #[msg("Reflection leg unexpected when disabled or dusted")]
    UnexpectedReflectionLeg,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid reflection token account")]
    InvalidReflectionAccount,
    #[msg("Invalid main token account")]
    InvalidMainAccount,
    #[msg("Invalid vault mint")]
    InvalidVaultMint,
    #[msg("Invalid vault owner - must be swap_authority PDA")]
    InvalidVaultOwner,
    #[msg("Invalid user source account")]
    InvalidUserSource,
    #[msg("Reflection amount below min")]
    ReflectionBelowMinOut,
    #[msg("Main amount below min")]
    MainBelowMinOut,
    #[msg("Swap CPI failed")]
    SwapCpiFailed,
    #[msg("Account mismatch for serialized instruction")]
    AccountMismatch,
    #[msg("Invalid reflection accounting delta")]
    InvalidReflectionAccounting,
    #[msg("Invalid main accounting delta")]
    InvalidMainAccounting,
    #[msg("Reflection split is zero but instructions provided")]
    InvalidReflectionSplit,
    #[msg("Bump missing")]
    BumpMissing,
    #[msg("Invalid treasury token account or mint")]
    InvalidTreasuryAccount,
    #[msg("Input mint owner does not match provided token program")]
    InvalidInputMintOwner,
    #[msg("Invalid input mint")]
    InvalidInputMint,
}
