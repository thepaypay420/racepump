import Decimal from 'decimal.js';
import { getDb } from './db';
import { PublicKey } from '@solana/web3.js';

export type ReferralSettings = {
  enabled: boolean;
  discountBps: number;
  level1Bps: number;
  level2Bps: number;
  level3Bps: number;
  poolBps: number;
  minPayout: string;
  payoutCron: string;
};

export async function getSettings(): Promise<ReferralSettings> {
  const row = await getDb()?.getReferralSettings?.();
  return {
    enabled: Boolean(row?.enabled ?? 1),
    discountBps: Number(row?.discountBps ?? 500),
    level1Bps: Number(row?.level1Bps ?? 3000),
    level2Bps: Number(row?.level2Bps ?? 600),
    level3Bps: Number(row?.level3Bps ?? 200),
    poolBps: Number(row?.poolBps ?? 5000),
    minPayout: String(row?.minPayout ?? '0.01'),
    payoutCron: String(row?.payoutCron ?? 'daily')
  };
}

export function normalizeCode(raw: string): string {
  const base = String(raw || '').trim().toLowerCase();
  return base.replace(/[^a-z0-9-_]/g, '').slice(0, 24);
}

export function generateCodeFromWallet(wallet: string): string {
  const suffix = wallet.slice(0, 4).toLowerCase();
  return `racer-${suffix}`;
}

export async function setUserCode(wallet: string, desired?: string): Promise<{ wallet: string; code: string }> {
  let code = desired ? normalizeCode(desired) : generateCodeFromWallet(wallet);
  if (!code || code.length < 3) code = generateCodeFromWallet(wallet);
  const existing = await getDb()?.getReferralUserByCode?.(code);
  if (existing && existing.wallet !== wallet) {
    const short = wallet.slice(-4).toLowerCase();
    code = `${code}-${short}`.slice(0, 24);
  }
  await getDb()?.upsertReferralUser?.({ wallet, code });
  return { wallet, code };
}

export async function getUserCode(wallet: string): Promise<{ wallet: string; code: string }> {
  const row = await getDb()?.getReferralUserByWallet?.(wallet);
  if (row && (row as any).code) return { wallet, code: (row as any).code };
  return setUserCode(wallet);
}

export async function recordAttribution({ wallet, code, source }: { wallet: string; code: string; source?: string }): Promise<void> {
  const normalized = normalizeCode(code);
  if (!normalized) return;
  // First-click wins: do not override existing attribution
  try {
    const existing = await getDb()?.getReferralAttributionForWallet?.(wallet) as any;
    if (existing && existing.code) return;
  } catch {}
  const id = `attr_${wallet}_${normalized}`;
  await getDb()?.upsertReferralAttribution?.({ id, wallet, code: normalized, source });
}

export async function getAttributionForWallet(wallet: string): Promise<string | undefined> {
  const row = await getDb()?.getReferralAttributionForWallet?.(wallet);
  return (row as any)?.code;
}

export async function computeReferralRewards({ totalRake, currency, raceId, betterWallet, lineage }: {
  totalRake: Decimal;
  currency: 'RACE' | 'SOL';
  raceId: string;
  betterWallet: string;
  lineage: Array<{ wallet: string; level: number }>;
}): Promise<Array<{ id: string; raceId: string; fromWallet: string; toWallet: string; level: number; currency: 'RACE' | 'SOL'; amount: string }>> {
  const settings = await getSettings();
  if (!settings.enabled) return [];
  const pool = totalRake.mul(new Decimal(settings.poolBps).div(10000));
  const l1 = pool.mul(new Decimal(settings.level1Bps).div(10000));
  const l2 = pool.mul(new Decimal(settings.level2Bps).div(10000));
  const l3 = pool.mul(new Decimal(settings.level3Bps).div(10000));
  const discount = totalRake.mul(new Decimal(settings.discountBps).div(10000));
  const byLevel: Record<number, Decimal> = { 0: discount, 1: l1, 2: l2, 3: l3 } as any;
  const rewards: Array<{ id: string; raceId: string; fromWallet: string; toWallet: string; level: number; currency: 'RACE' | 'SOL'; amount: string }> = [];
  if (lineage && lineage.length > 0 && byLevel[0]?.gt?.(0)) {
    const amt0 = byLevel[0];
    rewards.push({
      id: `ref_${raceId}_${betterWallet}_${betterWallet}_0`,
      raceId,
      fromWallet: betterWallet,
      toWallet: betterWallet,
      level: 0,
      currency,
      amount: amt0.toDecimalPlaces(9, Decimal.ROUND_DOWN).toString()
    });
  }
  if (lineage && Array.isArray(lineage)) {
    lineage.forEach(({ wallet, level }) => {
      const amt = byLevel[level];
      if (!amt || amt.lte(0)) return;
      rewards.push({
        id: `ref_${raceId}_${betterWallet}_${wallet}_${level}`,
        raceId,
        fromWallet: betterWallet,
        toWallet: wallet,
        level,
        currency,
        amount: amt.toDecimalPlaces(9, Decimal.ROUND_DOWN).toString()
      });
    });
  }
  return rewards;
}

