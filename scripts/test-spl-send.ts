#!/usr/bin/env tsx
/**
 * Test SPL token sending functionality
 * Tests sending tokens from escrow to a recipient
 * 
 * Usage: tsx scripts/test-spl-send.ts <tokenMint> <tokenSymbol> <amount> <recipientWallet>
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { sendSplTokens, getMintDecimals } from '../server/solana';
import Decimal from 'decimal.js';
import bs58 from 'bs58';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 4) {
    console.log('Usage: tsx scripts/test-spl-send.ts <tokenMint> <tokenSymbol> <amount> <recipientWallet>');
    console.log('Example: tsx scripts/test-spl-send.ts EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v USDC 1000000 ANQZsrP1f6nUwehUw9wwScwgJMee8tbZLUmFaqYLXXRX');
    process.exit(1);
  }

  const [tokenMint, tokenSymbol, amountRaw, recipientWallet] = args;

  console.log('\n🧪 SPL TOKEN SEND TEST');
  console.log('='.repeat(70));
  console.log(`Token:           ${tokenSymbol} (${tokenMint})`);
  console.log(`Amount (raw):    ${amountRaw}`);
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

  // Connect to Solana devnet
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    'confirmed'
  );

  try {
    // Step 1: Get escrow SOL balance
    console.log('📊 Step 1: Checking escrow SOL balance...');
    const balance = await connection.getBalance(escrowKeypair.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;
    console.log(`   SOL Balance: ${balanceSol.toFixed(4)} SOL`);
    
    if (balanceSol < 0.01) {
      console.log(`   ⚠️  Low SOL balance! You may need more for transaction fees.`);
    }
    console.log();

    // Step 2: Get token decimals
    console.log('📈 Step 2: Getting token decimals...');
    const mint = new PublicKey(tokenMint);
    const decimals = await getMintDecimals(mint);
    console.log(`   Decimals: ${decimals}`);
    console.log();

    // Step 3: Convert amount to smallest units
    const tokenAmountBigInt = BigInt(amountRaw);
    const humanAmount = new Decimal(amountRaw).div(new Decimal(10).pow(decimals));
    console.log(`📝 Step 3: Amount conversion`);
    console.log(`   Raw amount: ${tokenAmountBigInt}`);
    console.log(`   Human-readable: ${humanAmount.toString()} ${tokenSymbol}`);
    console.log();

    // Step 4: Send tokens
    console.log(`💸 Step 4: Sending ${humanAmount.toString()} ${tokenSymbol} to recipient...`);
    const sendTxSig = await sendSplTokens(
      mint,
      escrowKeypair,
      new PublicKey(recipientWallet),
      tokenAmountBigInt
    );

    console.log(`   Sent: ${sendTxSig}`);
    console.log(`   Solscan: https://solscan.io/tx/${sendTxSig}?cluster=devnet`);
    console.log();

    console.log('🎉 SUCCESS!');
    console.log('='.repeat(70));
    console.log(`✅ Sent ${humanAmount.toString()} ${tokenSymbol} to ${recipientWallet}`);
    console.log(`Transaction: https://solscan.io/tx/${sendTxSig}?cluster=devnet`);
    console.log('='.repeat(70));

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      if ('logs' in error) {
        console.error('Transaction logs:', (error as any).logs);
      }
    }
    process.exit(1);
  }
}

main().catch(console.error);
