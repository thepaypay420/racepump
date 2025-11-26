#!/usr/bin/env tsx
/**
 * Standalone test for Jupiter Swap integration
 * Tests buying a token with SOL and sending to a wallet
 * 
 * Usage: tsx scripts/test-jupiter-swap.ts <tokenMint> <tokenSymbol> <recipientWallet>
 */

import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getJupiterQuote, getJupiterSwapTransaction } from '../server/jupiter';
import { getMintDecimals, sendSplTokens } from '../server/solana';
import Decimal from 'decimal.js';
import bs58 from 'bs58';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.log('Usage: tsx scripts/test-jupiter-swap.ts <tokenMint> <tokenSymbol> <recipientWallet>');
    console.log('Example: tsx scripts/test-jupiter-swap.ts EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v USDC 6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u');
    process.exit(1);
  }

  const [tokenMint, tokenSymbol, recipientWallet] = args;
  const solAmount = process.env.TEST_SOL_AMOUNT || process.env.MEME_REWARD_SOL_AMOUNT || '0.02';
  const network = process.env.TEST_NETWORK || 'mainnet';

  console.log('\n🧪 JUPITER SWAP TEST');
  console.log('='.repeat(70));
  console.log(`Network:         ${network.toUpperCase()}`);
  console.log(`Token to Buy:    ${tokenSymbol} (${tokenMint})`);
  console.log(`SOL Amount:      ${solAmount} SOL`);
  console.log(`Recipient:       ${recipientWallet}`);
  console.log('='.repeat(70));
  console.log();

  // Load escrow keypair
  const escrowKey = process.env.ESCROW_PRIVATE_KEY;
  if (!escrowKey) {
    throw new Error('ESCROW_PRIVATE_KEY not found in environment');
  }

  const escrowKeypair = Keypair.fromSecretKey(bs58.decode(escrowKey));
  console.log(`Escrow Wallet:   ${escrowKeypair.publicKey.toString()}`);
  console.log();

  // Connect to Solana mainnet or devnet
  const rpcUrl = network === 'mainnet' 
    ? (process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'https://spring-cold-tree.solana-mainnet.quiknode.pro/24011188359c3607a1ed91ac2ecbfe22b8e39681/')
    : 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  try {
    // Step 1: Get escrow SOL balance
    console.log('📊 Step 1: Checking escrow balance...');
    const balance = await connection.getBalance(escrowKeypair.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;
    console.log(`   Balance: ${balanceSol.toFixed(4)} SOL`);
    
    if (balanceSol < parseFloat(solAmount)) {
      console.log(`   ⚠️  Insufficient balance! Need ${solAmount} SOL, have ${balanceSol.toFixed(4)} SOL`);
      console.log(`   This test will fail at the swap step.`);
    }
    console.log();

    // Step 2: Get Jupiter quote
    console.log('📈 Step 2: Getting Jupiter quote...');
    const lamports = BigInt(new Decimal(solAmount).mul(LAMPORTS_PER_SOL).toDecimalPlaces(0, Decimal.ROUND_DOWN).toString());
    
    const quote = await getJupiterQuote({
      inputMint: SOL_MINT,
      outputMint: tokenMint,
      amount: lamports,
      slippageBps: 500 // 5% slippage
    });

    const tokenAmount = quote.outAmount;
    console.log(`   Quote: ${solAmount} SOL → ${tokenAmount} ${tokenSymbol}`);
    console.log(`   Price Impact: ${quote.priceImpactPct}%`);
    console.log(`   Route: ${quote.routePlan?.length || 0} swaps`);
    console.log();

    // Step 3: Get swap transaction
    console.log('🔄 Step 3: Getting swap transaction from Jupiter...');
    const swapResult = await getJupiterSwapTransaction(
      quote,
      escrowKeypair.publicKey.toString(),
      true, // wrapUnwrapSOL
      undefined // auto priority fee
    );
    console.log(`   Transaction received (${swapResult.swapTransaction.length} chars)`);
    console.log();

    // Step 4: Sign and send swap
    console.log('✍️  Step 4: Signing and sending swap transaction...');
    const swapTxBuffer = Buffer.from(swapResult.swapTransaction, 'base64');
    const swapTx = VersionedTransaction.deserialize(swapTxBuffer);
    swapTx.sign([escrowKeypair]);

    const swapTxSig = await connection.sendTransaction(swapTx, {
      skipPreflight: false,
      maxRetries: 3
    });
    const clusterParam = network === 'devnet' ? '?cluster=devnet' : '';
    console.log(`   Sent: ${swapTxSig}`);
    console.log(`   Solscan: https://solscan.io/tx/${swapTxSig}${clusterParam}`);

    // Wait for confirmation
    console.log('   Waiting for confirmation...');
    const swapConfirmation = await connection.confirmTransaction(swapTxSig, 'confirmed');
    
    if (swapConfirmation.value.err) {
      throw new Error(`Swap failed: ${JSON.stringify(swapConfirmation.value.err)}`);
    }
    console.log('   ✅ Swap confirmed!');
    console.log();

    // Step 5: Send tokens to recipient
    console.log(`💸 Step 5: Sending ${tokenAmount} ${tokenSymbol} to recipient...`);
    const mint = new PublicKey(tokenMint);
    const decimals = await getMintDecimals(mint);
    const tokenAmountBigInt = BigInt(tokenAmount);

    const sendTxSig = await sendSplTokens(
      mint,
      escrowKeypair,
      new PublicKey(recipientWallet),
      tokenAmountBigInt
    );

    console.log(`   Sent: ${sendTxSig}`);
    console.log(`   Solscan: https://solscan.io/tx/${sendTxSig}${clusterParam}`);
    console.log();

    // Convert to human-readable amount
    const humanAmount = new Decimal(tokenAmount).div(new Decimal(10).pow(decimals));

    console.log('🎉 SUCCESS!');
    console.log('='.repeat(70));
    console.log(`✅ Swapped ${solAmount} SOL → ${humanAmount.toString()} ${tokenSymbol}`);
    console.log(`✅ Sent to ${recipientWallet}`);
    console.log(`Swap TX:  https://solscan.io/tx/${swapTxSig}${clusterParam}`);
    console.log(`Send TX:  https://solscan.io/tx/${sendTxSig}${clusterParam}`);
    console.log('='.repeat(70));

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exit(1);
  }
}

main().catch(console.error);