export async function resolveLineageFromCode(code: string): Promise<Array<{ wallet: string; level: number }>> {
  const out: Array<{ wallet: string; level: number }> = [];
  const l1 = await getDb()?.getReferralUserByCode?.(code);
  if (!l1?.wallet) return out;
  out.push({ wallet: l1.wallet, level: 1 });
  const l2Code = await getAttributionForWallet(l1.wallet);
  if (l2Code) {
    const l2 = await getDb()?.getReferralUserByCode?.(l2Code);
    if (l2?.wallet && l2.wallet !== l1.wallet) out.push({ wallet: l2.wallet, level: 2 });
    const l3Code = l2 ? await getAttributionForWallet(l2.wallet) : undefined;
    if (l3Code) {
      const l3 = await getDb()?.getReferralUserByCode?.(l3Code);
      if (l3?.wallet && !out.some(x => x.wallet === l3.wallet)) out.push({ wallet: l3.wallet, level: 3 });
    }
  }
  return out;
}

export function extractReferralCodeFromMemo(memo?: string): string | undefined {
  if (!memo) return undefined;
  try {
    const start = memo.indexOf('{');
    const end = memo.lastIndexOf('}');
    const txt = start >= 0 && end > start ? memo.slice(start, end + 1) : memo;
    const obj = JSON.parse(txt);
    if (obj && typeof obj.ref === 'string') {
      return normalizeCode(obj.ref);
    }
  } catch {}
  return undefined;
}

export async function queueReferralRewards(rows: Array<{ id: string; raceId: string; fromWallet: string; toWallet: string; level: number; currency: 'RACE' | 'SOL'; amount: string }>): Promise<void> {
  for (const r of rows) {
    try { await getDb()?.insertReferralReward?.(r); } catch {}
  }
}

export async function aggregateForWallet(wallet: string): Promise<any> {
  const agg = await getDb()?.getReferralAggregate?.(wallet);
  return agg || { wallet, directCount: 0, indirectCount: 0, totalRewards: '0', totalPaid: '0', lastUpdated: 0 };
}

