import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';

const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1/swap-instructions';
// Using the common project default treasury
const TREASURY_WALLET = new PublicKey('Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L');
const RACE_TOKEN_MINT = new PublicKey('t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export interface SwapResult {
  signature: string;
  mainSwapAmount: string;
  reflectionAmount: string;
  treasuryFee: string;
}

/**
 * Execute atomic swap with treasury fee and RACE reflection
 * This version calls Jupiter directly from the browser (no backend proxy needed)
 */
export async function executeSwapDirect(
  connection: Connection,
  wallet: any,
  params: {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps?: number;
  }
): Promise<SwapResult> {
  const userPublicKey = wallet.publicKey.toString();
  
  console.log('🚀 Starting atomic swap (direct Jupiter calls)...');
  console.log('Input:', params.inputMint);
  console.log('Output:', params.outputMint);
  console.log('Amount:', params.amount);
  
  // Calculate fees and reflection amount
  const treasuryFeeAmount = Math.floor(params.amount * 0.002); // 0.2%
  const reflectionAmount = Math.floor(params.amount * 0.01); // 1%
  const mainSwapAmount = params.amount - treasuryFeeAmount - reflectionAmount;
  
  console.log('💰 Treasury fee:', treasuryFeeAmount);
  console.log('🎁 Reflection amount:', reflectionAmount);
  console.log('💱 Main swap amount:', mainSwapAmount);
  
  // Step 1: Get main swap quote (SOL → output token)
  console.log('\n📊 Getting main swap quote...');
  const mainQuoteUrl = `${JUPITER_QUOTE_API}?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${mainSwapAmount}&slippageBps=${params.slippageBps || 50}`;
  const mainQuoteRes = await fetch(mainQuoteUrl);
  const mainQuote = await mainQuoteRes.json();
  
  if (!mainQuoteRes.ok || mainQuote.error) {
    throw new Error(`Main quote failed: ${JSON.stringify(mainQuote)}`);
  }
  console.log('✅ Main quote:', mainQuote.outAmount);
  
  // Step 2: Get reflection swap quote (SOL → RACE)
  console.log('\n📊 Getting reflection swap quote...');
  const reflectionQuoteUrl = `${JUPITER_QUOTE_API}?inputMint=${params.inputMint}&outputMint=${RACE_TOKEN_MINT.toString()}&amount=${reflectionAmount}&slippageBps=${params.slippageBps || 50}`;
  const reflectionQuoteRes = await fetch(reflectionQuoteUrl);
  const reflectionQuote = await reflectionQuoteRes.json();
  
  if (!reflectionQuoteRes.ok || reflectionQuote.error) {
    throw new Error(`Reflection quote failed: ${JSON.stringify(reflectionQuote)}`);
  }
  console.log('✅ Reflection quote:', reflectionQuote.outAmount, 'RACE tokens');
  
  // Step 3: Get swap instructions
  console.log('\n🔧 Getting swap instructions...');
  const mainSwapRes = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: mainQuote,
      userPublicKey,
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
  
  const reflectionSwapRes = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: reflectionQuote,
      userPublicKey,
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
  
  console.log('✅ Swap instructions received');
  
  // Step 4: Build combined transaction
  console.log('\n🔨 Building transaction...');
  
  // Deserialize instruction helper
  const deserializeIx = (ixData: any): TransactionInstruction => {
    return new TransactionInstruction({
      programId: new PublicKey(ixData.programId),
      keys: ixData.accounts.map((acc: any) => ({
        pubkey: new PublicKey(acc.pubkey),
        isSigner: acc.isSigner,
        isWritable: acc.isWritable
      })),
      data: Buffer.from(ixData.data, 'base64')
    });
  };
  
  const allInstructions: TransactionInstruction[] = [];
  
  // Add compute budget (use only from main swap)
  if (mainSwapData.computeBudgetInstructions) {
    mainSwapData.computeBudgetInstructions.forEach((ix: any) => {
      allInstructions.push(deserializeIx(ix));
    });
  }
  
  // Add treasury fee
  allInstructions.push(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: TREASURY_WALLET,
      lamports: treasuryFeeAmount
    })
  );
  
  // Add main swap
  if (mainSwapData.setupInstructions) {
    mainSwapData.setupInstructions.forEach((ix: any) => allInstructions.push(deserializeIx(ix)));
  }
  if (mainSwapData.swapInstruction) {
    allInstructions.push(deserializeIx(mainSwapData.swapInstruction));
  }
  
  // Add reflection swap
  if (reflectionSwapData.setupInstructions) {
    reflectionSwapData.setupInstructions.forEach((ix: any) => allInstructions.push(deserializeIx(ix)));
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
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: allInstructions
  }).compileToV0Message(addressLookupTableAccounts);
  
  const transaction = new VersionedTransaction(message);
  
  console.log('\n✍️ Signing transaction...');
  const signed = await wallet.signTransaction(transaction);
  
  console.log('📡 Sending transaction...');
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  
  console.log('⏳ Confirming transaction...');
  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight
  }, 'confirmed');
  
  console.log('✅ Swap complete!');
  console.log('Signature:', signature);
  
  return {
    signature,
    mainSwapAmount: mainQuote.outAmount,
    reflectionAmount: reflectionQuote.outAmount,
    treasuryFee: treasuryFeeAmount.toString()
  };
}
