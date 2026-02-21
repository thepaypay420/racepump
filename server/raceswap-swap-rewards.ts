import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { PublicKey } from "@solana/web3.js";

type HolderBoost = {
  raceBalanceBase: string; // base units (6 decimals)
  raceBalanceUi: string; // human-readable (no rounding guarantee)
  tier: "none" | "1m" | "5m" | "10m" | "20m";
  multiplier: number; // applied to drop probabilities (capped server-side)
  nextTier: "1m" | "5m" | "10m" | "20m" | null;
  nextTierTargetUi: number | null;
  progressToNext: number | null; // 0..1
};

type SwapRewardsResponse = {
  recipient: string;
  transactionSignature: string;
  slot: number | null;
  blockhash: string | null;
  seed: string;
  usdValue: number;
  holderBoost: HolderBoost;
  raceReward: {
    won: boolean;
    roll: number;
    winProbability: number;
    rewardAmountBase: string | null;
    rewardSignature: string | null;
    error: string | null;
  };
  cardReward: {
    enabled: boolean;
    disabledReason?: string | null;
    inventory: { poolSize: number; poolHash: string | null };
    won: boolean;
    roll: number;
    winProbability: number;
    pickRoll: number | null;
    pickIndex: number | null;
    mint: string | null;
    rewardSignature: string | null;
    error: string | null;
  };
  error: string | null;
};

const RACE_DECIMALS = 6;
const BALANCE_CACHE_TTL_MS = 20_000;
const balanceCache = new Map<string, { ts: number; value: HolderBoost }>();

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function shaHex(label: string, payload: string): string {
  return createHash("sha256").update(`${label}|${payload}`).digest("hex");
}

function formatRaceUiFromBase(base: bigint): string {
  // Minimal formatting: keep full precision in string without scientific notation.
  // (We only need this for UI/display + tiering; tiering uses numeric conversion below.)
  const s = base.toString();
  if (RACE_DECIMALS === 0) return s;
  const pad = RACE_DECIMALS + 1;
  const padded = s.length < pad ? s.padStart(pad, "0") : s;
  const i = padded.length - RACE_DECIMALS;
  const head = padded.slice(0, i);
  const tail = padded.slice(i).replace(/0+$/, "");
  return tail ? `${head}.${tail}` : head;
}

function getHolderBoostForUiBalance(balanceUi: number): Omit<HolderBoost, "raceBalanceBase" | "raceBalanceUi"> {
  // Milestones as requested:
  // - 1m, 5m, 10m, 20m
  // Multiplier is applied to card probability fully, and partially to RACE probability (in route).
  // Keep conservative caps server-side later.
  const tiers: Array<{ key: HolderBoost["tier"]; min: number; multiplier: number }> = [
    { key: "20m", min: 20_000_000, multiplier: 2.0 },
    { key: "10m", min: 10_000_000, multiplier: 1.5 },
    { key: "5m", min: 5_000_000, multiplier: 1.25 },
    { key: "1m", min: 1_000_000, multiplier: 1.1 },
  ];
  const found = tiers.find((t) => balanceUi >= t.min);
  const tier = found?.key ?? "none";
  const multiplier = found?.multiplier ?? 1.0;

  const ladder = [1_000_000, 5_000_000, 10_000_000, 20_000_000];
  const next = ladder.find((t) => balanceUi < t) ?? null;
  const prev = ladder.filter((t) => t <= balanceUi).pop() ?? 0;
  const progressToNext = next ? clamp01((balanceUi - prev) / (next - prev)) : null;

  const nextTier =
    next === 1_000_000 ? "1m" : next === 5_000_000 ? "5m" : next === 10_000_000 ? "10m" : next === 20_000_000 ? "20m" : null;

  return {
    tier,
    multiplier,
    nextTier,
    nextTierTargetUi: next,
    progressToNext,
  };
}

