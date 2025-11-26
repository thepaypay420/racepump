import Decimal from "decimal.js";
import { PublicKey } from "@solana/web3.js";
import { getDb } from "./db";
import { batchTransferTokensFromEscrow, serverKeypair, getMintDecimals } from "./solana";

/**
 * Batched payout system for race settlements
 * Sends payouts in batches of up to 5 recipients per transaction
 * Includes retry logic and failure tracking
 */

const MAX_RECIPIENTS_PER_BATCH = 5;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds base delay

interface PayoutRecipient {
  wallet: string;
  amount: Decimal;
  memo?: string;
}

interface BatchPayoutResult {
  totalSent: number;
  successfulRecipients: string[];
  failedRecipients: Array<{ wallet: string; error: string }>;
  batchResults: Array<{
    batchId: string;
    txSig?: string;
    recipients: string[];
    success: boolean;
    error?: string;
  }>;
}

/**
 * Send payouts to multiple recipients in batches
 * Automatically groups recipients into batches of 5 and handles retries
 */
export async function sendBatchedPayouts(
  raceId: string,
  currency: 'SOL' | 'RACE',
  mint: PublicKey,
  recipients: PayoutRecipient[],
  transferType: 'PAYOUT' | 'RAKE' | 'JACKPOT' = 'PAYOUT'
): Promise<BatchPayoutResult> {
  
  if (recipients.length === 0) {
    return {
      totalSent: 0,
      successfulRecipients: [],
      failedRecipients: [],
      batchResults: []
    };
  }

  console.log(`💸 Starting batched payout: ${recipients.length} recipients, ${currency}, type=${transferType}`);

  const decimals = await getMintDecimals(mint);
  const successfulRecipients: string[] = [];
  const failedRecipients: Array<{ wallet: string; error: string }> = [];
  const batchResults: Array<any> = [];

  // Split recipients into batches of 5
  const batches: PayoutRecipient[][] = [];
  for (let i = 0; i < recipients.length; i += MAX_RECIPIENTS_PER_BATCH) {
    batches.push(recipients.slice(i, i + MAX_RECIPIENTS_PER_BATCH));
  }

  console.log(`📦 Processing ${batches.length} batches of up to ${MAX_RECIPIENTS_PER_BATCH} recipients each`);

  // Process each batch
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchId = `batch_${raceId}_${Date.now()}_${batchIdx}`;
    
    console.log(`\n🔄 Processing batch ${batchIdx + 1}/${batches.length} (${batch.length} recipients)`);

    // Create pending transfer records for all recipients in this batch
    const transferIds: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const recipient = batch[i];
      const transferId = `${batchId}_${i}`;
      transferIds.push(transferId);

      try {
        await getDb().recordSettlementTransfer({
          id: transferId,
          raceId,
          transferType,
          toWallet: recipient.wallet,
          amount: recipient.amount.toString(),
          txSig: '', // Will be updated after successful transfer
          currency,
          ts: Date.now(),
          status: 'PENDING',
          attempts: 0,
          batchId
        });
      } catch (err) {
        console.error(`Failed to create transfer record for ${recipient.wallet}:`, err);
      }
    }

    // Attempt to send batch with retries
    let batchSuccess = false;
    let batchTxSig: string | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        console.log(`  Attempt ${attempt}/${MAX_RETRY_ATTEMPTS} for batch ${batchIdx + 1}...`);

        // Prepare batch transfer
        const transfers = batch.map(r => ({
          to: new PublicKey(r.wallet),
          amount: BigInt(r.amount.mul(new Decimal(10).pow(decimals)).toString()),
          memo: r.memo
        }));

        // Send batch transaction - use correct function based on currency
        if (currency === 'SOL') {
          const { batchTransferSolFromEscrow } = await import('./solana');
          const solTransfers = transfers.map(t => ({
            to: t.to,
            lamports: t.amount,
            memo: t.memo
          }));
          batchTxSig = await batchTransferSolFromEscrow(solTransfers);
        } else {
          batchTxSig = await batchTransferTokensFromEscrow(mint, transfers);
        }
        
        console.log(`  ✅ Batch ${batchIdx + 1} sent successfully: ${batchTxSig}`);
        batchSuccess = true;

        // Update all transfer records to SUCCESS
        for (const transferId of transferIds) {
          try {
            await getDb().updateSettlementTransferStatus(transferId, 'SUCCESS', {
              txSig: batchTxSig,
              incrementAttempts: true
            });
          } catch (err) {
            console.error(`Failed to update transfer ${transferId} status:`, err);
          }
        }

        // Mark all recipients as successful
        batch.forEach(r => successfulRecipients.push(r.wallet));
        break; // Success - exit retry loop

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = errorMsg;
        console.error(`  ❌ Batch ${batchIdx + 1} attempt ${attempt} failed:`, errorMsg);

        // Update transfer records to show failed attempt
        for (const transferId of transferIds) {
          try {
            await getDb().updateSettlementTransferStatus(
              transferId,
              attempt === MAX_RETRY_ATTEMPTS ? 'FAILED' : 'PENDING',
              {
                error: errorMsg,
                incrementAttempts: true
              }
            );
          } catch (err) {
            console.error(`Failed to update transfer ${transferId} after error:`, err);
          }
        }

        // If not last attempt, wait before retry
        if (attempt < MAX_RETRY_ATTEMPTS) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(`  ⏳ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // Record batch result
    batchResults.push({
      batchId,
      txSig: batchTxSig,
      recipients: batch.map(r => r.wallet),
      success: batchSuccess,
      error: batchSuccess ? undefined : lastError
    });

    // If batch failed after all retries, mark recipients as failed
    if (!batchSuccess) {
      batch.forEach(r => {
        failedRecipients.push({
          wallet: r.wallet,
          error: lastError || 'Unknown error'
        });
      });
    }
  }

  const result = {
    totalSent: successfulRecipients.length,
    successfulRecipients,
    failedRecipients,
    batchResults
  };

  console.log(`\n✨ Batched payout complete:`, {
    totalRecipients: recipients.length,
    successful: result.totalSent,
    failed: failedRecipients.length,
    batches: batchResults.length
  });

  return result;
}

/**
 * Retry failed settlement transfers
 * Useful for manual retry via admin endpoint
 */
export async function retryFailedTransfers(limit: number = 100): Promise<{
  attempted: number;
  successful: number;
  failed: number;
}> {
  console.log('🔄 Retrying failed settlement transfers...');
  
  const failedTransfers = await getDb().getFailedSettlementTransfers(limit);
  
  if (failedTransfers.length === 0) {
    console.log('✅ No failed transfers to retry');
    return { attempted: 0, successful: 0, failed: 0 };
  }

  console.log(`Found ${failedTransfers.length} failed transfers to retry`);

  // Group by race and currency for batching
  const groupedByRace = new Map<string, typeof failedTransfers>();
  failedTransfers.forEach(t => {
    const key = `${t.raceId}_${t.currency}`;
    if (!groupedByRace.has(key)) {
      groupedByRace.set(key, []);
    }
    groupedByRace.get(key)!.push(t);
  });

  let successful = 0;
  let failed = 0;

  for (const [key, transfers] of groupedByRace) {
    const [raceId, currency] = key.split('_');
    
    try {
      // Get mint based on currency
      const { getRaceMint } = await import('./solana');
      const mint = currency === 'SOL' 
        ? new PublicKey('So11111111111111111111111111111111111111112') // SOL mint
        : await getRaceMint();

      const recipients: PayoutRecipient[] = transfers.map(t => ({
        wallet: t.toWallet,
        amount: new Decimal(t.amount),
        memo: `Retry: ${t.id}`
      }));

      const result = await sendBatchedPayouts(
        raceId,
        currency as 'SOL' | 'RACE',
        mint,
        recipients,
        transfers[0].transferType as any
      );

      successful += result.totalSent;
      failed += result.failedRecipients.length;

    } catch (error) {
      console.error(`Failed to retry transfers for ${key}:`, error);
      failed += transfers.length;
    }
  }

  console.log(`✨ Retry complete: ${successful} successful, ${failed} failed`);
  return {
    attempted: failedTransfers.length,
    successful,
    failed
  };
}