export async function payReferralRewards(limit: number = 200): Promise<{ paid: number; failed: number }> {
  const rows = await getDb()?.getUnpaidReferralRewards?.(limit);
  if (!rows || rows.length === 0) {
    console.log('[referral-payout] No unpaid rewards found');
    return { paid: 0, failed: 0 };
  }

  console.log(`[referral-payout] Processing ${rows.length} unpaid rewards`);
  
  // SECURITY: Filter rewards to only include verified wallets (except level 0 which is the bettor themselves)
  const verifiedRewards: Array<any> = [];
  const unverifiedRewards: Array<any> = [];
  
  for (const reward of rows) {
    // Level 0 = bettor discount (self), always allow
    if (reward.level === 0) {
      verifiedRewards.push(reward);
      continue;
    }
    
    // Levels 1-3 require wallet verification
    const user = await getDb()?.getReferralUserByWallet?.(reward.toWallet);
    if (user?.verified) {
      verifiedRewards.push(reward);
    } else {
      unverifiedRewards.push(reward);
      console.log(`[referral-payout] ⚠️ Skipping unverified wallet ${reward.toWallet} (level ${reward.level}, amount: ${reward.amount} ${reward.currency})`);
    }
  }
  
  if (unverifiedRewards.length > 0) {
    console.log(`[referral-payout] ⚠️ ${unverifiedRewards.length} rewards skipped due to unverified wallets. Wallets must verify ownership to receive payouts.`);
  }
  
  // OPTIMIZATION: Aggregate rewards by wallet and currency to avoid sending dust
  // This combines multiple small rewards into one payment per wallet
  const aggregatedRewards = new Map<string, { wallet: string; currency: string; totalAmount: Decimal; rewardIds: string[] }>();
  
  for (const reward of verifiedRewards) {
    const key = `${reward.toWallet}:${reward.currency}`;
    const existing = aggregatedRewards.get(key);
    const amount = new Decimal(String(reward.amount || '0'));
    
    if (existing) {
      existing.totalAmount = existing.totalAmount.add(amount);
      existing.rewardIds.push(reward.id);
    } else {
      aggregatedRewards.set(key, {
        wallet: reward.toWallet,
        currency: reward.currency,
        totalAmount: amount,
        rewardIds: [reward.id]
      });
    }
  }
  
  console.log(`[referral-payout] Aggregated ${verifiedRewards.length} rewards into ${aggregatedRewards.size} payments`);
  
  // Filter by minimum threshold (0.01 SOL or RACE)
  const MIN_PAYOUT = new Decimal('0.01');
  const eligiblePayments: Array<{ wallet: string; currency: string; totalAmount: Decimal; rewardIds: string[] }> = [];
  const belowThreshold: Array<{ wallet: string; currency: string; totalAmount: Decimal; rewardIds: string[] }> = [];
  
  for (const payment of Array.from(aggregatedRewards.values())) {
    if (payment.totalAmount.gte(MIN_PAYOUT)) {
      eligiblePayments.push(payment);
    } else {
      belowThreshold.push(payment);
      console.log(`[referral-payout] ⏳ Wallet ${payment.wallet} has ${payment.totalAmount.toString()} ${payment.currency} (below 0.01 minimum, will accumulate)`);
    }
  }
  
  console.log(`[referral-payout] ${eligiblePayments.length} payments above threshold, ${belowThreshold.length} below (will accumulate)`);
  
  let paid = 0, failed = unverifiedRewards.length;
  const { getRaceMint, getMintDecimals, batchTransferSolFromEscrow, batchTransferTokensFromEscrow } = await import('./solana');
  
  // Get RACE mint info for token transfers
  let mint: any = null; 
  let decimals = 9;
  try { 
    mint = await getRaceMint(); 
    decimals = await getMintDecimals(mint); 
  } catch (e) {
    console.warn('[referral-payout] Failed to get RACE mint, token payouts will be skipped:', e);
  }

  // Separate eligible payments by currency
  const solPayments = eligiblePayments.filter(p => p.currency === 'SOL');
  const racePayments = eligiblePayments.filter(p => p.currency === 'RACE' || p.currency === 'SPL');

  // Process SOL payments in batches (one payment per wallet)
  if (solPayments.length > 0) {
    console.log(`[referral-payout] Processing ${solPayments.length} SOL payments (aggregated from ${solPayments.reduce((sum, p) => sum + p.rewardIds.length, 0)} rewards) in batches of 5`);
    const result = await processAggregatedPayouts(solPayments, 'SOL', 5, async (batch) => {
      const transfers = batch.map(p => {
        const lamports = BigInt(p.totalAmount.mul(new Decimal(10).pow(9)).toString());
        return {
          to: new PublicKey(p.wallet),
          lamports,
          memo: `ref:payout:${p.rewardIds.length}rewards`
        };
      });
      return await batchTransferSolFromEscrow(transfers);
    });
    paid += result.paid;
    failed += result.failed;
  }

  // Process RACE/SPL token payments in batches (independent from SOL payouts)
  if (racePayments.length > 0 && mint) {
    try {
      console.log(`[referral-payout] Processing ${racePayments.length} RACE payments (aggregated from ${racePayments.reduce((sum, p) => sum + p.rewardIds.length, 0)} rewards) in batches of 5`);
      const result = await processAggregatedPayouts(racePayments, 'RACE', 5, async (batch) => {
        const transfers = batch.map(p => {
          const tokens = BigInt(p.totalAmount.mul(new Decimal(10).pow(decimals)).toString());
          return {
            to: new PublicKey(p.wallet),
            amount: tokens,
            memo: `ref:payout:${p.rewardIds.length}rewards`
          };
        });
        return await batchTransferTokensFromEscrow(mint, transfers);
      });
      paid += result.paid;
      failed += result.failed;
    } catch (e) {
      console.error(`[referral-payout] RACE token payouts failed (SOL payouts unaffected):`, e);
      failed += racePayments.reduce((sum, p) => sum + p.rewardIds.length, 0);
    }
  } else if (racePayments.length > 0 && !mint) {
    console.warn(`[referral-payout] Skipping ${racePayments.length} RACE payments (mint not available - this is normal if RACE token not deployed yet)`);
    failed += racePayments.reduce((sum, p) => sum + p.rewardIds.length, 0);
  }

  console.log(`[referral-payout] Complete: ${paid} paid, ${failed} failed`);
  return { paid, failed };
}

