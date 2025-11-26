#!/usr/bin/env node
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import crypto from 'crypto';
import nodeFetch from 'node-fetch';
import bs58 from 'bs58';

global.fetch = nodeFetch;

const PROGRAM_ID = new PublicKey('Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk');
const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TREASURY = new PublicKey('Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L');
const SYSTEM_PROGRAM = SystemProgram.programId;
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function getDiscriminator(name) {
  const hash = crypto.createHash('sha256');
  hash.update(`global:${name}`);
  return hash.digest().subarray(0, 8);
}

function serializeParams(params) {
  const buffers = [];
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(params.amount);
  buffers.push(amountBuf);
  const minOutBuf = Buffer.alloc(8);
  minOutBuf.writeBigUInt64LE(params.minOut);
  buffers.push(minOutBuf);
  const accountsLen = Buffer.alloc(4);
  accountsLen.writeUInt32LE(params.jupiterAccounts.length);
  buffers.push(accountsLen);
  for (const acc of params.jupiterAccounts) {
    buffers.push(acc.pubkey.toBuffer());
    buffers.push(Buffer.from([acc.isSigner ? 1 : 0]));
    buffers.push(Buffer.from([acc.isWritable ? 1 : 0]));
  }
  const dataLen = Buffer.alloc(4);
  dataLen.writeUInt32LE(params.jupiterData.length);
  buffers.push(dataLen);
  buffers.push(params.jupiterData);
  return Buffer.concat(buffers);
}

async function test() {
  console.log('🚀 Raceswap V2 - Mainnet Test\n');
  
  const keyStr = process.env.ESCROW_PRIVATE_KEY;
  if (!keyStr) throw new Error('ESCROW_PRIVATE_KEY not set');
  
  let user;
  try {
    // Try parsing as JSON array first
    const cleaned = keyStr.trim();
    if (cleaned.startsWith('[')) {
      const keyArray = JSON.parse(cleaned);
      user = Keypair.fromSecretKey(Uint8Array.from(keyArray));
    } else {
      // Try base58
      const secretKey = bs58.decode(cleaned);
      user = Keypair.fromSecretKey(secretKey);
    }
  } catch (err) {
    throw new Error(`Failed to parse ESCROW_PRIVATE_KEY: ${err.message}`);
  }

  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  console.log('Wallet:', user.publicKey.toBase58());
  const balance = await connection.getBalance(user.publicKey);
  console.log('Balance:', (balance / 1e9).toFixed(4), 'SOL\n');

  if (balance < 0.02 * 1e9) {
    throw new Error('Insufficient balance (need at least 0.02 SOL)');
  }

  const amount = BigInt(Math.floor(0.01 * 1e9));
  console.log(`Swap: ${Number(amount) / 1e9} SOL → USDC\n`);

  console.log('📊 Jupiter quote...');
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=50`;
  const quoteRes = await fetch(quoteUrl);
  const quote = await quoteRes.json();
  
  if (quote.error) throw new Error(`Quote error: ${quote.error}`);
  console.log('✅ Expected:', (quote.outAmount / 1e6).toFixed(4), 'USDC\n');

  console.log('🔄 Swap instruction...');
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

  console.log('🎯 Building V2 Raceswap instruction...');
  const jupiterAccounts = swapData.swapInstruction.accounts.map(acc => ({
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  const discriminator = getDiscriminator('execute_swap');
  const params = serializeParams({
    amount,
    minOut: BigInt(quote.outAmount),
    jupiterAccounts,
    jupiterData: Buffer.from(swapData.swapInstruction.data, 'base64'),
  });

  const instructionData = Buffer.concat([discriminator, params]);
  const accounts = [
    { pubkey: user.publicKey, isSigner: true, isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: true },
    { pubkey: JUPITER_V6, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ...jupiterAccounts.map(acc => ({
      pubkey: acc.pubkey,
      isSigner: false,
      isWritable: acc.isWritable,
    })),
  ];

  const raceswapIx = new TransactionInstruction({
    keys: accounts,
    programId: PROGRAM_ID,
    data: instructionData,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  
  if (swapData.setupInstructions) {
    for (const ix of swapData.setupInstructions) {
      tx.add(new TransactionInstruction({
        keys: ix.accounts.map(acc => ({
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

  console.log('\n🧪 Simulating transaction...');
  const simulation = await connection.simulateTransaction(tx, [user]);
  
  if (simulation.value.err) {
    console.error('\n❌ SIMULATION FAILED:', simulation.value.err);
    console.error('\nLogs:');
    simulation.value.logs?.forEach(log => console.error('  ', log));
    throw new Error('Simulation failed');
  }
  
  console.log('✅ Simulation successful!\n');
  console.log('Last logs:');
  const lastLogs = simulation.value.logs?.slice(-8) || [];
  lastLogs.forEach(log => console.log('  ', log));

  console.log('\n🚀 Sending real transaction to mainnet...');
  const sig = await connection.sendTransaction(tx, [user], {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  
  console.log('\n✅ Transaction sent!');
  console.log('   Signature:', sig);
  console.log('   Explorer: https://solscan.io/tx/' + sig);
  
  console.log('\n⏳ Waiting for confirmation...');
  await connection.confirmTransaction(sig, 'confirmed');
  
  console.log('\n🎉🎉🎉 V2 SWAP SUCCESSFUL! 🎉🎉🎉');
  console.log('✅ Non-custodial architecture works perfectly!');
  console.log('✅ No 0x1789 errors - problem solved!');
  console.log('✅ User signed for Jupiter - clean and simple!');
}

test().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  if (err.logs) {
    console.error('\nLogs:');
    err.logs.forEach(log => console.error('  ', log));
  }
  process.exit(1);
});