export async function getVerifiedHolderBoost(args: {
  connection: import("@solana/web3.js").Connection;
  recipient: string;
  raceMintAddress: string | null | undefined;
}): Promise<HolderBoost> {
  const recipient = String(args.recipient || "").trim();
  const mintStr = String(args.raceMintAddress || "").trim();
  if (!recipient) {
    return {
      raceBalanceBase: "0",
      raceBalanceUi: "0",
      tier: "none",
      multiplier: 1,
      nextTier: "1m",
      nextTierTargetUi: 1_000_000,
      progressToNext: 0,
    };
  }

  const cached = balanceCache.get(recipient);
  const now = Date.now();
  if (cached && now - cached.ts < BALANCE_CACHE_TTL_MS) return cached.value;

  let base = 0n;
  try {
    if (!mintStr) throw new Error("RACE mint not configured");
    const ownerPk = new PublicKey(recipient);
    const mintPk = new PublicKey(mintStr);
    
    // Add timeout to prevent hanging on slow RPC responses
    const HOLDER_BOOST_TIMEOUT_MS = 10000; // 10 second timeout
    const accountsPromise = args.connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Holder boost RPC timeout')), HOLDER_BOOST_TIMEOUT_MS);
    });
    
    const accounts = await Promise.race([accountsPromise, timeoutPromise]);
    for (const a of accounts.value) {
      const tokenAmount = (a.account.data as any)?.parsed?.info?.tokenAmount;
      const amountStr = tokenAmount?.amount ? String(tokenAmount.amount) : "0";
      try {
        base += BigInt(amountStr);
      } catch {
        // ignore
      }
    }
  } catch (err: any) {
    // Log timeout errors for debugging, but don't fail the whole request
    if (err?.message?.includes('timeout')) {
      console.warn(`[holder-boost] RPC timeout for ${recipient.slice(0, 8)}...`);
    }
    // ignore (return 0 balance / no boost)
  }

  const uiStr = formatRaceUiFromBase(base);
  const uiNum = Number.parseFloat(uiStr);
  const boostMeta = getHolderBoostForUiBalance(Number.isFinite(uiNum) ? uiNum : 0);
  const out: HolderBoost = {
    raceBalanceBase: base.toString(),
    raceBalanceUi: uiStr,
    ...boostMeta,
  };
  balanceCache.set(recipient, { ts: now, value: out });
  return out;
}

export async function getAvailableCardPool(args: {
  pgPool: Pool | null;
  fallbackAllowlist: string[];
}): Promise<{ mints: string[]; poolHash: string | null }> {
  const fallback = (args.fallbackAllowlist || []).map((s) => String(s || "").trim()).filter(Boolean);

  if (!args.pgPool) {
    const mints = Array.from(new Set(fallback)).sort();
    const poolHash = mints.length ? shaHex("pool", mints.join(",")) : null;
    return { mints, poolHash };
  }

  try {
    const res = await args.pgPool.query(
      `SELECT mint FROM raceswap_nft_pool WHERE enabled = TRUE AND sent = FALSE ORDER BY mint ASC`
    );
    const mints = (res.rows || []).map((r: any) => String(r.mint)).filter(Boolean);
    const poolHash = mints.length ? shaHex("pool", mints.join(",")) : null;
    return { mints, poolHash };
  } catch {
    const mints = Array.from(new Set(fallback)).sort();
    const poolHash = mints.length ? shaHex("pool", mints.join(",")) : null;
    return { mints, poolHash };
  }
}

export async function getPersistedSwapRewardIfAny(args: { pgPool: Pool | null; signature: string }): Promise<SwapRewardsResponse | null> {
  if (!args.pgPool) return null;
  const startTime = Date.now();
  try {
    const res = await args.pgPool.query(`SELECT * FROM raceswap_swap_rewards WHERE main_signature = $1`, [args.signature]);
    const queryTime = Date.now() - startTime;
    // Log slow queries (>2s) for debugging
    if (queryTime > 2000) {
      console.warn(`[swap-rewards] Slow idempotency query: ${queryTime}ms for ${args.signature.slice(0, 16)}...`);
    }
    const row = res.rows?.[0];
    if (!row) return null;
    return {
      recipient: String(row.recipient),
      transactionSignature: String(row.main_signature),
      slot: row.slot !== null && row.slot !== undefined ? Number(row.slot) : null,
      blockhash: row.blockhash ? String(row.blockhash) : null,
      seed: String(row.seed),
      usdValue: Number(row.usd_value ?? 0),
      holderBoost: {
        raceBalanceBase: String(row.verified_race_balance_base ?? "0"),
        raceBalanceUi: String(row.verified_race_balance_ui ?? "0"),
        tier: (row.boost_tier as any) || "none",
        multiplier: Number(row.boost_multiplier ?? 1),
        nextTier: null,
        nextTierTargetUi: null,
        progressToNext: null,
      },
      raceReward: {
        won: Boolean(row.race_won),
        roll: Number(row.race_roll ?? 0),
        winProbability: Number(row.race_win_probability ?? 0),
        rewardAmountBase: row.race_reward_amount_base ? String(row.race_reward_amount_base) : null,
        rewardSignature: row.race_reward_sig ? String(row.race_reward_sig) : null,
        error: null,
      },
      cardReward: {
        enabled: true,
        disabledReason: null,
        inventory: { poolSize: Number(row.card_pool_size ?? 0), poolHash: row.card_pool_hash ? String(row.card_pool_hash) : null },
        won: Boolean(row.card_won),
        roll: Number(row.card_roll ?? 0),
        winProbability: Number(row.card_win_probability ?? 0),
        pickRoll: row.card_pick_roll !== null && row.card_pick_roll !== undefined ? Number(row.card_pick_roll) : null,
        pickIndex: row.card_pick_index !== null && row.card_pick_index !== undefined ? Number(row.card_pick_index) : null,
        mint: row.card_mint ? String(row.card_mint) : null,
        rewardSignature: row.card_reward_sig ? String(row.card_reward_sig) : null,
        error: null,
      },
      error: row.error ? String(row.error) : null,
    };
  } catch (err: any) {
    const queryTime = Date.now() - startTime;
    console.error(`[swap-rewards] Idempotency query failed after ${queryTime}ms:`, err.message);
    return null;
  }
}