// Helper function to process aggregated payouts with pay-first-mark-later safety
async function processAggregatedPayouts(
  payments: Array<{ wallet: string; currency: string; totalAmount: Decimal; rewardIds: string[] }>,
  currency: string,
  batchSize: number,
  transferFn: (batch: Array<{ wallet: string; currency: string; totalAmount: Decimal; rewardIds: string[] }>) => Promise<string>
): Promise<{ paid: number; failed: number }> {
  let paid = 0, failed = 0;

  // Split payments into batches
  for (let i = 0; i < payments.length; i += batchSize) {
    const batch = payments.slice(i, Math.min(i + batchSize, payments.length));
    
    if (batch.length === 0) continue;

    try {
      console.log(`[referral-payout] Batch ${Math.floor(i / batchSize) + 1}: Processing ${batch.length} ${currency} payments (${batch.reduce((sum, p) => sum + p.rewardIds.length, 0)} rewards)`);
      
      // SAFETY: Pay first (submit to blockchain and wait for confirmation)
      const txSig = await transferFn(batch);
      console.log(`[referral-payout] Batch ${Math.floor(i / batchSize) + 1}: Transaction confirmed: ${txSig}`);
      
      // SAFETY: Only mark as paid AFTER blockchain confirmation
      for (const payment of batch) {
        for (const rewardId of payment.rewardIds) {
          try {
            await getDb()?.markReferralRewardPaid?.(rewardId, txSig);
            paid++;
          } catch (e) {
            console.error(`[referral-payout] Failed to mark reward ${rewardId} as paid:`, e);
            failed++;
          }
        }
        console.log(`[referral-payout] Marked ${payment.rewardIds.length} rewards as paid for ${payment.wallet}: ${payment.totalAmount.toString()} ${currency}`);
      }
      
    } catch (e) {
      console.error(`[referral-payout] Batch ${Math.floor(i / batchSize) + 1} failed:`, e);
      // If batch fails, all rewards in batch stay unpaid (safe to retry next cycle)
      const failedCount = batch.reduce((sum, p) => sum + p.rewardIds.length, 0);
      failed += failedCount;
      console.warn(`[referral-payout] ${failedCount} rewards will be retried in next payout cycle`);
    }
  }

  return { paid, failed };
}

let payoutTimer: NodeJS.Timeout | null = null;
export function startReferralPayouts(intervalMs: number = 24 * 60 * 60 * 1000) {
  if (payoutTimer) clearInterval(payoutTimer as any);
  
  // Schedule payouts to run every 24 hours (no immediate run on startup)
  // This prevents sending dust payments every time the server restarts
  payoutTimer = setInterval(() => { 
    console.log('[referral-payout] Running scheduled payout...');
    payReferralRewards(500).catch((e) => {
      console.error('[referral-payout] Scheduled payout failed:', e);
    }); 
  }, intervalMs);
  
  const nextPayoutHours = intervalMs / 1000 / 60 / 60;
  console.log(`[referral-payout] Scheduler started - first payout in ${nextPayoutHours} hours, then every ${nextPayoutHours} hours after that`);
}
