/**
 * Test V2 Raceswap with real SOL transaction
 */

import { Connection, Keypair, Transaction, VersionedTransaction, TransactionMessage, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionInstruction, AddressLookupTableAccount } from '@solana/web3.js';
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
    const pubkeyBuffer = acc.pubkey instanceof PublicKey ? acc.pubkey.toBuffer() : new PublicKey(acc.pubkey).toBuffer();
    buffers.push(pubkeyBuffer);
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

async function testV2Swap() {
  console.log('🚀 Testing Raceswap V2 with REAL SOL\n');

  const escrowPrivateKey = process.env.ESCROW_PRIVATE_KEY;
  if (!escrowPrivateKey) {
    throw new Error('ESCROW_PRIVATE_KEY not found');
  }

  const wallet = Keypair.fromSecretKey(bs58.decode(escrowPrivateKey));
  console.log('👛 Wallet:', wallet.publicKey.toBase58());

  const balance = await connection.getBalance(wallet.publicKey);
  console.log('💰 Balance:', balance / 1e9, 'SOL\n');

  if (balance < 0.02 * 1e9) {
    throw new Error('Insufficient balance');
  }

  const amount = 0.01 * 1e9; // 0.01 SOL

  try {
    // Step 1: Get quote
    console.log('📊 Getting Jupiter quote...');
    const quoteUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
    quoteUrl.searchParams.set('inputMint', SOL_MINT);
    quoteUrl.searchParams.set('outputMint', USDC_MINT);
    quoteUrl.searchParams.set('amount', Math.floor(amount).toString());
    quoteUrl.searchParams.set('slippageBps', '50');
    quoteUrl.searchParams.set('maxAccounts', '40');

    const quoteRes = await fetch(quoteUrl.toString());
    const quoteData = await quoteRes.json();

    if (quoteData.error || !quoteRes.ok) {
      throw new Error(`Quote failed: ${JSON.stringify(quoteData)}`);
    }

    console.log('✅ Quote:', quoteData.inAmount / 1e9, 'SOL →', quoteData.outAmount / 1e6, 'USDC');

    // Step 2: Get swap transaction
    console.log('\n🔧 Getting swap transaction...');
    const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPublicKey: wallet.publicKey.toBase58(),
        quoteResponse: quoteData,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
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
      throw new Error(`Swap failed: ${JSON.stringify(swapData)}`);
    }

    console.log('✅ Swap transaction received');

    // Step 3: Deserialize to extract instructions
    console.log('\n🔨 Deserializing versioned transaction...');
    const txBuffer = Buffer.from(swapData.swapTransaction, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuffer);
    
    console.log('   Transaction version:', versionedTx.version);
    console.log('   Total instructions:', versionedTx.message.compiledInstructions.length);

    // Decode the compiled instructions
    // For versioned transactions, we need to fetch lookup table addresses
    console.log('   Static account keys:', versionedTx.message.staticAccountKeys.length);
    console.log('   Lookup tables:', versionedTx.message.addressTableLookups?.length || 0);
    
    let accountKeysFromLookups = undefined;
    
    if (versionedTx.message.addressTableLookups && versionedTx.message.addressTableLookups.length > 0) {
      console.log('   Fetching address lookup table data...');
      const lookupTableAccounts = await Promise.all(
        versionedTx.message.addressTableLookups.map(lookup =>
          connection.getAddressLookupTable(lookup.accountKey)
        )
      );
      
      accountKeysFromLookups = {
        writable: [],
        readonly: []
      };
      
      for (let i = 0; i < versionedTx.message.addressTableLookups.length; i++) {
        const lookup = versionedTx.message.addressTableLookups[i];
        const tableAccount = lookupTableAccounts[i].value;
        
        if (tableAccount) {
          // Add writable addresses
          for (const index of lookup.writableIndexes) {
            accountKeysFromLookups.writable.push(tableAccount.state.addresses[index]);
          }
          // Add readonly addresses
          for (const index of lookup.readonlyIndexes) {
            accountKeysFromLookups.readonly.push(tableAccount.state.addresses[index]);
          }
        }
      }
      console.log('   Loaded', accountKeysFromLookups.writable.length, 'writable and', 
        accountKeysFromLookups.readonly.length, 'readonly addresses from lookup tables');
    }
    
    const allAccountKeys = versionedTx.message.getAccountKeys({ accountKeysFromLookups });
    
    const instructions = [];

    for (const compiledIx of versionedTx.message.compiledInstructions) {
      const programId = allAccountKeys.get(compiledIx.programIdIndex);
      const keys = compiledIx.accountKeyIndexes.map(idx => {
        const pubkey = allAccountKeys.get(idx);
        // Check if account is signer or writable based on message headers
        const isSigner = idx < versionedTx.message.header.numRequiredSignatures;
        const numStaticKeys = versionedTx.message.staticAccountKeys.length;
        const isWritable = idx < versionedTx.message.header.numRequiredSignatures - versionedTx.message.header.numReadonlySignedAccounts ||
          (idx >= versionedTx.message.header.numRequiredSignatures && 
           idx < numStaticKeys - versionedTx.message.header.numReadonlyUnsignedAccounts);
        
        return {
          pubkey,
          isSigner,
          isWritable,
        };
      });

      instructions.push({
        programId,
        keys,
        data: Buffer.from(compiledIx.data),
      });
    }

    console.log('   Decoded', instructions.length, 'instructions');

    const setupInstructions = [];
    const cleanupInstructions = [];
    let swapInstruction = null;
    let foundJupiterSwap = false;

    for (const ix of instructions) {
      if (ix.programId.equals(ComputeBudgetProgram.programId)) {
        console.log('   - Compute budget instruction');
        continue;
      }

      if (ix.programId.equals(JUPITER_PROGRAM_ID)) {
        console.log('   - Jupiter swap instruction (', ix.keys.length, 'accounts )');
        swapInstruction = {
          programId: ix.programId,
          accounts: ix.keys,
          data: ix.data,
        };
        foundJupiterSwap = true;
      } else {
        console.log('   -', foundJupiterSwap ? 'Cleanup' : 'Setup', 'instruction:', ix.programId.toBase58());
        if (!foundJupiterSwap) {
          setupInstructions.push(new TransactionInstruction({
            programId: ix.programId,
            keys: ix.keys,
            data: ix.data,
          }));
        } else {
          cleanupInstructions.push(new TransactionInstruction({
            programId: ix.programId,
            keys: ix.keys,
            data: ix.data,
          }));
        }
      }
    }

    if (!swapInstruction) {
      throw new Error('No Jupiter swap instruction found!');
    }

    console.log('✅ Extracted:', setupInstructions.length, 'setup,', '1 swap,', cleanupInstructions.length, 'cleanup');

    // Step 4: Build V2 versioned transaction (to use lookup tables)
    console.log('\n🔨 Building V2 versioned transaction...');
    
    const txInstructions = [];

    // Add compute budget
    txInstructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      })
    );

    // Add setup instructions
    for (const ix of setupInstructions) {
      txInstructions.push(ix);
    }

    // Build V2 execute_swap instruction
    const jupiterAccounts = swapInstruction.accounts.map((acc) => ({
      pubkey: acc.pubkey,
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    }));

    // Debug: Check for undefined accounts BEFORE serialization
    console.log('   Checking Jupiter accounts before serialization...');
    for (let i = 0; i < jupiterAccounts.length; i++) {
      if (!jupiterAccounts[i].pubkey) {
        console.error('   ERROR: Account', i, 'has undefined pubkey!', jupiterAccounts[i]);
        throw new Error(`Jupiter account ${i} has undefined pubkey`);
      }
      // Check if it's a valid PublicKey
      try {
        const testBuffer = jupiterAccounts[i].pubkey instanceof PublicKey ? 
          jupiterAccounts[i].pubkey.toBuffer() : 
          new PublicKey(jupiterAccounts[i].pubkey).toBuffer();
      } catch (e) {
        console.error('   ERROR: Account', i, 'pubkey is invalid!', jupiterAccounts[i].pubkey, e.message);
        throw new Error(`Jupiter account ${i} has invalid pubkey: ${e.message}`);
      }
    }
    console.log('   All', jupiterAccounts.length, 'accounts validated');

    const discriminator = getV2Discriminator('execute_swap');
    console.log('   Serializing params...');
    const params = serializeV2Params({
      amount: BigInt(Math.floor(amount)),
      minOut: BigInt(quoteData.outAmount),
      jupiterAccounts,
      jupiterData: swapInstruction.data,
    });
    console.log('   Params serialized, length:', params.length);

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

    txInstructions.push(raceswapIx);

    // Add cleanup
    for (const ix of cleanupInstructions) {
      txInstructions.push(ix);
    }

    console.log('✅ Built', txInstructions.length, 'total instructions');

    // Get lookup tables from Jupiter transaction
    const lookupTableAccounts = accountKeysFromLookups ? 
      await Promise.all(
        versionedTx.message.addressTableLookups.map(lookup =>
          connection.getAddressLookupTable(lookup.accountKey)
        )
      ).then(results => results.map(r => r.value).filter(v => v !== null)) :
      [];

    console.log('   Using', lookupTableAccounts.length, 'lookup tables');

    // Step 5: Build versioned transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: txInstructions,
    }).compileToV0Message(lookupTableAccounts);

    const tx = new VersionedTransaction(messageV0);
    
    const serialized = tx.serialize();
    console.log('   Transaction size:', serialized.length, 'bytes');

    console.log('\n🧪 Simulating...');
    const simulation = await connection.simulateTransaction(tx);
    
    if (simulation.value.err) {
      console.error('❌ SIMULATION FAILED:', simulation.value.err);
      console.error('\nLOGS:');
      simulation.value.logs?.forEach(log => console.error(log));
      throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    console.log('✅ Simulation successful!');
    console.log('   Compute units:', simulation.value.unitsConsumed);
    console.log('\n📜 Last 10 logs:');
    simulation.value.logs?.slice(-10).forEach(log => console.log('   ', log));

    // Step 6: Send
    console.log('\n✍️ Signing and sending...');
    tx.sign([wallet]);

    const signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    console.log('\n✅ TRANSACTION SENT:', signature);
    console.log('🔗 Solscan:', `https://solscan.io/tx/${signature}`);

    console.log('\n⏳ Confirming...');
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    console.log('\n🎉 V2 SWAP SUCCESSFUL!');
    console.log('✅ Transaction confirmed on-chain');
    console.log('✅ V2 architecture validated');

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    if (error.logs) {
      console.error('\nTransaction logs:');
      error.logs.forEach(log => console.error(log));
    }
    throw error;
  }
}

testV2Swap()
  .then(() => {
    console.log('\n✅ Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed');
    process.exit(1);
  });