export async function persistSwapRewardResult(args: { pgPool: Pool | null; result: SwapRewardsResponse; inputMint?: string; outputMint?: string }): Promise<void> {
  if (!args.pgPool) return;
  const r = args.result;
  const now = Date.now();
  try {
    // Persist the swap reward result
    // Use upsert to allow fixing swaps that were previously saved with $0 USD value
    // Only update if the existing record has $0 USD value (indicates incomplete RPC data on first attempt)
    const insertResult = await args.pgPool.query(
      `INSERT INTO raceswap_swap_rewards (
        main_signature, recipient, slot, blockhash, seed, usd_value,
        verified_race_balance_base, verified_race_balance_ui, boost_tier, boost_multiplier,
        race_roll, race_win_probability, race_won, race_reward_amount_base, race_reward_sig,
        card_roll, card_win_probability, card_won, card_pool_hash, card_pool_size, card_pick_roll, card_pick_index, card_mint, card_reward_sig,
        error, created_at, input_mint, output_mint
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,
        $11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,
        $25,$26,$27,$28
      )
      ON CONFLICT (main_signature) DO UPDATE SET
        usd_value = EXCLUDED.usd_value,
        seed = EXCLUDED.seed,
        blockhash = EXCLUDED.blockhash,
        race_roll = EXCLUDED.race_roll,
        race_win_probability = EXCLUDED.race_win_probability,
        card_roll = EXCLUDED.card_roll,
        card_win_probability = EXCLUDED.card_win_probability,
        card_pool_hash = EXCLUDED.card_pool_hash,
        card_pool_size = EXCLUDED.card_pool_size,
        input_mint = COALESCE(EXCLUDED.input_mint, raceswap_swap_rewards.input_mint),
        output_mint = COALESCE(EXCLUDED.output_mint, raceswap_swap_rewards.output_mint)
      WHERE raceswap_swap_rewards.usd_value = 0 
        AND raceswap_swap_rewards.race_won = FALSE 
        AND raceswap_swap_rewards.card_won = FALSE
      RETURNING main_signature`,
      [
        r.transactionSignature,
        r.recipient,
        r.slot,
        r.blockhash,
        r.seed,
        r.usdValue,
        r.holderBoost.raceBalanceBase,
        r.holderBoost.raceBalanceUi,
        r.holderBoost.tier,
        r.holderBoost.multiplier,
        r.raceReward.roll,
        r.raceReward.winProbability,
        r.raceReward.won,
        r.raceReward.rewardAmountBase,
        r.raceReward.rewardSignature,
        r.cardReward.roll,
        r.cardReward.winProbability,
        r.cardReward.won,
        r.cardReward.inventory.poolHash,
        r.cardReward.inventory.poolSize,
        r.cardReward.pickRoll,
        r.cardReward.pickIndex,
        r.cardReward.mint,
        r.cardReward.rewardSignature,
        r.error,
        now,
        args.inputMint || null,
        args.outputMint || null,
      ]
    );

    // Update leaderboard if:
    // 1. This was a NEW swap (insert), OR
    // 2. This was an UPDATE of a $0 swap (fixing incomplete data)
    // This prevents gaming via replay, while allowing fixed swaps to be counted
    if (insertResult.rowCount && insertResult.rowCount > 0 && r.usdValue >= 1.0 && !r.error) {
      try {
        const { updateLeaderboardEntry } = await import('./swap-contest-leaderboard');
        await updateLeaderboardEntry(r.recipient, r.usdValue, r.transactionSignature, now);
        console.log(`[swap-rewards] Updated leaderboard for ${r.recipient.slice(0, 8)}..., USD=$${r.usdValue}`);
      } catch (leaderboardError) {
        // Log but don't fail the main operation
        console.error('[swap-rewards] Failed to update leaderboard:', leaderboardError);
      }
    }
  } catch (err) {
    console.error('[swap-rewards] Failed to persist swap result:', err);
  }
}

