import Decimal from "decimal.js";
import { PublicKey, Transaction, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Race, Prediction } from "@shared/schema";
import { getDb } from "./db";
import { serverKeypair, connection, sendSplTokens, getMintDecimals } from "./solana";
import { getJupiterQuote, getJupiterSwapTransaction } from "./jupiter";

const SOL_MINT = 'So11111111111111111111111111111111111111112'; // Wrapped SOL

/**
 * Check if meme rewards are enabled via environment variables
 */
export function isMemeRewardEnabled(): boolean {
  const enabled = process.env.ENABLE_MEME_REWARD;
  return enabled === 'true' || enabled === '1';
}

/**
 * Get the SOL amount to use for meme reward swaps
 */
export function getMemeRewardSolAmount(): Decimal {
  const amount = process.env.MEME_REWARD_SOL_AMOUNT;
  if (!amount) {
    return new Decimal('0.1'); // Default: 0.1 SOL
  }
  try {
    return new Decimal(amount);
  } catch {
    console.warn(`[meme-reward] Invalid MEME_REWARD_SOL_AMOUNT: ${amount}, using default 0.1 SOL`);
    return new Decimal('0.1');
  }
}

/**
 * Select a random bettor from the race (excluding escrow wallet)
 * Returns undefined if only escrow wallet placed bets
 */
export function selectRandomBettor(bets: Prediction[]): string | undefined {
  const escrowWallet = serverKeypair.publicKey.toString();
  
  // Get unique wallets (excluding escrow)
  const eligibleWallets = new Set<string>();
  bets.forEach(bet => {
    if (bet.wallet !== escrowWallet) {
      eligibleWallets.add(bet.wallet);
    }
  });

  if (eligibleWallets.size === 0) {
    console.log('[meme-reward] No eligible bettors (only escrow placed bets)');
    return undefined;
  }

  // Convert to array and pick random
  const wallets = Array.from(eligibleWallets);
  const randomIndex = Math.floor(Math.random() * wallets.length);
  const selected = wallets[randomIndex];
  
  console.log(`[meme-reward] Selected random bettor: ${selected} (from ${wallets.length} eligible wallets)`);
  return selected;
}

/**
 * Execute meme reward: buy winning coin with SOL and send to random bettor
 * Returns reward details if successful, undefined if failed or not applicable
 */
export async function executeMemeReward(
  race: Race,
  bets: Prediction[]
): Promise<{
  recipient: string;
  tokenAmount: string;
  solSpent: string;
  txSig: string;
  coinSymbol: string;
} | undefined> {
  
  try {
    // Idempotency check - if race already has meme reward data, skip
    if ((race as any).memeRewardRecipient || (race as any).memeRewardTxSig) {
      console.log(`[meme-reward] ⏭️  Race ${race.id} already has meme reward executed, skipping`);
      return undefined;
    }
    
    // Check if feature is enabled
    if (!isMemeRewardEnabled()) {
      console.log('[meme-reward] Feature disabled (ENABLE_MEME_REWARD not true)');
      return undefined;
    }

    // Check if race has a winner
    if (race.winnerIndex === undefined || race.winnerIndex === null) {
      console.log('[meme-reward] No winner index, skipping meme reward');
      return undefined;
    }

    // Get winning runner
    const winningRunner = race.runners[race.winnerIndex];
    if (!winningRunner) {
      console.log('[meme-reward] Winner index out of bounds, skipping meme reward');
      return undefined;
    }

    // Select random bettor
    const recipient = selectRandomBettor(bets);
    if (!recipient) {
      console.log('[meme-reward] No eligible bettors for meme reward');
      return undefined;
    }

    // Get SOL amount to swap
    const solAmount = getMemeRewardSolAmount();
    const lamports = BigInt(solAmount.mul(LAMPORTS_PER_SOL).toDecimalPlaces(0, Decimal.ROUND_DOWN).toString());

    console.log(`[meme-reward] 🪙 Executing meme reward for race ${race.id}`);
    console.log(`[meme-reward]   Winning coin: ${winningRunner.symbol} (${winningRunner.mint})`);
    console.log(`[meme-reward]   SOL to swap: ${solAmount.toString()}`);
    console.log(`[meme-reward]   Recipient: ${recipient}`);

    // Step 1: Get Jupiter quote
    console.log('[meme-reward] Step 1: Getting Jupiter quote...');
    const quote = await getJupiterQuote({
      inputMint: SOL_MINT,
      outputMint: winningRunner.mint,
      amount: lamports,
      slippageBps: 500 // 5% slippage tolerance for meme coins
    });

    const tokenAmount = quote.outAmount;
    console.log(`[meme-reward] Quote received: ${solAmount.toString()} SOL -> ${tokenAmount} ${winningRunner.symbol}`);

    // Step 2: Get swap transaction
    console.log('[meme-reward] Step 2: Getting swap transaction...');
    const swapResult = await getJupiterSwapTransaction(
      quote,
      serverKeypair.publicKey.toString(),
      true, // Wrap/unwrap SOL
      undefined // Use auto priority fee
    );

    // Step 3: Sign and send swap transaction
    console.log('[meme-reward] Step 3: Signing and sending swap transaction...');
    const swapTxBuffer = Buffer.from(swapResult.swapTransaction, 'base64');
    const swapTx = VersionedTransaction.deserialize(swapTxBuffer);
    
    // Sign the transaction
    swapTx.sign([serverKeypair]);

    // Send and confirm
    const swapTxSig = await connection.sendTransaction(swapTx, {
      skipPreflight: false,
      maxRetries: 3
    });

    console.log(`[meme-reward] Swap transaction sent: ${swapTxSig}`);

    // Wait for confirmation
    const swapConfirmation = await connection.confirmTransaction(swapTxSig, 'confirmed');
    if (swapConfirmation.value.err) {
      throw new Error(`Swap transaction failed: ${JSON.stringify(swapConfirmation.value.err)}`);
    }

    console.log(`[meme-reward] ✅ Swap confirmed: ${swapTxSig}`);

    // Step 4: Send tokens to random bettor
    console.log(`[meme-reward] Step 4: Sending ${tokenAmount} ${winningRunner.symbol} to ${recipient}...`);
    
    const tokenMint = new PublicKey(winningRunner.mint);
    const decimals = await getMintDecimals(tokenMint);
    const tokenAmountBigInt = BigInt(tokenAmount);

    const sendTxSig = await sendSplTokens(
      tokenMint,
      serverKeypair,
      new PublicKey(recipient),
      tokenAmountBigInt
    );

    console.log(`[meme-reward] ✅ Tokens sent: ${sendTxSig}`);
    console.log(`[meme-reward] 🎉 Meme reward complete!`);
    console.log(`[meme-reward]   Swap TX: ${swapTxSig}`);
    console.log(`[meme-reward]   Send TX: ${sendTxSig}`);

    // Convert token amount from smallest units to decimal
    let tokenAmountDecimal: string;
    try {
      const decimal = new Decimal(tokenAmount).div(new Decimal(10).pow(decimals));
      tokenAmountDecimal = decimal.toString();
    } catch (conversionError) {
      console.warn(`[meme-reward] ⚠️ Decimal conversion failed, using raw amount:`, conversionError);
      tokenAmountDecimal = tokenAmount;
    }

    return {
      recipient,
      tokenAmount: tokenAmountDecimal,
      solSpent: solAmount.toString(),
      txSig: sendTxSig,
      coinSymbol: winningRunner.symbol
    };

  } catch (error) {
    console.error('[meme-reward] ❌ Execution failed:', error);
    // Don't throw - meme reward failure shouldn't break settlement
    return undefined;
  }
}
