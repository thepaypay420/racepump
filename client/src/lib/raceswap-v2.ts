/**
 * Raceswap V2 - Simplified Non-Custodial Architecture
 * 
 * Key differences from V1:
 * - User owns all tokens (no vault)
 * - User signs for Jupiter (no swap_authority PDA)
 * - Simple SOL treasury fee
 * - No config account needed
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
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";

const RACESWAP_V2_PROGRAM_ID = new PublicKey("Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk");
const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const TREASURY = new PublicKey("Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L");

interface JupiterSwapData {
  swapInstruction: {
    programId: string;
    accounts: Array<{
      pubkey: string;
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: string; // base64
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
 * Get instruction discriminator for V2
 */
function getV2Discriminator(name: string): Buffer {
  const hash = sha256(Buffer.from(`global:${name}`, 'utf-8'));
  return Buffer.from(hash.slice(0, 8));
}

/**
 * Serialize V2 execute_swap parameters using Borsh format
 */
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

/**
 * Build V2 Raceswap transaction - simplified non-custodial architecture
 */
export async function buildRaceswapV2Transaction(
  connection: Connection,
  wallet: WalletContextState,
  jupiterSwapData: JupiterSwapData,
  amountLamports: bigint,
  minOutAmount: bigint
): Promise<Transaction> {
  if (!wallet.publicKey) {
    throw new Error("Wallet not connected");
  }

  console.log("[raceswap-v2] Building V2 transaction");
  console.log("[raceswap-v2] Amount:", Number(amountLamports) / 1e9, "SOL");
  console.log("[raceswap-v2] Min out:", Number(minOutAmount));

  const user = wallet.publicKey;
  const tx = new Transaction();

  // Add compute budget
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    })
  );

  // Add setup instructions from Jupiter
  if (jupiterSwapData.setupInstructions) {
    console.log("[raceswap-v2] Adding", jupiterSwapData.setupInstructions.length, "setup instructions");
    for (const ix of jupiterSwapData.setupInstructions) {
      tx.add(
        new TransactionInstruction({
          keys: ix.accounts.map((acc) => ({
            pubkey: new PublicKey(acc.pubkey),
            isSigner: acc.isSigner,
            isWritable: acc.isWritable,
          })),
          programId: new PublicKey(ix.programId),
          data: Buffer.from(ix.data, "base64"),
        })
      );
    }
  }

  // Build V2 execute_swap instruction
  const jupiterAccounts = jupiterSwapData.swapInstruction.accounts.map((acc) => ({
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  console.log("[raceswap-v2] Jupiter accounts:", jupiterAccounts.length);

  const discriminator = getV2Discriminator("execute_swap");
  const params = serializeV2Params({
    amount: amountLamports,
    minOut: minOutAmount,
    jupiterAccounts,
    jupiterData: Buffer.from(jupiterSwapData.swapInstruction.data, "base64"),
  });

  const instructionData = Buffer.concat([discriminator, params]);

  // V2 accounts: simple and clean!
  const raceswapAccounts = [
    { pubkey: user, isSigner: true, isWritable: true }, // user
    { pubkey: TREASURY, isSigner: false, isWritable: true }, // treasury
    { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false }, // jupiter_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    // Jupiter accounts go in remaining_accounts
    ...jupiterAccounts.map((acc) => ({
      pubkey: acc.pubkey,
      isSigner: false, // V2: user signs, not individual accounts
      isWritable: acc.isWritable,
    })),
  ];

  console.log("[raceswap-v2] Total accounts:", raceswapAccounts.length);

  const raceswapIx = new TransactionInstruction({
    keys: raceswapAccounts,
    programId: RACESWAP_V2_PROGRAM_ID,
    data: instructionData,
  });

  tx.add(raceswapIx);

  // Add cleanup instructions from Jupiter
  if (jupiterSwapData.cleanupInstructions) {
    console.log("[raceswap-v2] Adding", jupiterSwapData.cleanupInstructions.length, "cleanup instructions");
    for (const ix of jupiterSwapData.cleanupInstructions) {
      tx.add(
        new TransactionInstruction({
          keys: ix.accounts.map((acc) => ({
            pubkey: new PublicKey(acc.pubkey),
            isSigner: acc.isSigner,
            isWritable: acc.isWritable,
          })),
          programId: new PublicKey(ix.programId),
          data: Buffer.from(ix.data, "base64"),
        })
      );
    }
  }

  console.log("[raceswap-v2] Transaction built successfully!");
  console.log("[raceswap-v2] Total instructions:", tx.instructions.length);

  return tx;
}

/**
 * Helper to get Jupiter swap data using Jupiter V1 API
 * Uses the same endpoints as your main app (lite-api.jup.ag)
 */
export async function getJupiterSwapData(
  userPublicKey: PublicKey,
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50
): Promise<{ quoteData: any; swapData: JupiterSwapData }> {
  // Get quote from Jupiter V1 API (same as main app)
  const quoteUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
  quoteUrl.searchParams.set('inputMint', inputMint);
  quoteUrl.searchParams.set('outputMint', outputMint);
  quoteUrl.searchParams.set('amount', Math.floor(amount).toString());
  quoteUrl.searchParams.set('slippageBps', slippageBps.toString());
  quoteUrl.searchParams.set('maxAccounts', '40');
  quoteUrl.searchParams.set('instructionVersion', 'V2');

  console.log('[raceswap-v2] Getting quote from:', quoteUrl.toString());

  const quoteRes = await fetch(quoteUrl.toString());
  const quoteData = await quoteRes.json();

  if (quoteData.error || !quoteRes.ok) {
    throw new Error(`Jupiter quote failed: ${quoteData.error || 'Unknown error'}`);
  }

  console.log('[raceswap-v2] Quote received:', quoteData.outAmount);

  // Get swap transaction from Jupiter V1 API (returns full transaction)
  console.log('[raceswap-v2] Getting swap transaction from lite-api.jup.ag...');
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

  console.log('[raceswap-v2] Swap transaction received, deserializing...');

  // Deserialize versioned transaction
  const txBuffer = Buffer.from(swapData.swapTransaction, 'base64');
  const versionedTx = VersionedTransaction.deserialize(txBuffer);
  
  console.log('[raceswap-v2] Transaction version:', versionedTx.version);
  console.log('[raceswap-v2] Lookup tables:', versionedTx.message.addressTableLookups?.length || 0);

  // Fetch address lookup table data if needed
  let accountKeysFromLookups = undefined;
  
  if (versionedTx.message.addressTableLookups && versionedTx.message.addressTableLookups.length > 0) {
    console.log('[raceswap-v2] Fetching address lookup table data...');
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
        for (const index of lookup.writableIndexes) {
          accountKeysFromLookups.writable.push(tableAccount.state.addresses[index]);
        }
        for (const index of lookup.readonlyIndexes) {
          accountKeysFromLookups.readonly.push(tableAccount.state.addresses[index]);
        }
      }
    }
    console.log('[raceswap-v2] Loaded lookup table addresses:', 
      accountKeysFromLookups.writable.length + accountKeysFromLookups.readonly.length);
  }
  
  const allAccountKeys = versionedTx.message.getAccountKeys({ accountKeysFromLookups });

  // Decode compiled instructions
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

  console.log('[raceswap-v2] Decoded', instructions.length, 'instructions');

  // Identify instruction types
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

  console.log('[raceswap-v2] Extracted:', setupInstructions.length, 'setup,', 
    '1 swap,', cleanupInstructions.length, 'cleanup instructions');

  return {
    quoteData,
    swapData: {
      swapInstruction,
      setupInstructions: setupInstructions.length > 0 ? setupInstructions : undefined,
      cleanupInstructions: cleanupInstructions.length > 0 ? cleanupInstructions : undefined,
    }
  };
}
