import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';
import fetch from 'node-fetch';

// Use local backend proxy to bypass Replit network restrictions
const JUPITER_QUOTE_API = 'http://localhost:5000/api/jupiter/quote';
const JUPITER_SWAP_API = 'http://localhost:5000/api/jupiter/swap-instructions';
const TREASURY_WALLET = new PublicKey('8TvBoo7huVq2c3p1tURXYVhRzLn3NzacJQh1WYPpkZhn');
const RACE_TOKEN_MINT = new PublicKey('t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Load escrow wallet
const escrowKey = process.env.ESCROW_PRIVATE_KEY;
if (!escrowKey) {
  throw new Error('ESCROW_PRIVATE_KEY not found in environment');
}

const keypair = Keypair.fromSecretKey(bs58.decode(escrowKey));
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

console.log('🚀 Testing Jupiter Swap with Escrow Wallet');
console.log('👛 Wallet:', keypair.publicKey.toString());

// Check balance
const balance = await connection.getBalance(keypair.publicKey);
console.log('💰 Balance:', balance / 1e9, 'SOL');

if (balance < 0.015e9) {
  throw new Error('Insufficient balance for test (need at least 0.015 SOL)');
}

// Test parameters
const swapAmount = 0.01e9; // 0.01 SOL
const treasuryFee = Math.floor(swapAmount * 0.002); // 0.2%
const reflectionAmount = Math.floor(swapAmount * 0.01); // 1%
const mainSwapAmount = swapAmount - treasuryFee - reflectionAmount;

console.log('\n💵 Amounts:');
console.log('- Total:', swapAmount / 1e9, 'SOL');
console.log('- Treasury fee:', treasuryFee / 1e9, 'SOL');
console.log('- Reflection:', reflectionAmount / 1e9, 'SOL');
console.log('- Main swap:', mainSwapAmount / 1e9, 'SOL');

try {
  // Step 1: Get main swap quote (SOL → USDC)
  console.log('\n📊 Getting main swap quote (SOL → USDC)...');
  const mainQuoteUrl = `${JUPITER_QUOTE_API}?inputMint=${WSOL_MINT.toString()}&outputMint=${USDC_MINT.toString()}&amount=${mainSwapAmount}&slippageBps=50`;
  const mainQuoteRes = await fetch(mainQuoteUrl);
  const mainQuote = await mainQuoteRes.json();
  
  if (!mainQuoteRes.ok || mainQuote.error) {
    throw new Error(`Main quote failed: ${JSON.stringify(mainQuote)}`);
  }
  console.log('✅ Main quote:', (mainQuote.outAmount / 1e6).toFixed(2), 'USDC');

  // Step 2: Get reflection swap quote (SOL → RACE)
  console.log('\n📊 Getting reflection swap quote (SOL → RACE)...');
  const reflectionQuoteUrl = `${JUPITER_QUOTE_API}?inputMint=${WSOL_MINT.toString()}&outputMint=${RACE_TOKEN_MINT.toString()}&amount=${reflectionAmount}&slippageBps=50`;
  const reflectionQuoteRes = await fetch(reflectionQuoteUrl);
  const reflectionQuote = await reflectionQuoteRes.json();
  
  if (!reflectionQuoteRes.ok || reflectionQuote.error) {
    throw new Error(`Reflection quote failed: ${JSON.stringify(reflectionQuote)}`);
  }
  console.log('✅ Reflection quote:', reflectionQuote.outAmount, 'RACE tokens');

  // Step 3: Get swap instructions for main swap
  console.log('\n🔧 Getting main swap instructions...');
  const mainSwapRes = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: mainQuote,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    })
  });
  const mainSwapData = await mainSwapRes.json();
  
  if (!mainSwapRes.ok || mainSwapData.error) {
    throw new Error(`Main swap instructions failed: ${JSON.stringify(mainSwapData)}`);
  }
  console.log('✅ Main swap instructions received');

  // Step 4: Get swap instructions for reflection swap
  console.log('\n🔧 Getting reflection swap instructions...');
  const reflectionSwapRes = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: reflectionQuote,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    })
  });
  const reflectionSwapData = await reflectionSwapRes.json();
  
  if (!reflectionSwapRes.ok || reflectionSwapData.error) {
    throw new Error(`Reflection swap instructions failed: ${JSON.stringify(reflectionSwapData)}`);
  }
  console.log('✅ Reflection swap instructions received');

  // Step 5: Build combined transaction
  console.log('\n🔨 Building combined transaction...');
  
  // Deserialize instruction helper
  const deserializeIx = (ixData) => {
    return {
      programId: new PublicKey(ixData.programId),
      keys: ixData.accounts.map(acc => ({
        pubkey: new PublicKey(acc.pubkey),
        isSigner: acc.isSigner,
        isWritable: acc.isWritable
      })),
      data: Buffer.from(ixData.data, 'base64')
    };
  };

  const allInstructions = [];
  
  // Add compute budget from main swap
  if (mainSwapData.computeBudgetInstructions) {
    mainSwapData.computeBudgetInstructions.forEach(ix => {
      allInstructions.push(deserializeIx(ix));
    });
  }
  
  // Add treasury fee
  allInstructions.push(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: TREASURY_WALLET,
      lamports: treasuryFee
    })
  );
  
  // Add main swap setup + swap
  if (mainSwapData.setupInstructions) {
    mainSwapData.setupInstructions.forEach(ix => {
      allInstructions.push(deserializeIx(ix));
    });
  }
  if (mainSwapData.swapInstruction) {
    allInstructions.push(deserializeIx(mainSwapData.swapInstruction));
  }
  
  // Add reflection swap setup + swap
  if (reflectionSwapData.setupInstructions) {
    reflectionSwapData.setupInstructions.forEach(ix => {
      allInstructions.push(deserializeIx(ix));
    });
  }
  if (reflectionSwapData.swapInstruction) {
    allInstructions.push(deserializeIx(reflectionSwapData.swapInstruction));
  }
  
  // Add cleanup
  if (mainSwapData.cleanupInstruction) {
    allInstructions.push(deserializeIx(mainSwapData.cleanupInstruction));
  }
  if (reflectionSwapData.cleanupInstruction) {
    allInstructions.push(deserializeIx(reflectionSwapData.cleanupInstruction));
  }
  
  console.log('📦 Total instructions:', allInstructions.length);
  
  // Load address lookup tables
  const addressLookupTableAccounts = [];
  const lutAddresses = [...(mainSwapData.addressLookupTableAddresses || []), ...(reflectionSwapData.addressLookupTableAddresses || [])];
  const uniqueLuts = [...new Set(lutAddresses)];
  
  if (uniqueLuts.length > 0) {
    console.log('📖 Loading', uniqueLuts.length, 'address lookup tables...');
    for (const address of uniqueLuts) {
      const lookup = await connection.getAddressLookupTable(new PublicKey(address));
      if (lookup.value) {
        addressLookupTableAccounts.push(lookup.value);
      }
    }
  }
  
  // Build transaction
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: allInstructions
  }).compileToV0Message(addressLookupTableAccounts);
  
  const transaction = new VersionedTransaction(message);
  transaction.sign([keypair]);
  
  console.log('\n🧪 Simulating transaction...');
  const simulation = await connection.simulateTransaction(transaction);
  
  if (simulation.value.err) {
    console.error('❌ Simulation failed:', simulation.value.err);
    console.error('Logs:', simulation.value.logs);
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  
  console.log('✅ Simulation successful!');
  console.log('Logs:', simulation.value.logs?.slice(-5));
  
  console.log('\n📡 Sending transaction...');
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  
  console.log('✅ Transaction sent:', signature);
  console.log('🔗 https://solscan.io/tx/' + signature);
  
  console.log('\n⏳ Confirming transaction...');
  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight
  }, 'confirmed');
  
  console.log('\n🎉 SWAP SUCCESSFUL!');
  console.log('Signature:', signature);
  
  // Check new balance
  const newBalance = await connection.getBalance(keypair.publicKey);
  console.log('💰 New balance:', newBalance / 1e9, 'SOL');
  console.log('💸 Cost:', (balance - newBalance) / 1e9, 'SOL');
  
} catch (error) {
  console.error('\n❌ SWAP FAILED:', error.message);
  if (error.stack) {
    console.error('Stack:', error.stack);
  }
  process.exit(1);
}
