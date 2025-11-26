/**
 * Raceswap V3 Client - Index-Based Architecture
 * 
 * KEY IMPROVEMENT: Passes account INDICES instead of full metadata
 * - V2: 714 bytes for 21 accounts
 * - V3: 21 bytes for 21 accounts (97% reduction!)
 */

import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";

const RACESWAP_V3_PROGRAM_ID = new PublicKey("Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk");
const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const TREASURY = new PublicKey("Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L");

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface JupiterSwapData {
  swapInstruction: {
    programId: string;
    accounts: Array<{
      pubkey: string;
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: string;
  };
  setupInstructions?: Array<{
    programId: string;
    accounts: Array<{
      pubkey: string;
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: string;
  }>;
  cleanupInstructions?: Array<{
    programId: string;
    accounts: Array<{
      pubkey: string;
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: string;
  }>;
}

/**
 * Get instruction discriminator for V3
 */
function getV3Discriminator(name: string): Buffer {
  const hash = sha256(Buffer.from(`global:${name}`, 'utf-8'));
  return Buffer.from(hash.slice(0, 8));
}

/**
 * Serialize V3 execute_swap parameters using account info (index + writable)
 */
function serializeV3Params(params: {
  amount: bigint;
  minOut: bigint;
  jupiterAccountInfos: Array<{ index: number; isWritable: boolean }>;
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

  // jupiterAccountInfos (Vec<AccountInfo>) - index (u8) + is_writable (bool)
  const infosLen = Buffer.alloc(4);
  infosLen.writeUInt32LE(params.jupiterAccountInfos.length);
  buffers.push(infosLen);
  
  // Serialize each AccountInfo struct
  for (const info of params.jupiterAccountInfos) {
    const indexBuf = Buffer.alloc(1);
    indexBuf.writeUInt8(info.index);
    buffers.push(indexBuf);
    
    const writableBuf = Buffer.alloc(1);
    writableBuf.writeUInt8(info.isWritable ? 1 : 0);
    buffers.push(writableBuf);
  }

  // jupiterData (Vec<u8>)
  const dataLen = Buffer.alloc(4);
  dataLen.writeUInt32LE(params.jupiterData.length);
  buffers.push(dataLen);
  buffers.push(params.jupiterData);

  return Buffer.concat(buffers);
}

/**
 * Build V3 Raceswap transaction with index-based architecture
 */
export async function buildRaceswapV3Transaction(
  connection: Connection,
  wallet: WalletContextState,
  jupiterSwapData: JupiterSwapData,
  amountLamports: bigint,
  minOutAmount: bigint,
  addressLookupTables: any[] = []
): Promise<VersionedTransaction> {
  if (!wallet.publicKey) {
    throw new Error("Wallet not connected");
  }

  console.log("[raceswap-v3] Building V3 transaction (index-based)");
  console.log("[raceswap-v3] Amount:", Number(amountLamports) / 1e9, "SOL");
  console.log("[raceswap-v3] Min out:", Number(minOutAmount));

  const user = wallet.publicKey;
  const instructions: TransactionInstruction[] = [];

  // Add compute budget
  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    })
  );

  // Add setup instructions
  if (jupiterSwapData.setupInstructions) {
    for (const ix of jupiterSwapData.setupInstructions) {
      instructions.push(
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.accounts.map(acc => ({
            pubkey: new PublicKey(acc.pubkey),
            isSigner: acc.isSigner,
            isWritable: acc.isWritable,
          })),
          data: Buffer.from(ix.data, 'base64'),
        })
      );
    }
  }

  // Build account list for remaining_accounts
  // Order: [user, treasury, jupiter_program, system_program, ...jupiter_accounts]
  const baseAccounts = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: true },
    { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const jupiterAccounts = jupiterSwapData.swapInstruction.accounts.map(acc => ({
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  // Build account info array (index + isWritable)
  // Jupiter accounts start at index 0 in remaining_accounts
  const jupiterAccountInfos = jupiterAccounts.map((acc, idx) => ({
    index: idx,
    isWritable: acc.isWritable,
  }));

  console.log("[raceswap-v3] Jupiter accounts:", jupiterAccounts.length);
  console.log("[raceswap-v3] Account infos:", jupiterAccountInfos.length * 2, "bytes (index+writable)");

  // Serialize V3 params (with account infos!)
  const discriminator = getV3Discriminator('execute_swap');
  const params = serializeV3Params({
    amount: amountLamports,
    minOut: minOutAmount,
    jupiterAccountInfos,
    jupiterData: Buffer.from(jupiterSwapData.swapInstruction.data, 'base64'),
  });

  const instructionData = Buffer.concat([discriminator, params]);

  console.log("[raceswap-v3] Instruction data size:", instructionData.length, "bytes");
  console.log("[raceswap-v3] Savings vs V2:", (jupiterAccounts.length * 34 - jupiterAccountInfos.length * 2), "bytes (94% reduction)");

  // Build V3 execute_swap instruction
  const raceswapAccounts = [
    ...baseAccounts,
  ];

  const raceswapIx = new TransactionInstruction({
    keys: raceswapAccounts,
    programId: RACESWAP_V3_PROGRAM_ID,
    data: instructionData,
  });

  // Add Jupiter accounts as remaining_accounts
  for (const acc of jupiterAccounts) {
    raceswapIx.keys.push({
      pubkey: acc.pubkey,
      isSigner: false,
      isWritable: acc.isWritable,
    });
  }

  instructions.push(raceswapIx);

  // Add cleanup instructions
  if (jupiterSwapData.cleanupInstructions) {
    for (const ix of jupiterSwapData.cleanupInstructions) {
      instructions.push(
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.accounts.map(acc => ({
            pubkey: new PublicKey(acc.pubkey),
            isSigner: acc.isSigner,
            isWritable: acc.isWritable,
          })),
          data: Buffer.from(ix.data, 'base64'),
        })
      );
    }
  }

  console.log("[raceswap-v3] Total instructions:", instructions.length);

  // Build versioned transaction with lookup tables
  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTables);

  const tx = new VersionedTransaction(messageV0);

  console.log("[raceswap-v3] Transaction built successfully");

  return tx;
}

