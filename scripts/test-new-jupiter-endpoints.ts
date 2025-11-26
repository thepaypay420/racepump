#!/usr/bin/env tsx
/**
 * Test script to verify new Jupiter API endpoints
 * Tests quote and swap endpoints with a small SOL amount
 */

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getJupiterQuote, getJupiterSwapTransaction } from '../server/jupiter';
import bs58 from 'bs58';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function testJupiterEndpoints() {
  console.log('🧪 Testing Jupiter API Endpoints');
  console.log('='.repeat(70));
  
  // Load escrow keypair
  const escrowPrivateKey = process.env.ESCROW_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  if (!escrowPrivateKey) {
    throw new Error('ESCROW_PRIVATE_KEY or SOLANA_PRIVATE_KEY not set');
  }
  
  const escrowKeypair = Keypair.fromSecretKey(bs58.decode(escrowPrivateKey));
  console.log(`\n✅ Escrow wallet: ${escrowKeypair.publicKey.toString()}`);
  
  // Connect to Solana
  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_URL ||
    'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  const balance = await connection.getBalance(escrowKeypair.publicKey);
  console.log(`💰 Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  
  if (balance < 20_000_000) {
    throw new Error('Insufficient balance for test (need at least 0.02 SOL)');
  }
  
  // Test token - use a popular pump.fun token
  const testTokenMint = '9Eufcq8yqukb4A9eUTAXrRpzB7aKTdAuUnqe75ttpump'; // Pumpkin
  const testAmount = BigInt(10_000_000); // 0.01 SOL
  
  console.log(`\n🎯 Test Parameters:`);
  console.log(`   Input: ${testAmount.toString()} lamports (0.01 SOL)`);
  console.log(`   Output Token: ${testTokenMint}`);
  console.log(`   Slippage: 5% (500 bps)`);
  
  try {
    // Step 1: Get Quote
    console.log('\n📊 Step 1: Getting Jupiter Quote...');
    console.log('-'.repeat(70));
    
    const quote = await getJupiterQuote({
      inputMint: SOL_MINT,
      outputMint: testTokenMint,
      amount: testAmount,
      slippageBps: 500
    });
    
    console.log(`\n✅ Quote Successful!`);
    console.log(`   Input Amount: ${quote.inAmount} lamports`);
    console.log(`   Output Amount: ${quote.outAmount} tokens`);
    console.log(`   Price Impact: ${quote.priceImpactPct}%`);
    console.log(`   Swap Mode: ${quote.swapMode}`);
    
    // Step 2: Get Swap Transaction (but don't send it)
    console.log('\n📝 Step 2: Getting Swap Transaction...');
    console.log('-'.repeat(70));
    
    const swapResult = await getJupiterSwapTransaction(
      quote,
      escrowKeypair.publicKey.toString(),
      true,
      undefined
    );
    
    console.log(`\n✅ Swap Transaction Received!`);
    console.log(`   Transaction Size: ${swapResult.swapTransaction.length} bytes (base64)`);
    console.log(`   Last Valid Block Height: ${swapResult.lastValidBlockHeight}`);
    
    // Deserialize to verify it's valid
    const txBuf = Buffer.from(swapResult.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    console.log(`   Transaction Deserialized: ✅`);
    console.log(`   Signatures Required: ${transaction.signatures.length}`);
    
    console.log('\n' + '='.repeat(70));
    console.log('🎉 SUCCESS! All Jupiter API endpoints are working!');
    console.log('='.repeat(70));
    console.log('\n⚠️  NOTE: Transaction was NOT sent (test mode)');
    console.log('The meme reward feature should now work in production.\n');
    
  } catch (error) {
    console.error('\n' + '='.repeat(70));
    console.error('❌ TEST FAILED');
    console.error('='.repeat(70));
    console.error('\nError Details:');
    console.error(error);
    console.error('\nThis means the Jupiter API is still not accessible.');
    console.error('Check the error message above for details.\n');
    process.exit(1);
  }
}

// Run the test
testJupiterEndpoints().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
