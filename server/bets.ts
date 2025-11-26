import { Request, Response } from "express";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import { z } from "zod";
import { placePredictionSchema } from "@shared/schema";
import { storage } from "./storage";
import { getDb } from "./db";
import { verifyTransaction, verifySolTransfer, connection, serverKeypair, getMintDecimals } from "./solana";
import { LAMPORTS_PER_SOL, PublicKey as Web3PublicKey, Transaction, SystemProgram } from "@solana/web3.js";

// Simple in-memory bet throttle to mitigate API spam: per wallet+race, min gap between accepted bets
const betThrottleByWalletRace = new Map<string, number>();
// Lightweight IP rate limiting to deter abuse
const ipWindowMs = 10_000; // 10 seconds
const ipMaxPerWindow = 12; // max accepted requests per window per IP
const ipHits = new Map<string, { count: number; resetAt: number }>();

// Validate bet placement request
export async function handlePlaceBet(req: Request, res: Response) {
  try {
    // IP rate limit
    try {
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
      const now = Date.now();
      const rec = ipHits.get(ip);
      if (!rec || now >= rec.resetAt) {
        ipHits.set(ip, { count: 1, resetAt: now + ipWindowMs });
      } else {
        rec.count += 1;
        if (rec.count > ipMaxPerWindow) {
          return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        }
      }
    } catch {}
    console.log('🔍 Bet request received:', req.body);
    
    // Validate request body
    const validatedData = placePredictionSchema.parse(req.body);
    const { raceId, runnerIdx, amount, fromPubkey, txSig, clientId, memo: clientMemo, currency = 'SOL' } = validatedData as any;
    
    console.log('🔍 Parsed bet data:', { raceId, runnerIdx, amount, fromPubkey, txSig });

    // Get race
    const race = await getDb().getRace(raceId);
    if (!race) {
      return res.status(404).json({ error: "Race not found" });
    }

    // Maintenance mode: prevent placing bets on future OPEN races when maintenance is enabled
    const treasState = await getDb().getTreasury();
    const maintenance = (treasState as any).maintenanceMode;
    if (maintenance && race.status === 'OPEN') {
      // Determine if this is the earliest OPEN (active) race; allow bets only for that one
      const open = await getDb().getRaces('OPEN');
      const earliestOpen = open[0];
      if (!earliestOpen || earliestOpen.id !== race.id) {
        return res.status(503).json({ error: 'Maintenance in progress. Betting disabled for upcoming races.' });
      }
    }

    // NOTE: We perform the open/lock timing check AFTER on-chain verification so we can use
    // the verified block time. This avoids false negatives immediately after sending a tx.

    // Validate runner index
    console.log('🔍 Validating runnerIdx:', runnerIdx, 'type:', typeof runnerIdx);
    console.log('🔍 Race runners length:', race.runners.length);
    
    if (runnerIdx === null || runnerIdx === undefined) {
      return res.status(400).json({ error: `runnerIdx is required but got: ${runnerIdx}` });
    }
    
    if (typeof runnerIdx !== 'number' || runnerIdx < 0 || runnerIdx >= race.runners.length) {
      return res.status(400).json({ error: `Invalid runner index: ${runnerIdx} (expected 0-${race.runners.length - 1})` });
    }

    // Validate amount
    const betAmount = new Decimal(amount);
    if (betAmount.lte(0)) {
      return res.status(400).json({ error: "Bet amount must be positive" });
    }
    // Throttle repeated bet attempts from same wallet for same race to reduce spam pressure on RPC
    try {
      const key = `${raceId}:${fromPubkey}`;
      const now = Date.now();
      const last = betThrottleByWalletRace.get(key) || 0;
      // Allow one accepted bet per 3 seconds per wallet per race (UI normally batches)
      if (now - last < 3000) {
        return res.status(429).json({ error: "Please wait before placing another bet for this race" });
      }
      betThrottleByWalletRace.set(key, now);
      // Auto-clean occasionally
      if (betThrottleByWalletRace.size > 10000) {
        for (const [k, v] of betThrottleByWalletRace.entries()) { if (now - v > 10 * 60 * 1000) betThrottleByWalletRace.delete(k); }
      }
    } catch {}
    // Enforce configurable min/max bet limits per currency
    try {
      const minStr = (currency === 'SOL' ? (process.env.BET_MIN_SOL || '').trim() : (process.env.BET_MIN_RACE || process.env.BET_MIN || '').trim());
      const maxStr = (currency === 'SOL' ? (process.env.BET_MAX_SOL || '').trim() : (process.env.BET_MAX_RACE || process.env.BET_MAX || '').trim());
      const minBet = minStr ? new Decimal(minStr) : null;
      const maxBet = maxStr ? new Decimal(maxStr) : null;
      if (minBet && betAmount.lt(minBet)) {
        return res.status(400).json({ error: `Minimum bet is ${minBet.toString()} $${currency}` });
      }
      if (maxBet && betAmount.gt(maxBet)) {
        return res.status(400).json({ error: `Maximum bet is ${maxBet.toString()} $${currency}` });
      }
    } catch {
      // Ignore parsing errors and proceed without limits
    }

    // Reject obviously invalid runner names in memo (defense in depth)
    try {
      if (!Array.isArray(race.runners) || race.runners.length < 1) {
        return res.status(400).json({ error: 'Race has no runners' });
      }
      const r = race.runners[runnerIdx];
      if (!r || typeof r.symbol !== 'string' || r.symbol.length < 1) {
        return res.status(400).json({ error: 'Invalid runner' });
      }
    } catch {}

    // Get treasury to get mint address (for RACE path)
    const treasury = await getDb().getTreasury();
    if (currency !== 'SOL' && !treasury.raceMint) {
      return res.status(500).json({ error: "RACE mint not initialized" });
    }

    // Prevent signature replay across races/endpoints by reserving the tx signature atomically
    if (!await getDb().reserveTransaction(txSig)) {
      // If it's already seen, attempt to treat as idempotent: verify and upsert bet if matching
      try {
        let verificationOk = false;
        if (currency === 'SOL') {
          const lamports = BigInt(new Decimal(amount).mul(new Decimal(10).pow(9)).toString());
          const v = await verifySolTransfer(txSig, serverKeypair.publicKey, lamports, new PublicKey(fromPubkey));
          verificationOk = v.valid;
        } else {
          const decimals = await getMintDecimals(new PublicKey(treasury.raceMint));
          const escrowPubkey = serverKeypair.publicKey;
          const senderPubkey = new PublicKey(fromPubkey);
          const verification = await verifyTransaction(
            txSig,
            new PublicKey(treasury.raceMint),
            escrowPubkey,
            BigInt(new Decimal(amount).mul(new Decimal(10).pow(decimals)).toString()),
            senderPubkey
          );
          verificationOk = verification.valid;
        }
        if (verificationOk) {
          // If a bet with this sig already exists, return success with current totals
          const existing = (await getDb().getBetsForWallet(fromPubkey, raceId) || []).find((b: any) => b.sig === txSig);
          if (existing) {
            const updatedBets = await getDb().getBetsForRace(raceId);
            const totals = calculateRaceTotals(updatedBets, race.runners.length, race.rakeBps);
            return res.json({ success: true, bet: existing, totals, odds: totals.impliedOdds });
          }
        }
      } catch {}
      return res.status(400).json({ error: "Duplicate or already used transaction signature" });
    }

    // Parse wallet addresses for verification
    let senderPubkey: PublicKey;
    let raceMint: PublicKey | null = null;
    const escrowPubkey = serverKeypair.publicKey; // Use server's wallet as escrow

    try {
      senderPubkey = new PublicKey(fromPubkey);
      if (currency !== 'SOL') {
        raceMint = new PublicKey(treasury.raceMint!);
      }
    } catch (error) {
      return res.status(400).json({ error: "Invalid wallet address format" });
    }

    // Verify the transaction on-chain
    console.log(`🔍 Verifying transaction ${txSig} on Solana mainnet...`);
    let verified = false;
    let vMemo: string | undefined = undefined;
    let vBlockMs: number | undefined = undefined;
    let vSlot: number | undefined = undefined;
    if (currency === 'SOL') {
      const lamports = BigInt(betAmount.mul(new Decimal(10).pow(9)).toString());
      const v = await verifySolTransfer(txSig, escrowPubkey, lamports, senderPubkey);
      verified = v.valid;
      vMemo = v.memo;
      vBlockMs = v.blockTimeMs;
      vSlot = v.slot;
    } else {
      const decimals = await getMintDecimals(raceMint!);
      const v = await verifyTransaction(
        txSig,
        raceMint!,
        escrowPubkey,
        BigInt(betAmount.mul(new Decimal(10).pow(decimals)).toString()),
        senderPubkey
      );
      verified = v.valid;
      vMemo = v.memo;
      vBlockMs = v.blockTimeMs;
      vSlot = v.slot;
    }

    if (!verified) {
      // Release reservation on failure
      await getDb().releaseTransaction(txSig);
      // Provide detailed reason if available by re-checking best-effort
      try {
        if (currency === 'SOL') {
          const lamports = BigInt(betAmount.mul(new Decimal(10).pow(9)).toString());
          const v2 = await verifySolTransfer(txSig, escrowPubkey, lamports, senderPubkey);
          const detail = v2?.error ? `: ${v2.error}` : '';
          return res.status(400).json({ error: `Transaction verification failed${detail}` });
        } else {
          const decimals = await getMintDecimals(raceMint!);
          const v2 = await verifyTransaction(
            txSig,
            raceMint!,
            escrowPubkey,
            BigInt(betAmount.mul(new Decimal(10).pow(decimals)).toString()),
            senderPubkey
          );
          const detail = v2?.error ? `: ${v2.error}` : '';
          return res.status(400).json({ error: `Transaction verification failed${detail}` });
        }
      } catch {
        return res.status(400).json({ error: `Transaction verification failed` });
      }
    }

    console.log(`✅ Transaction verified successfully for ${amount} $${currency} bet`);

    // Now enforce race open/lock window using verified block time if available
    const lockMs = (race as any).lockedBlockTimeMs || race.lockedTs || race.startTs;
    const allowedByTime = vBlockMs !== undefined && vBlockMs <= (lockMs || Number.MAX_SAFE_INTEGER);

    // Treat race as OPEN if the scheduler expects it to be OPEN (handles blocker-extended windows)
    let isEffectivelyOpen = race.status === "OPEN";
    try {
      const { RaceStateMachine } = await import('./race-state-machine');
      const expectedStatus = await RaceStateMachine.getExpectedStatus(race as any);
      if (expectedStatus === 'OPEN') isEffectivelyOpen = true;
    } catch {}

    if (!isEffectivelyOpen && !allowedByTime) {
      // Release reservation since we're rejecting
      await getDb().releaseTransaction(txSig);
      return res.status(400).json({ error: "Race is not open for betting" });
    }

    // Require on-chain memo and validate consistency
    let parsedMemo: any = undefined;
    try {
      if (vMemo) {
        let memoText = String(vMemo).trim();
        // If logs included prefixes like "Memo (len N): ", extract the JSON object region
        const startIdx = memoText.indexOf('{');
        const endIdx = memoText.lastIndexOf('}');
        if (startIdx >= 0 && endIdx > startIdx) {
          memoText = memoText.slice(startIdx, endIdx + 1);
        }
        parsedMemo = JSON.parse(memoText);
      }
    } catch (e) {
      try {
        // Last-resort: attempt to re-fetch parsed memo generically (handles bs58/base64/log formats)
        const { verifyTransaction: vt, verifySolTransfer: vs } = await import('./solana');
        if (currency === 'SOL') {
          const lamports = BigInt(betAmount.mul(new Decimal(10).pow(9)).toString());
          const v2 = await vs(txSig, escrowPubkey, lamports, senderPubkey);
          const text = (v2 && v2.memo) ? String(v2.memo) : '';
          const s = text.indexOf('{');
          const e2 = text.lastIndexOf('}');
          if (s >= 0 && e2 > s) parsedMemo = JSON.parse(text.slice(s, e2 + 1));
        } else if (raceMint) {
          const decimals = await getMintDecimals(raceMint);
          const v2 = await vt(txSig, raceMint, escrowPubkey, BigInt(betAmount.mul(new Decimal(10).pow(decimals)).toString()), senderPubkey);
          const text = (v2 && v2.memo) ? String(v2.memo) : '';
          const s = text.indexOf('{');
          const e2 = text.lastIndexOf('}');
          if (s >= 0 && e2 > s) parsedMemo = JSON.parse(text.slice(s, e2 + 1));
        }
      } catch {}
      if (!parsedMemo) {
        // Log snippet for observability (do not include full memo to avoid PII/noise)
        const snippet = (vMemo ? String(vMemo) : '').slice(0, 80).replace(/\n/g, ' ');
        console.warn(`⚠️  Failed to parse on-chain memo JSON. Snippet=",${snippet},"`);
      }
    }
    if (!parsedMemo || parsedMemo.t !== 'BET') {
      await getDb().releaseTransaction(txSig);
      return res.status(400).json({ error: 'Missing or invalid on-chain memo. Ensure wallet attached memo with bet details.' });
    }
    
    // Support both old (raceId, runnerIdx, amount, currency, clientId, ref) and new abbreviated format (r, i, a, u, c, f)
    const memoRaceId = parsedMemo.raceId || parsedMemo.r;
    const memoRunnerIdx = parsedMemo.runnerIdx ?? parsedMemo.i;
    const memoAmount = parsedMemo.amount || parsedMemo.a;
    const memoCurrency = parsedMemo.currency || parsedMemo.u;
    const memoClientId = parsedMemo.clientId || parsedMemo.c;
    const memoRef = parsedMemo.ref || parsedMemo.f;
    
    if (memoRaceId !== raceId) {
      return res.status(400).json({ error: 'Memo raceId mismatch' });
    }
    if (typeof memoRunnerIdx !== 'number' || memoRunnerIdx !== runnerIdx) {
      return res.status(400).json({ error: 'Memo runnerIdx mismatch' });
    }
    if (!memoAmount || !new Decimal(memoAmount).eq(betAmount)) {
      return res.status(400).json({ error: 'Memo amount mismatch' });
    }
    if (typeof memoCurrency !== 'string' || memoCurrency.toUpperCase() !== currency) {
      return res.status(400).json({ error: 'Memo currency mismatch' });
    }

    // Capture referral attribution if present in memo or query
    try {
      const { recordAttribution, normalizeCode } = await import('./referrals');
      const refFromMemo = (memoRef && typeof memoRef === 'string') ? normalizeCode(memoRef) : undefined;
      const refFromQuery = (req.query?.ref as string | undefined) ? normalizeCode(String(req.query?.ref)) : undefined;
      const ref = refFromMemo || refFromQuery;
      if (ref) recordAttribution({ wallet: fromPubkey, code: ref, source: 'bet' });
    } catch {}

    // Use verification metadata
    let blockTimeMs: number | undefined = vBlockMs;
    let slot: number | undefined = vSlot;

    const bet = {
      raceId,
      wallet: fromPubkey,
      runnerIdx,
      amount,
      sig: txSig,
      ts: Date.now(),
      blockTimeMs,
      slot,
      id: `bet_${Date.now()}_${txSig.slice(-8)}`, // Use tx signature suffix instead of random
      clientId: clientId || memoClientId || null,
      memo: clientMemo || null,
      currency
    };

    console.log('🔍 Creating bet with data:', bet);
    await getDb().createBet(bet);

    // Reservation stands as the record; also persist explicitly for TTL cleanup bookkeeping
    await getDb().recordTransaction(txSig);
    console.log(`Bet placed: ${amount} $${currency} on ${race.runners[runnerIdx]?.name || `Runner ${runnerIdx}`} by ${fromPubkey}`);

    // Get updated betting totals
    const updatedBets = await getDb().getBetsForRace(raceId);
    // Include house seed bets in totals so odds reflect coverage
    const rbps = currency === 'SOL' ? 500 : race.rakeBps;
    const totals = calculateRaceTotals(updatedBets, race.runners.length, rbps);

    return res.json({
      success: true,
      bet,
      totals,
      odds: totals.impliedOdds
    });

  } catch (error) {
    console.error("Place bet error:", error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: "Invalid request data",
        details: error.errors 
      });
    }

    res.status(500).json({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    });
  }
}

