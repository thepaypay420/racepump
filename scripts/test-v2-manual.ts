#!/usr/bin/env tsx
/**
 * Manual V2 Raceswap test - builds instruction without IDL
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import crypto from 'crypto';

const PROGRAM_ID = new PublicKey('Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk');
const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TREASURY = new PublicKey('Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L');
const SYSTEM_PROGRAM = SystemProgram.programId;

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Calculate instruction discriminator for V2
function getInstructionDiscriminator(name: string): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(`global:${name}`);
  return hash.digest().subarray(0, 8);
}

// Borsh serialize for V2 params
function serializeV2Params(params: {
  amount: bigint;
  minOut: bigint;
  jupiterAccounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  jupiterData: Buffer;
}): Buffer {
  const buffers: Buffer[] = [];
  
  // amount (u64)
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(params.amount);
  buffers.push(amountBuf);
  
  // minOut (u64)
  const minOutBuf = Buffer.alloc(8);
  minOutBuf.writeBigUInt64LE(params.minOut);
  buffers.push(minOutBuf);
  
  // jupiterAccounts (Vec<SerializableAccountMeta>)
  const accountsLen = Buffer.alloc(4);
  accountsLen.writeUInt32LE(params.jupiterAccounts.length);
  buffers.push(accountsLen);
  
  for (const acc of params.jupiterAccounts) {
    buffers.push(acc.pubkey.toBuffer());
    buffers.push(Buffer.from([acc.isSigner ? 1 : 0]));
    buffers.push(Buffer.from([acc.isWritable ? 1 : 0]));
  }
  
  // jupiterData (Vec<u8>)
  const dataLen = Buffer.alloc(4);
  dataLen.writeUInt32LE(params.jupiterData.length);
  buffers.push(dataLen);
  buffers.push(params.jupiterData);
  
  return Buffer.concat(buffers);
}

async function testV2() {
  console.log('🚀 Testing Raceswap V2 (Manual Instruction Build)\n');

  const escrowKey = JSON.parse(process.env.ESCROW_PRIVATE_KEY || '[]');
  if (!escrowKey.length) throw new Error('ESCROW_PRIVATE_KEY not set');
  const user = Keypair.fromSecretKey(Uint8Array.from(escrowKey));
  
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  console.log('User:', user.publicKey.toBase58());
  const balance = await connection.getBalance(user.publicKey);
  console.log('Balance:', (balance / 1e9).toFixed(4), 'SOL\n');

  if (balance < 0.02 * 1e9) {
    throw new Error('Insufficient balance (need at least 0.02 SOL for test)');
  }

  // Test with 0.01 SOL
  const amount = BigInt(Math.floor(0.01 * 1e9));
  console.log(`Testing ${Number(amount) / 1e9} SOL → USDC\n`);

  // Get Jupiter quote
  console.log('📊 Fetching Jupiter quote...');
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=50`;
  const quoteRes = await fetch(quoteUrl);
  const quote = await quoteRes.json();
  
  if (quote.error) throw new Error(`Quote error: ${quote.error}`);
  console.log('✅ Expected:', (quote.outAmount / 1e6).toFixed(4), 'USDC');
  console.log('   Impact:', quote.priceImpactPct, '%\n');

  // Get swap instruction
  console.log('🔄 Building swap transaction...');
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
  if (swapData.error) throw new Error(`Swap error: ${swapData.error}`);

  // Build V2 instruction
  console.log('🎯 Building Raceswap V2 instruction...\n');
  
  const jupiterAccounts = swapData.swapInstruction.accounts.map((acc: any) => ({
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  const discriminator = getInstructionDiscriminator('execute_swap');
  const params = serializeV2Params({
    amount,
    minOut: BigInt(quote.outAmount),
    jupiterAccounts,
    jupiterData: Buffer.from(swapData.swapInstruction.data, 'base64'),
  });

  const instructionData = Buffer.concat([discriminator, params]);

  // Build account metas for V2
  const accounts = [
    { pubkey: user.publicKey, isSigner: true, isWritable: true }, // user
    { pubkey: TREASURY, isSigner: false, isWritable: true }, // treasury
    { pubkey: JUPITER_V6, isSigner: false, isWritable: false }, // jupiter_program
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, // system_program
    ...jupiterAccounts.map(acc => ({
      pubkey: acc.pubkey,
      isSigner: false, // V2: user signs, not accounts
      isWritable: acc.isWritable,
    })),
  ];

  const raceswapIx = new TransactionInstruction({
    keys: accounts,
    programId: PROGRAM_ID,
    data: instructionData,
  });

  // Build transaction
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  
  // Add setup instructions from Jupiter
  if (swapData.setupInstructions) {
    for (const ix of swapData.setupInstructions) {
      tx.add(new TransactionInstruction({
        keys: ix.accounts.map((acc: any) => ({
          pubkey: new PublicKey(acc.pubkey),
          isSigner: acc.isSigner,
          isWritable: acc.isWritable,
        })),
        programId: new PublicKey(ix.programId),
        data: Buffer.from(ix.data, 'base64'),
      }));
    }
  }
  
  tx.add(raceswapIx);
  
  // Add cleanup instructions from Jupiter
  if (swapData.cleanupInstructions) {
    for (const ix of swapData.cleanupInstructions) {
      tx.add(new TransactionInstruction({
        keys: ix.accounts.map((acc: any) => ({
          pubkey: new PublicKey(acc.pubkey),
          isSigner: acc.isSigner,
          isWritable: acc.isWritable,
        })),
        programId: new PublicKey(ix.programId),
        data: Buffer.from(ix.data, 'base64'),
      }));
    }
  }

  console.log('📝 Transaction summary:');
  console.log('   Instructions:', tx.instructions.length);
  console.log('   Raceswap accounts:', accounts.length);
  console.log('   Jupiter accounts:', jupiterAccounts.length);

  // Simulate first
  console.log('\n🧪 Simulating transaction...');
  try {
    const simulation = await connection.simulateTransaction(tx, [user]);
    
    if (simulation.value.err) {
      console.error('❌ Simulation failed:', simulation.value.err);
      console.error('Logs:', simulation.value.logs);
      throw new Error('Simulation failed');
    }
    
    console.log('✅ Simulation successful!');
    console.log('   Logs:', simulation.value.logs?.slice(-5).join('\n   '));
  } catch (err: any) {
    console.error('❌ Simulation error:', err.message);
    throw err;
  }

  console.log('\n🚀 Sending transaction...');
  const sig = await connection.sendTransaction(tx, [user], {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  console.log('   Signature:', sig);
  console.log('   Explorer: https://solscan.io/tx/' + sig);
  
  console.log('\n⏳ Confirming...');
  await connection.confirmTransaction(sig, 'confirmed');
  
  console.log('\n✅ V2 SWAP SUCCESSFUL!');
  console.log('🎉 Non-custodial architecture works!');
}

testV2().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  if (err.logs) console.error('Logs:', err.logs);
  process.exit(1);
});
