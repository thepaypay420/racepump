/**
 * Test V2 Raceswap using Jupiter V1 API (lite-api.jup.ag)
 * This uses the same endpoints as your main racepump app
 */

import { Connection, Keypair, Transaction, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { createHash } from 'crypto';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

const RACESWAP_V2_PROGRAM_ID = new PublicKey('Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk');
const JUPITER_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TREASURY = new PublicKey('Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function getV2Discriminator(name) {
  const hash = createHash('sha256').update(`global:${name}`).digest();
  return Buffer.from(hash.slice(0, 8));
}

function serializeV2Params(params) {
  const buffers = [];

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

async function getJupiterSwapData(userPublicKey, inputMint, outputMint, amount, slippageBps = 50) {
  console.log('\n📊 Getting Jupiter V1 quote...');
  
  // Use Jupiter V1 API (same as main app)
  const quoteUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
  quoteUrl.searchParams.set('inputMint', inputMint);
  quoteUrl.searchParams.set('outputMint', outputMint);
  quoteUrl.searchParams.set('amount', Math.floor(amount).toString());
  quoteUrl.searchParams.set('slippageBps', slippageBps.toString());
  quoteUrl.searchParams.set('maxAccounts', '40');
  quoteUrl.searchParams.set('instructionVersion', 'V2');
  
  console.log('   URL:', quoteUrl.toString());
  
  const quoteRes = await fetch(quoteUrl.toString());
  const quoteData = await quoteRes.json();

  if (quoteData.error || !quoteRes.ok) {
    throw new Error(`Jupiter quote failed: ${JSON.stringify(quoteData)}`);
  }

  console.log('✅ Quote received:');
  console.log('   Input:', quoteData.inAmount / 1e9, 'SOL');
  console.log('   Output:', quoteData.outAmount / 1e6, 'USDC');
  console.log('   Price impact:', quoteData.priceImpactPct, '%');

  console.log('\n🔧 Getting swap transaction...');
  const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userPublicKey: userPublicKey.toBase58(),
      quoteResponse: quoteData,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      instructionVersion: 'V2',
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 100000,
          priorityLevel: 'high'
        }
      }
    }),
  });

  const swapData = await swapRes.json();
  if (swapData.error || !swapRes.ok) {
    throw new Error(`Jupiter swap failed: ${JSON.stringify(swapData)}`);
  }

  console.log('✅ Swap data received');
  console.log('   Setup instructions:', swapData.setupInstructions?.length || 0);
  console.log('   Swap accounts:', swapData.swapInstruction.accounts.length);
  console.log('   Cleanup instructions:', swapData.cleanupInstructions?.length || 0);

  return { quoteData, swapData };
}

async function testV2Swap() {
  console.log('🚀 Testing Raceswap V2 with Jupiter V1 API\n');

  // Load escrow keypair
  const escrowPrivateKey = process.env.ESCROW_PRIVATE_KEY;
  if (!escrowPrivateKey) {
    throw new Error('ESCROW_PRIVATE_KEY not found in environment');
  }

  const wallet = Keypair.fromSecretKey(bs58.decode(escrowPrivateKey));
  console.log('👛 Wallet:', wallet.publicKey.toBase58());

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log('💰 Balance:', balance / 1e9, 'SOL\n');

  if (balance < 0.02 * 1e9) {
    throw new Error('Insufficient balance (need at least 0.02 SOL)');
  }

  const amount = 0.01 * 1e9; // 0.01 SOL

  try {
    // Get Jupiter swap data using V1 API
    const { quoteData, swapData } = await getJupiterSwapData(
      wallet.publicKey,
      SOL_MINT,
      USDC_MINT,
      Math.floor(amount),
      50
    );

    console.log('\n🔨 Building V2 transaction...');

    const tx = new Transaction();

    // Add compute budget
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      })
    );

    // Add setup instructions
    if (swapData.setupInstructions) {
      for (const ix of swapData.setupInstructions) {
        tx.add(
          new TransactionInstruction({
            keys: ix.accounts.map((acc) => ({
              pubkey: new PublicKey(acc.pubkey),
              isSigner: acc.isSigner,
              isWritable: acc.isWritable,
            })),
            programId: new PublicKey(ix.programId),
            data: Buffer.from(ix.data, 'base64'),
          })
        );
      }
    }

    // Build V2 execute_swap instruction
    const jupiterAccounts = swapData.swapInstruction.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    }));

    const discriminator = getV2Discriminator('execute_swap');
    const params = serializeV2Params({
      amount: BigInt(Math.floor(amount)),
      minOut: BigInt(quoteData.outAmount),
      jupiterAccounts,
      jupiterData: Buffer.from(swapData.swapInstruction.data, 'base64'),
    });

    const instructionData = Buffer.concat([discriminator, params]);

    const raceswapAccounts = [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...jupiterAccounts.map((acc) => ({
        pubkey: acc.pubkey,
        isSigner: false,
        isWritable: acc.isWritable,
      })),
    ];

    const raceswapIx = new TransactionInstruction({
      keys: raceswapAccounts,
      programId: RACESWAP_V2_PROGRAM_ID,
      data: instructionData,
    });

    tx.add(raceswapIx);

    // Add cleanup instructions
    if (swapData.cleanupInstructions) {
      for (const ix of swapData.cleanupInstructions) {
        tx.add(
          new TransactionInstruction({
            keys: ix.accounts.map((acc) => ({
              pubkey: new PublicKey(acc.pubkey),
              isSigner: acc.isSigner,
              isWritable: acc.isWritable,
            })),
            programId: new PublicKey(ix.programId),
            data: Buffer.from(ix.data, 'base64'),
          })
        );
      }
    }

    console.log('✅ Transaction built:', tx.instructions.length, 'instructions');

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    console.log('\n🧪 Simulating transaction...');
    const simulation = await connection.simulateTransaction(tx);
    
    if (simulation.value.err) {
      console.error('❌ Simulation failed:', simulation.value.err);
      console.error('Logs:');
      simulation.value.logs?.forEach(log => console.error('  ', log));
      throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    console.log('✅ Simulation successful!');
    console.log('   Compute units used:', simulation.value.unitsConsumed);
    console.log('   Last 5 logs:');
    simulation.value.logs?.slice(-5).forEach(log => console.log('     ', log));

    console.log('\n✍️ Signing transaction...');
    tx.sign(wallet);

    console.log('📡 Sending to blockchain...');
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    console.log('✅ Transaction sent:', signature);
    console.log('   Solscan:', `https://solscan.io/tx/${signature}`);

    console.log('\n⏳ Waiting for confirmation...');
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    console.log('\n🎉 V2 SWAP SUCCESSFUL!');
    console.log('✅ No 0x1789 errors!');
    console.log('✅ V2 architecture works perfectly!');
    console.log('✅ Jupiter V1 API integration confirmed!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.logs) {
      console.error('Transaction logs:', error.logs);
    }
    throw error;
  }
}

// Run test
testV2Swap()
  .then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