// Calculate race totals and implied odds
export function calculateRaceTotals(bets: any[], runnerCount: number, rakeBps: number = 300) {
  const runnerTotals = new Array(runnerCount).fill(0).map(() => new Decimal(0));
  let totalPot = new Decimal(0);

  // Sum bets by runner
  for (const bet of bets) {
    const amount = new Decimal(bet.amount);
    runnerTotals[bet.runnerIdx] = runnerTotals[bet.runnerIdx].add(amount);
    totalPot = totalPot.add(amount);
  }

  // Calculate implied odds (actual payout ratio)
  const impliedOdds = runnerTotals.map(runnerTotal => {
    if (runnerTotal.eq(0)) {
      return new Decimal(100); // 100x if no bets (still high but reasonable)
    }
    
    // Parimutuel odds: net payout pool / runner pool
    // Apply the race's rake percentage (rakeBps / 10000)
    const rakeDecimal = new Decimal(rakeBps).div(10000);
    const netPool = totalPot.mul(new Decimal(1).sub(rakeDecimal));
    const odds = netPool.div(runnerTotal);
    return odds; // Actual payout ratio (e.g., 2.5x means you get 2.5x your bet)
  });

  return {
    totalPot: totalPot.toString(),
    runnerTotals: runnerTotals.map(total => total.toString()),
    impliedOdds: impliedOdds.map(odds => odds.toFixed(1)),
    betCount: bets.length
  };
}

