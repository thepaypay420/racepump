import { Connection, PublicKey, Transaction, SystemProgram, TransactionInstruction, VersionedTransaction, TransactionMessage, AddressLookupTableAccount, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, createCloseAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Buffer } from 'buffer';

// Use our backend proxy to avoid CORS issues
const JUPITER_QUOTE_API = '/api/jupiter/quote';
const JUPITER_SWAP_API = '/api/jupiter/swap-instructions';
// Fallback treasury if API fails (Common project default)
const DEFAULT_TREASURY = new PublicKey('Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L');
export const RACE_TOKEN_MINT = new PublicKey('t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

let cachedTreasuryKey: PublicKey | null = null;

async function getTreasuryKey(): Promise<PublicKey> {
  if (cachedTreasuryKey) return cachedTreasuryKey;
  try {
    const res = await fetch('/api/treasury');
    if (res.ok) {
      const data = await res.json();
      if (data.treasuryPubkey) {
        cachedTreasuryKey = new PublicKey(data.treasuryPubkey);
        console.log('✅ Loaded treasury key from API:', cachedTreasuryKey.toString());
        return cachedTreasuryKey;
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to fetch treasury key from API, using default:', e);
  }
  return DEFAULT_TREASURY;
}

export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
  platformFeeBps?: number;
  additionalQueryParams?: string;
}

export interface SwapResult {
  signature: string;
  mainSwapAmount: string;
  reflectionAmount: string;
  treasuryFee: string;
}

export interface SwapPlan {
  treasuryFee: string;
  reflectionAmount: string;
  mainSwapAmount: string;
  mainQuote: any;
  reflectionQuote: any;
}

/**
 * Get Jupiter quote for a swap via backend proxy
 */
export async function getJupiterQuote(params: SwapQuoteParams) {
  const { inputMint, outputMint, amount, slippageBps = 50, platformFeeBps, additionalQueryParams } = params;
  
  let url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  if (platformFeeBps) {
    url += `&platformFeeBps=${platformFeeBps}`;
  }
  if (additionalQueryParams) {
    url += additionalQueryParams;
  }
  
  const response = await fetch(url);
  if (!response.ok) {
    let errorMsg = response.statusText;
    try {
      const error = await response.json();
      if (error.error) errorMsg = error.error;
    } catch (e) {
      // use statusText if json parsing fails
    }
    throw new Error(`Jupiter quote failed: ${errorMsg}`);
  }
  
  return await response.json();
}

/**
 * Get swap instructions from Jupiter via backend proxy
 */
async function getSwapInstructions(quote: any, userPublicKey: string, wrapAndUnwrapSol = true, feeAccount?: string) {
  const body: any = {
    quoteResponse: quote,
    userPublicKey,
    wrapAndUnwrapSol,
    useSharedAccounts: true
  };
  
  if (feeAccount) {
    body.feeAccount = feeAccount;
  }

  const response = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    let errorMsg = response.statusText;
    try {
      const error = await response.json();
      if (error.error) errorMsg = error.error;
    } catch (e) {
      // use statusText
    }
    throw new Error(`Jupiter swap instructions failed: ${errorMsg}`);
  }
  
  return await response.json();
}

/**
 * Get estimates for swap plan
 */
export async function getSwapPlan(params: {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
  reflectionMint?: string;
  reflectionBps?: number;
}): Promise<SwapPlan> {
  const { inputMint, outputMint, amount, slippageBps = 50, reflectionMint = RACE_TOKEN_MINT.toString(), reflectionBps = 100 } = params;
  const isSolInput = inputMint === WSOL_MINT.toString();

  // Calculate fees and reflection amount
  // Platform fee is now taken from output, so we don't deduct it from input
  // const treasuryFeeAmount = Math.floor(amount * 0.002); // 0.2% (Old method)
  
  const reflectionAmount = Math.floor(amount * (reflectionBps / 10000)); // reflectionBps is in basis points (100 = 1%)
  const mainSwapAmount = amount - reflectionAmount; // Only deduct reflection amount

  const mainInputMint = isSolInput ? WSOL_MINT.toString() : inputMint;

  // Run quotes in parallel
  const [mainQuote, reflectionQuote] = await Promise.all([
    getJupiterQuote({
      inputMint: mainInputMint,
      outputMint: outputMint,
      amount: mainSwapAmount,
      slippageBps,
      platformFeeBps: 20 // 0.2% platform fee
    }),
    getJupiterQuote({
      inputMint: WSOL_MINT.toString(),
      outputMint: reflectionMint,
      amount: reflectionAmount,
      slippageBps
    })
  ]);

  return {
    treasuryFee: "0.2%", // Display as percentage since it's in output token
    reflectionAmount: reflectionQuote.outAmount,
    mainSwapAmount: mainQuote.outAmount,
    mainQuote,
    reflectionQuote
  };
}

/**
 * Execute atomic swap with treasury fee and RACE reflection
 */
export async function executeSwapWithReflection(
  connection: Connection,
  wallet: any,
  params: {
    inputMint: string;
    outputMint: string;
    amount: number; // in base units (lamports for SOL)
    slippageBps?: number;
    reflectionMint?: string;
    reflectionBps?: number;
  }
): Promise<SwapResult> {
  const userPublicKey = wallet.publicKey.toString();
  const isSolInput = params.inputMint === WSOL_MINT.toString();
  const reflectionMint = params.reflectionMint || RACE_TOKEN_MINT.toString();
  const reflectionBps = params.reflectionBps || 100;
  
  console.log('🚀 Starting atomic swap with reflection (Fixed Flow - Platform Fee)...');
  console.log('Input:', params.inputMint);
  console.log('Output:', params.outputMint);
  console.log('Amount:', params.amount);
  
  // Calculate reflection amount only
  const reflectionAmount = Math.floor(params.amount * (reflectionBps / 10000)); // Bps to multiplier
  // Send 100% of user's input to Jupiter for main swap - Jupiter handles fees from output via platformFeeBps
  // This eliminates leftover dust that triggers Phantom warnings
  // Jupiter will use almost all of the input, leaving only minimal dust (vs. $0.80-$1.00 before)
  // The key fix: we no longer pre-subtract the treasury fee (it's taken from output via platformFeeBps)
  // Reflection swap is funded separately and requires user to have params.amount + reflectionAmount total
  const mainSwapAmount = params.amount; // Send full input amount to Jupiter
  
  console.log('🎁 Reflection amount (from input):', reflectionAmount);
  console.log('💱 Main swap amount (input):', mainSwapAmount, '(100% of input sent to Jupiter)');
  console.log('💰 Treasury fee will be taken from output (0.2%)');
  
  // Step 1: Get quote for main swap (SOL -> Output) with Platform Fee
  console.log('📊 Getting main swap quote...');
  const mainInputMint = isSolInput ? WSOL_MINT.toString() : params.inputMint;
  
  const mainQuote = await getJupiterQuote({
    inputMint: mainInputMint,
    outputMint: params.outputMint,
    amount: mainSwapAmount, // Full input amount
    slippageBps: params.slippageBps,
    platformFeeBps: 20 // 0.2%
  });
  console.log('✅ Main quote:', mainQuote.outAmount);
  
  // Step 2: Get quote for reflection swap (WSOL -> RACE)
  console.log('📊 Getting reflection swap quote (WSOL input)...');
  const reflectionQuote = await getJupiterQuote({
    inputMint: WSOL_MINT.toString(), 
    outputMint: reflectionMint,
    amount: reflectionAmount,
    slippageBps: params.slippageBps,
    additionalQueryParams: '&onlyDirectRoutes=true&dexes=pumpdotfun'
  });
  console.log('✅ Reflection quote:', reflectionQuote.outAmount, 'Reflection tokens');
  
  // Step 3: Prepare Fee Account
  console.log('💰 Preparing treasury fee account...');
  const treasuryWallet = await getTreasuryKey();
  const outputMintPubkey = new PublicKey(params.outputMint);
  
  // Derive Treasury ATA for Output Mint
  const treasuryFeeAccount = await getAssociatedTokenAddress(
    outputMintPubkey,
    treasuryWallet,
    true // allowOwnerOffCurve just in case
  );
  
  console.log('Treasury Fee Account:', treasuryFeeAccount.toString());
  
  // Step 4: Get swap instructions
  console.log('🔧 Building swap instructions...');
  const wrapMain = !isSolInput;
  const mainSwapData = await getSwapInstructions(mainQuote, userPublicKey, wrapMain, treasuryFeeAccount.toString());
  const reflectionSwapData = await getSwapInstructions(reflectionQuote, userPublicKey, false);
  
  // Step 5: Build Instructions
  // Collect all instructions in order
  const allInstructions: TransactionInstruction[] = [];
  
  // Add compute budget
  allInstructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  
  // Create Treasury Fee Account if it doesn't exist
  // We check existence via simulation or just rely on idempotency?
  // Safe check: getAccountInfo
  const feeAccountInfo = await connection.getAccountInfo(treasuryFeeAccount);
  if (!feeAccountInfo) {
    console.log('✨ Creating treasury fee account:', treasuryFeeAccount.toString());
    allInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, // payer
        treasuryFeeAccount,
        treasuryWallet, // owner
        outputMintPubkey
      )
    );
  }

  const deserializeInstruction = (instruction: any) => {
    return new TransactionInstruction({
      programId: new PublicKey(instruction.programId),
      keys: instruction.accounts.map((key: any) => ({
        pubkey: new PublicKey(key.pubkey),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      data: Buffer.from(instruction.data, 'base64'),
    });
  };

  const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

  // Helper to add instructions filtering duplicates/conflicts
  const addInstructions = (instructions: any[]) => {
    if (!instructions) return;
    instructions.forEach((ix: any) => {
      const programId = ix.programId;
      if (programId === COMPUTE_BUDGET_PROGRAM_ID) {
        // Filter compute budget set limits
        const data = Buffer.from(ix.data, 'base64');
        if (data.length > 0 && data[0] === 2) return;
      }
      allInstructions.push(deserializeInstruction(ix));
    });
  };

  // Handle Manual WSOL Setup if Input is SOL (for Reflection Swap split)
  // Since we are splitting SOL input into Main (SOL->Out) and Reflection (WSOL->RACE),
  // Jupiter treats SOL input natively for Main Swap (wrapAndUnwrapSol=true).
  // But for Reflection Swap, we are treating it as WSOL input?
  // Wait, in previous code:
  // Main: isSolInput ? WSOL : Input. wrapMain = !isSolInput.
  // Reflection: Input WSOL. wrapAndUnwrapSol=false.
  
  // If Input is SOL:
  // Main Swap expects SOL input. Jupiter wraps it.
  // Reflection Swap expects WSOL input. We need to wrap SOL -> WSOL manually?
  
  let wsolAta: PublicKey | null = null;
  
  if (isSolInput) {
    wsolAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
    const accountInfo = await connection.getAccountInfo(wsolAta);
    if (!accountInfo) {
      allInstructions.push(
        createAssociatedTokenAccountInstruction(wallet.publicKey, wsolAta, wallet.publicKey, WSOL_MINT)
      );
    }
    
    // Fund WSOL for Reflection Swap ONLY?
    // Previous code funded WSOL with Main + Reflection.
    // But Main swap uses native SOL input if isSolInput is true?
    // Let's check `getSwapInstructions` call.
    // mainInputMint = WSOL (if SOL input). wrapMain = false (if SOL input).
    // Wait, in previous code:
    // const mainInputMint = isSolInput ? WSOL_MINT.toString() : params.inputMint;
    // const wrapMain = !isSolInput;
    // If isSolInput=true, mainInputMint=WSOL, wrapMain=false.
    // This means Jupiter expects WSOL input!
    // So we MUST wrap SOL to WSOL manually for Main Swap too!
    
    // Yes, previous code did manual WSOL setup.
    // Main swap uses 100% of input (mainSwapAmount = params.amount) - sent directly to Jupiter
    // Reflection swap needs separate funding from input
    // Total needed: params.amount (for main) + reflectionAmount (for reflection)
    // User needs to have params.amount + reflectionAmount total for both swaps to execute
    const totalWsolNeeded = mainSwapAmount + reflectionAmount;
    console.log(`💰 Funding WSOL with ${totalWsolNeeded} lamports (${mainSwapAmount} for main swap + ${reflectionAmount} for reflection swap)`);
    
    allInstructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: wsolAta,
        lamports: totalWsolNeeded
      })
    );
    allInstructions.push(createSyncNativeInstruction(wsolAta));
  }
  
  // Add main swap setup
  addInstructions(mainSwapData.setupInstructions);
  if (mainSwapData.swapInstruction) allInstructions.push(deserializeInstruction(mainSwapData.swapInstruction));
  
  // Add reflection swap setup
  addInstructions(reflectionSwapData.setupInstructions);
  if (reflectionSwapData.swapInstruction) allInstructions.push(deserializeInstruction(reflectionSwapData.swapInstruction));
  
  // Add cleanup
  if (isSolInput && wsolAta) {
    allInstructions.push(
      createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey)
    );
  }
  if (!isSolInput && mainSwapData.cleanupInstruction) {
    allInstructions.push(deserializeInstruction(mainSwapData.cleanupInstruction));
  }
  
  // Address Lookup Tables
  const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
  const altAddresses = new Set<string>();
  
  if (mainSwapData.addressLookupTableAddresses) {
    mainSwapData.addressLookupTableAddresses.forEach((addr: string) => altAddresses.add(addr));
  }
  if (reflectionSwapData.addressLookupTableAddresses) {
    reflectionSwapData.addressLookupTableAddresses.forEach((addr: string) => altAddresses.add(addr));
  }

  if (altAddresses.size > 0) {
    console.log(`📖 Loading ${altAddresses.size} address lookup tables...`);
    for (const address of altAddresses) {
      const lookup = await connection.getAddressLookupTable(new PublicKey(address));
      if (lookup.value) addressLookupTableAccounts.push(lookup.value);
    }
  }
  
  console.log('🔨 Building final transaction...');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
  
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: allInstructions
  }).compileToV0Message(addressLookupTableAccounts);
  
  const transaction = new VersionedTransaction(message);
  
  // Simulate first if needed, but signTransaction usually triggers wallet simulation.
  
  console.log('✍️ Signing transaction...');
  const signed = await wallet.signTransaction(transaction);
  
  console.log('📡 Sending transaction...');
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });
  
  console.log('⏳ Confirming transaction...');
  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight
  }, 'confirmed');
  
  console.log('✅ Swap complete!');
  
  return {
    signature,
    mainSwapAmount: mainQuote.outAmount,
    reflectionAmount: reflectionQuote.outAmount,
    treasuryFee: "0.2%" // Output fee
  };
}