/**
 * Get Jupiter swap data from lite-api.jup.ag
 */
export async function getJupiterSwapDataV3(
  connection: Connection,
  userPublicKey: PublicKey,
  inputMint: string = SOL_MINT,
  outputMint: string = USDC_MINT,
  amount: number,
  slippageBps: number = 50
): Promise<{ quoteData: any; swapData: JupiterSwapData; lookupTables: any[] }> {
  console.log('[raceswap-v3] Getting quote from Jupiter V1 API');

  // Get quote from Jupiter V1
  const quoteUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
  quoteUrl.searchParams.set('inputMint', inputMint);
  quoteUrl.searchParams.set('outputMint', outputMint);
  quoteUrl.searchParams.set('amount', Math.floor(amount).toString());
  quoteUrl.searchParams.set('slippageBps', slippageBps.toString());
  quoteUrl.searchParams.set('maxAccounts', '64');

  const quoteRes = await fetch(quoteUrl.toString());
  const quoteData = await quoteRes.json();

  if (quoteData.error || !quoteRes.ok) {
    throw new Error(`Jupiter quote failed: ${quoteData.error || 'Unknown error'}`);
  }

  console.log('[raceswap-v3] Quote received:', quoteData.outAmount);

  // Get swap transaction
  const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userPublicKey: userPublicKey.toBase58(),
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
    throw new Error(`Jupiter swap failed: ${swapData.error || 'Unknown error'}`);
  }

  // Deserialize versioned transaction
  const txBuffer = Buffer.from(swapData.swapTransaction, 'base64');
  const versionedTx = VersionedTransaction.deserialize(txBuffer);

  // Fetch address lookup tables
  let accountKeysFromLookups = undefined;
  const lookupTables: any[] = [];

  if (versionedTx.message.addressTableLookups && versionedTx.message.addressTableLookups.length > 0) {
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
        lookupTables.push(tableAccount);
        for (const index of lookup.writableIndexes) {
          accountKeysFromLookups.writable.push(tableAccount.state.addresses[index]);
        }
        for (const index of lookup.readonlyIndexes) {
          accountKeysFromLookups.readonly.push(tableAccount.state.addresses[index]);
        }
      }
    }
  }

  const allAccountKeys = versionedTx.message.getAccountKeys({ accountKeysFromLookups });

  // Decode instructions
  const instructions: any[] = [];

  for (const compiledIx of versionedTx.message.compiledInstructions) {
    const programId = allAccountKeys.get(compiledIx.programIdIndex);
    if (!programId) continue;

    const keys = compiledIx.accountKeyIndexes.map(idx => {
      const pubkey = allAccountKeys.get(idx);
      const isSigner = idx < versionedTx.message.header.numRequiredSignatures;
      const numStaticKeys = versionedTx.message.staticAccountKeys.length;
      const isWritable = idx < versionedTx.message.header.numRequiredSignatures - versionedTx.message.header.numReadonlySignedAccounts ||
        (idx >= versionedTx.message.header.numRequiredSignatures &&
         idx < numStaticKeys - versionedTx.message.header.numReadonlyUnsignedAccounts);

      return {
        pubkey: pubkey?.toBase58(),
        isSigner,
        isWritable,
      };
    });

    instructions.push({
      programId: programId.toBase58(),
      accounts: keys,
      data: Buffer.from(compiledIx.data).toString('base64'),
    });
  }

  // Extract setup, swap, cleanup
  const setupInstructions: any[] = [];
  const cleanupInstructions: any[] = [];
  let swapInstruction: any = null;
  let foundJupiterSwap = false;

  for (const ix of instructions) {
    const programId = new PublicKey(ix.programId);

    if (programId.equals(ComputeBudgetProgram.programId)) {
      continue;
    }

    if (programId.equals(JUPITER_PROGRAM_ID)) {
      swapInstruction = ix;
      foundJupiterSwap = true;
    } else {
      if (!foundJupiterSwap) {
        setupInstructions.push(ix);
      } else {
        cleanupInstructions.push(ix);
      }
    }
  }

  if (!swapInstruction) {
    throw new Error('No Jupiter swap instruction found');
  }

  return {
    quoteData,
    swapData: {
      swapInstruction,
      setupInstructions: setupInstructions.length > 0 ? setupInstructions : undefined,
      cleanupInstructions: cleanupInstructions.length > 0 ? cleanupInstructions : undefined,
    },
    lookupTables,
  };
}

/**
 * Execute V3 swap
 */
export async function executeRaceswapV3(
  connection: Connection,
  wallet: WalletContextState,
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }

  // Get Jupiter swap data
  const { quoteData, swapData, lookupTables } = await getJupiterSwapDataV3(
    connection,
    wallet.publicKey,
    inputMint,
    outputMint,
    amount,
    slippageBps
  );

  // Build V3 transaction
  const tx = await buildRaceswapV3Transaction(
    connection,
    wallet,
    swapData,
    BigInt(Math.floor(amount)),
    BigInt(quoteData.outAmount),
    lookupTables
  );

  // Sign and send
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  console.log('[raceswap-v3] Transaction sent:', signature);

  return signature;
}