// Get race totals for display
export async function handleGetRaceTotals(req: Request, res: Response) {
  try {
    const { raceId } = req.params;
    
    const race = await getDb().getRace(raceId);
    if (!race) {
      return res.status(404).json({ error: "Race not found" });
    }

    const bets = await getDb().getBetsForRace(raceId);
    // Include seeds; adjust rake for SOL
    const rbps = (req.query.currency as string)?.toUpperCase() === 'SOL' ? 500 : race.rakeBps;
    const totals = calculateRaceTotals(bets, race.runners.length, rbps);

    res.json(totals);
  } catch (error) {
    console.error("Get race totals error:", error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    });
  }
}

// Get user bets for a race
export async function handleGetUserBets(req: Request, res: Response) {
  try {
    const { raceId } = req.params;
    const { wallet } = req.query;

    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({ error: "Wallet address required" });
    }

    const race = await getDb().getRace(raceId);
    if (!race) {
      return res.status(404).json({ error: "Race not found" });
    }

    // Filter bets to match the user's current currency selection on the client.
    // Default any missing currency to 'RACE' for backward compatibility, but expose both when needed by adding a query param in future.
    const currency = String((req.query.currency as string) || '').toUpperCase();
    const allUserBets = await getDb().getBetsForWallet(wallet, raceId);
    const userBets = currency === 'SOL' || currency === 'RACE'
      ? allUserBets.filter((b: any) => (b?.currency || 'RACE') === currency)
      : allUserBets;

    // Add runner details to bets
    const enrichedBets = userBets.map(bet => ({
      ...bet,
      runner: race.runners[bet.runnerIdx]
    }));

    // Calculate total wagered
    const totalWagered = userBets.reduce(
      (sum, bet) => sum.add(new Decimal(bet.amount)),
      new Decimal(0)
    );

    res.json({
      bets: enrichedBets,
      totalWagered: totalWagered.toString(),
      count: userBets.length
    });

  } catch (error) {
    console.error("Get user bets error:", error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    });
  }
}
