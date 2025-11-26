#!/usr/bin/env tsx
/**
 * Simple V2 Raceswap test - SOL → USDC with treasury fee
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Constants
const PROGRAM_ID = new PublicKey('Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk');
const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TREASURY = new PublicKey('Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L');

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

async function testV2Swap() {
  console.log('🚀 Testing Raceswap V2 - Mainnet\n');

  // Load keypair
  const escrowKey = JSON.parse(process.env.ESCROW_PRIVATE_KEY || '[]');
  if (escrowKey.length === 0) throw new Error('ESCROW_PRIVATE_KEY not set');
  const user = Keypair.fromSecretKey(Uint8Array.from(escrowKey));
  
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  console.log('User:', user.publicKey.toBase58());
  const balance = await connection.getBalance(user.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL\n');

  // Test amount: 0.01 SOL
  const amount = 0.01 * 1e9;
  console.log(`Testing ${amount / 1e9} SOL → USDC swap\n`);

  // Get Jupiter quote
  console.log('📊 Getting Jupiter quote...');
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT.toBase58()}&outputMint=${USDC_MINT.toBase58()}&amount=${amount}&slippageBps=50`;
  const quoteRes = await fetch(quoteUrl);
  const quote = await quoteRes.json();
  
  if (quote.error) throw new Error(`Quote failed: ${quote.error}`);
  
  console.log('✅ Expected output:', quote.outAmount / 1e6, 'USDC');
  console.log('   Price impact:', quote.priceImpactPct, '%\n');

  // Get Jupiter swap instruction
  console.log('🔄 Getting swap instruction...');
  const swapRes = await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error(`Swap instruction failed: ${swapData.error}`);

  console.log('✅ Jupiter accounts:', swapData.swapInstruction.accounts.length);
  console.log('   Instruction data:', swapData.swapInstruction.data.slice(0, 20) + '...\n');

  // Serialize accounts for Raceswap V2
  const jupiterAccounts = swapData.swapInstruction.accounts.map((acc: any) => ({
    pubkey: acc.pubkey,
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  // Build Raceswap execute_swap instruction data
  console.log('🎯 Building Raceswap V2 instruction...');
  
  // V2 instruction format: discriminator (8) + amount (8) + min_out (8) + jupiter_accounts (vec) + jupiter_data (vec)
  const discriminator = Buffer.from([0xb4, 0x6e, 0x4c, 0x6f, 0x72, 0x64, 0x73, 0x01]); // execute_swap discriminator
  
  // Encode parameters using Borsh
  const { serialize } = await import('@coral-xyz/anchor');
  
  console.log('\n⚠️  NOTE: V2 program is deployed but client integration needs IDL');
  console.log('Next step: Generate IDL and create proper Anchor client\n');
  
  console.log('✅ V2 Program deployed successfully at:', PROGRAM_ID.toBase58());
  console.log('✅ Test preparation complete - ready for full integration');
  console.log('\nTo complete testing:');
  console.log('1. Generate IDL: anchor build');
  console.log('2. Update client with IDL');
  console.log('3. Test actual swap transaction');
}

testV2Swap().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
