import { Request, Response } from "express";
import { z } from "zod";
import { Race, RaceStatus, Claim, createRaceSchema, lockRaceSchema, cancelRaceSchema, faucetSchema, Runner } from "@shared/schema";
import { pctGain, LivePriceByMint } from "@shared/prices";
import { getDb } from "./db";
import { getNewPumpfunTokens as getTopPumpfunTokens } from "./runners";
// RNG removed - winner determined by price performance only
import { refundRace } from "./settlement";
import { mintTokensToAddress, getSplTokenBalance } from "./solana";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import fs from "node:fs";
import path from "node:path";

// Environment validation with deployment-safe defaults
const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === 'true';
// Require ADMIN_TOKEN from environment only; never use an in-repo default
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
console.log('🔐 Admin token configured:', ADMIN_TOKEN ? 'SET' : 'NOT SET');

// Middleware to verify admin token
export function requireAdminAuth(req: Request, res: Response, next: any) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Admin token required" });
  }

  const token = authHeader.substring(7);
  
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Invalid admin token" });
  }

  console.log(`Admin action: ${req.method} ${req.path} by IP ${req.ip}`);
  next();
}

// Rate limiting for admin endpoints
const adminActionTimes = new Map<string, number[]>();
// Additional per-wallet faucet cooldowns
const publicFaucetCooldownByWallet = new Map<string, number>();
const adminFaucetCooldownByWallet = new Map<string, number>();

function rateLimit(ip: string, maxActions: number = 10, windowMs: number = 60000): boolean {
  const now = Date.now();
  const actions = adminActionTimes.get(ip) || [];
  
  // Remove old actions outside window
  const validActions = actions.filter(time => now - time < windowMs);
  
  if (validActions.length >= maxActions) {
    return false;
  }
  
  validActions.push(now);
  adminActionTimes.set(ip, validActions);
  return true;
}

// Create new race
export async function handleCreateRace(req: Request, res: Response) {
  try {
    if (!rateLimit(req.ip || 'unknown', 5, 60000)) {
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    const validatedData = createRaceSchema.parse({
      startMinutesFromNow: req.body.startMinutesFromNow || 0.05,
      rakeBps: req.body.rakeBps || 300,
      jackpotFlag: req.body.jackpotFlag !== false,
      limit: req.body.limit || 6
    });
    const { startMinutesFromNow, rakeBps, jackpotFlag, limit } = validatedData;
    const { nowMs } = await import('./chain-time');
    const startTs = await nowMs() + (startMinutesFromNow * 60 * 1000);

    // Validate start time
    if (startTs <= Date.now()) {
      return res.status(400).json({ error: "Start time must be in the future" });
    }

    // Block manual creation during maintenance
    const treas = await getDb().getTreasury();
    if ((treas as any).maintenanceMode) {
      return res.status(503).json({ error: "Maintenance mode active. Creating new races is disabled." });
    }

    // Limit to 3 active races maximum
    const activeRaces = await getDb().getRaces('OPEN');
    if (activeRaces.length >= 3) {
      return res.status(400).json({ error: "Maximum of 3 active races allowed. Please wait for current races to complete." });
    }

    // Create placeholder runners - actual tokens will be selected when race goes live (LOCKED state)
    // This ensures fresh trending tokens are selected at race start time, not creation time
    const placeholderRunners = Array.from({ length: limit }, (_, index) => ({
      mint: `placeholder_${index}`,
      symbol: "???",
      name: "Token will be selected when race starts",
      initialPrice: 0,
      currentPrice: 0,
      priceChange: 0,
      priceChangeH1: 0,
      volume24h: 0,
      marketCap: 0,
      createdAt: Date.now(),
      poolAddress: "",
      geckoTerminalUrl: "",
      logoURI: "",
      initialPriceUsd: 0,
      initialPriceTs: 0
    }));

    // Create race
    const raceId = `race_${Date.now()}_${req.ip?.replace(/\./g, '').slice(-6) || 'manual'}`; // Use IP suffix instead of random
    const race: Race = {
      id: raceId,
      startTs,
      status: RaceStatus.OPEN,
      rakeBps,
      jackpotFlag,
      jackpotAdded: 0,
      runners: placeholderRunners,
      winnerIndex: undefined,
      drandRound: undefined, // Will be set on settlement
      drandRandomness: undefined, // Will store price data on settlement
      drandSignature: undefined, // Will store winner signature on settlement
      createdAt: Date.now()
    };
    
    const createdRace = await getDb().createRace(race);

    console.log(`Created race ${createdRace.id} with ${createdRace.runners.length} placeholder runners, starts at ${new Date(startTs).toISOString()}`);
    console.log(`🎯 Real tokens will be selected when race goes live (LOCKED state) for maximum freshness`);

    // Note: House seeds will be created when race transitions to LOCKED (after real tokens are selected)

    res.json({
      success: true,
      race: createdRace
    });

  } catch (error) {
    console.error("Create race error:", error);
    
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

// Force start a stuck race by transitioning it to the next state
export async function handleForceStartRace(req: Request, res: Response) {
  try {
    const { raceId } = req.body;
    
    if (!raceId) {
      return res.status(400).json({ error: "Race ID is required" });
    }

    const race = await getDb().getRace(raceId);
    if (!race) {
      return res.status(404).json({ error: "Race not found" });
    }

    if (race.status === 'SETTLED' || race.status === 'CANCELLED') {
      return res.status(400).json({ error: "Cannot force start completed races" });
    }

    // Import the new state machine
    const { RaceStateMachine } = await import('./race-state-machine');
    const { RaceTimer } = await import('./race-timer');
    
    // Determine next state
    let nextState;
    switch (race.status) {
      case 'OPEN':
        nextState = 'LOCKED';
        break;
      case 'LOCKED':
        nextState = 'IN_PROGRESS';
        break;
      case 'IN_PROGRESS':
        nextState = 'SETTLED';
        break;
      default:
        return res.status(400).json({ error: "Invalid race status for force start" });
    }

    // Force transition
    const updatedRace = await RaceStateMachine.transitionRace(raceId, nextState as any, "admin_force");
    
    // Set up timer for next transition
    RaceTimer.setupRaceTimer(updatedRace);

    console.log(`🔧 Admin force-started race ${raceId}: ${race.status} → ${nextState}`);

    res.json({
      success: true,
      message: `Race ${raceId} forced to ${nextState} state`,
      race: updatedRace
    });

  } catch (error) {
    console.error("Force start race error:", error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    });
  }
}

// Lock race using new state machine
export async function handleLockRace(req: Request, res: Response) {
  try {
    if (!rateLimit(req.ip || 'unknown', 10, 60000)) {
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    const validatedData = lockRaceSchema.parse(req.body);
    const { raceId } = validatedData;

    const race = await getDb().getRace(raceId);
    if (!race) {
      return res.status(404).json({ error: "Race not found" });
    }

    if (race.status !== RaceStatus.OPEN) {
      return res.status(400).json({ error: "Race is not open" });
    }

    // Use new state machine to lock race
    const { RaceStateMachine } = await import('./race-state-machine');
    const { RaceTimer } = await import('./race-timer');
    
    const updatedRace = await RaceStateMachine.transitionRace(raceId, RaceStatus.LOCKED, "admin_lock");
    
    // Set up timer for next transition
    RaceTimer.setupRaceTimer(updatedRace);

    console.log(`🔒 Race ${raceId} locked by admin at ${new Date(updatedRace.lockedTs!).toISOString()}`);

    res.json({
      success: true,
      race: updatedRace,
      message: "Race locked and initial prices captured. Winner will be determined by highest % gain after 10 minutes.",
      priceSnapshot: updatedRace.runners.map(r => ({
        symbol: r.symbol,
        initialPrice: r.initialPriceUsd || r.initialPrice
      }))
    });

  } catch (error) {
    console.error("Lock race error:", error);
    
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

// Cancel race using new state machine
export async function handleCancelRace(req: Request, res: Response) {
  try {
    if (!rateLimit(req.ip || 'unknown', 5, 60000)) {
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    const validatedData = cancelRaceSchema.parse(req.body);
    const { raceId } = validatedData;

    const race = await getDb().getRace(raceId);
    if (!race) {
      return res.status(404).json({ error: "Race not found" });
    }

    if (race.status === RaceStatus.SETTLED || race.status === RaceStatus.CANCELLED) {
      return res.status(400).json({ error: "Cannot cancel completed races" });
    }

    // Use new state machine to cancel race
    const { RaceStateMachine } = await import('./race-state-machine');
    const { RaceTimer } = await import('./race-timer');
    
    const updatedRace = await RaceStateMachine.transitionRace(raceId, RaceStatus.CANCELLED, "admin_cancel");
    
    // Clear timer
    RaceTimer.clearRaceTimer(raceId);

    console.log(`❌ Race ${raceId} cancelled by admin`);

    res.json({
      success: true,
      race: updatedRace,
      message: "Race cancelled and bets refunded"
    });

  } catch (error) {
    console.error("Cancel race error:", error);
    
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

// Faucet for test tokens
// Reset all races and reseed to 3 OPEN races
export async function handleResetRaces(req: Request, res: Response) {
  try {
    const { RaceStateMachine } = await import('./race-state-machine');
    const { RaceTimer } = await import('./race-timer');
    const { createNewRaceIfNeeded } = await import("./sse");

    const open = await getDb().getRaces("OPEN");
    const locked = await getDb().getRaces("LOCKED");
    const inprog = await getDb().getRaces("IN_PROGRESS");

    // Cancel all non-settled races using state machine
    for (const r of [...open, ...locked, ...inprog]) {
      try {
        await RaceStateMachine.transitionRace(r.id, RaceStatus.CANCELLED, "admin_reset");
        RaceTimer.clearRaceTimer(r.id);
      } catch (e) {
        console.error("Failed to cancel race", r.id, e);
      }
    }

    // Reseed to 3 OPEN races (idempotent)
    await createNewRaceIfNeeded();
    await createNewRaceIfNeeded();
    await createNewRaceIfNeeded();

    const count = await getDb().getRaces("OPEN").length;
    res.json({ ok: true, open: count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}

// Public faucet for beta users (no auth required)
export async function handlePublicFaucet(req: Request, res: Response) {
  try {
    // More restrictive rate limiting for public endpoint
    if (!rateLimit(req.ip || 'unknown', 2, 300000)) { // 2 requests per 5 minutes per IP
      return res.status(429).json({ error: "Faucet rate limit exceeded - max 2 requests per 5 minutes" });
    }

    const validatedData = faucetSchema.parse(req.body);
    const { toPubkey, amount } = validatedData;

    // More restrictive amount for public faucet (max 10,000 tokens per request)
    const faucetAmount = new Decimal(amount);
    if (faucetAmount.lte(0) || faucetAmount.gt(10000)) {
      return res.status(400).json({ error: "Public faucet amount must be between 0 and 10,000 $RACE" });
    }

    // Get mint address (prefer environment for stability across restarts)
    const { raceMintAddress } = await import('./solana');
    const treasury = await getDb().getTreasury();
    const chosenMint = raceMintAddress || treasury.raceMint;
    if (!chosenMint) {
      return res.status(500).json({ error: "RACE mint not initialized" });
    }

    const raceMint = new PublicKey(chosenMint);
    const recipientPubkey = new PublicKey(toPubkey);

    // Check recipient's current balance (prevent abuse)
    const currentBalance = await getSplTokenBalance(raceMint, recipientPubkey);
    const currentBalanceFormatted = new Decimal(currentBalance.toString()).div(new Decimal(10).pow(9));
    
    // Lower limit for public faucet & per-wallet throttle via last faucet ts
    if (currentBalanceFormatted.gt(25000)) {
      return res.status(400).json({ error: "Wallet already has sufficient test tokens (limit: 25,000 $RACE)" });
    }

    {
      const lastFaucet = publicFaucetCooldownByWallet.get(toPubkey) || 0;
      const now = Date.now();
      // 1 request per 15 minutes per wallet for the public faucet
      if (now - lastFaucet < 15 * 60 * 1000) {
        return res.status(429).json({ error: "Faucet cooldown active for this wallet" });
      }
    }

    // Mint tokens to recipient
    const mintAmount = BigInt(faucetAmount.mul(new Decimal(10).pow(9)).toString());
    const txSig = await mintTokensToAddress(raceMint, recipientPubkey, mintAmount);

    console.log(`Public Faucet: ${amount} $RACE sent to ${toPubkey}`);

    publicFaucetCooldownByWallet.set(toPubkey, Date.now());

    res.json({
      success: true,
      txSig,
      amount,
      recipient: toPubkey
    });

  } catch (error) {
    console.error("Public faucet error:", error);
    
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

// Admin faucet endpoint (higher limits, requires auth)
export async function handleFaucet(req: Request, res: Response) {
  try {
    if (!rateLimit(req.ip || 'unknown', 3, 60000)) {
      return res.status(429).json({ error: "Faucet rate limit exceeded - max 3 requests per minute" });
    }

    const validatedData = faucetSchema.parse(req.body);
    const { toPubkey, amount } = validatedData;

    // Validate amount (max 100,000 tokens per request)
    const faucetAmount = new Decimal(amount);
    if (faucetAmount.lte(0) || faucetAmount.gt(100000)) {
      return res.status(400).json({ error: "Faucet amount must be between 0 and 100,000 $RACE" });
    }

    // Get mint address (prefer environment for stability across restarts)
    const { raceMintAddress } = await import('./solana');
    const treasury = await getDb().getTreasury();
    const chosenMint = raceMintAddress || treasury.raceMint;
    if (!chosenMint) {
      return res.status(500).json({ error: "RACE mint not initialized" });
    }

    const raceMint = new PublicKey(chosenMint);
    const recipientPubkey = new PublicKey(toPubkey);

    // Check recipient's current balance (prevent abuse)
    const currentBalance = await getSplTokenBalance(raceMint, recipientPubkey);
    const currentBalanceFormatted = new Decimal(currentBalance.toString()).div(new Decimal(10).pow(9));
    
    if (currentBalanceFormatted.gt(50000)) {
      return res.status(400).json({ error: "Wallet already has sufficient test tokens" });
    }

    {
      const lastFaucet = adminFaucetCooldownByWallet.get(toPubkey) || 0;
      const now = Date.now();
      // 1 admin faucet per wallet per 5 minutes
      if (now - lastFaucet < 5 * 60 * 1000) {
        return res.status(429).json({ error: "Admin faucet cooldown active for this wallet" });
      }
    }

    // Mint tokens to recipient
    const mintAmount = BigInt(faucetAmount.mul(new Decimal(10).pow(9)).toString());
    const txSig = await mintTokensToAddress(raceMint, recipientPubkey, mintAmount);

    console.log(`Faucet: ${amount} $RACE sent to ${toPubkey}`);

    adminFaucetCooldownByWallet.set(toPubkey, Date.now());

    res.json({
      success: true,
      txSig,
      amount,
      recipient: toPubkey
    });

  } catch (error) {
    console.error("Faucet error:", error);
    
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

// Get admin stats
export async function handleAdminStats(req: Request, res: Response) {
  try {
    const allRaces = await getDb().getRaces();
    const openRaces = await getDb().getRaces(RaceStatus.OPEN);
    const treasury = await getDb().getTreasury();
    const { getRaceMint, serverKeypair, treasuryPubkey, jackpotPubkey } = await import('./solana');

    // Calculate total bets and volume
    let totalBets = 0;
    let totalVolume = new Decimal(0);
    
    for (const race of allRaces) {
      const bets = await getDb().getBetsForRace(race.id);
      totalBets += bets.length;
      totalVolume = totalVolume.add(
        bets.reduce((sum, bet) => sum.add(new Decimal(bet.amount)), new Decimal(0))
      );
    }

    // On-chain balances for visibility
    let escrowBalanceStr = "0"; // RACE SPL
    let treasuryTokenBalanceStr = "0"; // RACE SPL
    let jackpotTokenBalanceStr = "0"; // RACE SPL
    let escrowSolBalanceStr = "0"; // native SOL
    let treasurySolBalanceStr = "0"; // native SOL
    let jackpotSolBalanceStr = "0"; // native SOL
    try {
      const mint = await getRaceMint();
      const decimals = 9;
      const format = (v: bigint) => new Decimal(v.toString()).div(new Decimal(10).pow(decimals)).toString();
      const escrowOwner = serverKeypair.publicKey;
      const treasuryOwner = treasuryPubkey || serverKeypair.publicKey;
      const jackpotOwner = jackpotPubkey || serverKeypair.publicKey;
      const [escrowBal, treasuryBal, jackpotBal] = await Promise.all([
        getSplTokenBalance(mint, escrowOwner),
        getSplTokenBalance(mint, treasuryOwner),
        getSplTokenBalance(mint, jackpotOwner)
      ]);
      escrowBalanceStr = format(escrowBal);
      treasuryTokenBalanceStr = format(treasuryBal);
      jackpotTokenBalanceStr = format(jackpotBal);
      try {
        const { getSolBalance } = await import('./solana');
        const [escSol, treasSol, jackSol] = await Promise.all([
          getSolBalance(escrowOwner),
          getSolBalance(treasuryOwner),
          getSolBalance(jackpotOwner)
        ]);
        escrowSolBalanceStr = String(escSol);
        treasurySolBalanceStr = String(treasSol);
        jackpotSolBalanceStr = String(jackSol);
      } catch {}
    } catch (e) {
      console.warn('Failed to fetch on-chain balances for admin stats:', e);
    }

    // Outstanding house seed exposure (unsettled races)
    let seededRaceOutstanding = new Decimal(0);
    let seededSolOutstanding = new Decimal(0);
    try {
      const unsettled = allRaces.filter(r => r.status !== RaceStatus.SETTLED && r.status !== RaceStatus.CANCELLED);
      for (const r of unsettled) {
        const bets = await getDb().getBetsForRace(r.id) as any[];
        for (const b of bets) {
          if (b?.clientId === 'HOUSE_SEED' || b?.memo === 'HOUSE_SEED') {
            const amt = new Decimal(b?.amount || '0');
            const cur = String(b?.currency || 'RACE').toUpperCase();
            if (cur === 'SOL') seededSolOutstanding = seededSolOutstanding.add(amt);
            else seededRaceOutstanding = seededRaceOutstanding.add(amt);
          }
        }
      }
    } catch {}

    res.json({
      stats: {
        totalRaces: allRaces.length,
        openRaces: openRaces.length,
        totalBets,
        totalVolume: totalVolume.toString(),
        jackpotBalance: treasury.jackpotBalance,
        raceMint: treasury.raceMint,
        escrowBalance: escrowBalanceStr,
        escrowSolBalance: escrowSolBalanceStr,
        treasuryTokenBalance: treasuryTokenBalanceStr,
        treasurySolBalance: treasurySolBalanceStr,
        jackpotTokenBalance: jackpotTokenBalanceStr,
        jackpotSolBalance: jackpotSolBalanceStr,
        seededOutstanding: {
          RACE: seededRaceOutstanding.toString(),
          SOL: seededSolOutstanding.toString()
        },
        maintenanceMode: (treasury as any).maintenanceMode || false
      },
      recentRaces: allRaces.slice(0, 10),
      maintenance: {
        mode: (treasury as any).maintenanceMode || false,
        message: (treasury as any).maintenanceMessage || ""
      }
    });

  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    });
  }
}

// Reset RACE mint to allow recreation
export async function handleClearRaces(req: Request, res: Response) {
  try {
    // PRODUCTION SAFETY: Require explicit confirmation
    const isProd = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
    if (isProd && process.env.ALLOW_RESET !== '1') {
      return res.status(403).json({ 
        error: "clearRaces is BLOCKED in production",
        message: "This operation would delete all race/bet data. Set ALLOW_RESET=1 to override (NOT RECOMMENDED)"
      });
    }
    
    if (!rateLimit(req.ip || 'unknown', 2, 300000)) { // Very restrictive: 2 calls per 5 minutes
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    console.log("🗑️ Admin requested race database cleanup");
    
    // Import required modules
    const { RaceTimer } = await import('./race-timer');
    const { clearStuckRace } = await import('./sse');
    
    // Count races before clearing
    const allRacesBefore = await getDb().getRaces();
    const raceCountBefore = allRacesBefore.length;
    const statusCounts = allRacesBefore.reduce((acc: Record<string, number>, race) => {
      acc[race.status] = (acc[race.status] || 0) + 1;
      return acc;
    }, {});
    
    // Stop the race timer system
    await RaceTimer.stop();
    
    // Clear in-memory state for all races
    for (const race of allRacesBefore) {
      await clearStuckRace(race.id);
      RaceTimer.clearRaceTimer(race.id);
    }
    
    // Clear all races and bets from database
    await getDb().clearRaces();
    
    // Restart the race timer system
    RaceTimer.start();
    
    // Reinitialize races
    const { initializeRaces } = await import('./sse');
    await initializeRaces();
    
    console.log(`✅ Cleared ${raceCountBefore} races:`, statusCounts);
    
    res.json({
      success: true,
      message: "All races and bets cleared successfully",
      clearedRaces: raceCountBefore,
      statusBreakdown: statusCounts
    });

  } catch (error) {
    console.error("Clear races error:", error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    });
  }
}

// Enable/disable maintenance mode (freeze next races)
export async function handleSetMaintenance(req: Request, res: Response) {
  try {
    const { mode, message } = req.body || {};
    if (typeof mode !== 'boolean') {
      return res.status(400).json({ error: 'mode (boolean) is required' });
    }
    const current = await getDb().getTreasury();
    // Anchor the earliest OPEN race when enabling maintenance so only it can proceed
    let maintenanceAnchorRaceId: string | undefined = current.maintenanceAnchorRaceId;
    if (mode) {
      try {
        const open = await getDb().getRaces('OPEN');
        maintenanceAnchorRaceId = open[0]?.id;
      } catch {}
    } else {
      maintenanceAnchorRaceId = undefined;
    }
    await getDb().updateTreasury({
      jackpotBalance: current.jackpotBalance,
      raceMint: current.raceMint,
      maintenanceMode: mode,
      maintenanceMessage: typeof message === 'string' ? message : current.maintenanceMessage,
      maintenanceAnchorRaceId
    } as any);

    // Persist maintenance sentinel to stable storage for restart resilience
    try {
      const sentinel = {
        mode,
        message: typeof message === 'string' ? message : current.maintenanceMessage,
        maintenanceAnchorRaceId,
        updatedAt: Date.now()
      };
      const candidates = [
        '/data/pump-racers-maintenance.json',
        '/mnt/data/pump-racers-maintenance.json',
        path.join(process.cwd(), 'data', 'pump-racers-maintenance.json')
      ];
      for (const file of candidates) {
        try {
          const dir = path.dirname(file);
          try { fs.mkdirSync(dir, { recursive: true }); } catch {}
          fs.writeFileSync(file, JSON.stringify(sentinel, null, 2), 'utf-8');
          console.log(`🧰 Wrote maintenance sentinel to ${file}`);
          break;
        } catch {}
      }
    } catch (e) {
      console.warn('⚠️ Failed to write maintenance sentinel:', e);
    }

    console.log(`🧰 Maintenance mode ${mode ? 'ENABLED' : 'DISABLED'}`);

    res.json({ success: true, maintenanceMode: mode, message: message || current.maintenanceMessage, maintenanceAnchorRaceId });
  } catch (error) {
    console.error('Set maintenance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Clear and restart only future OPEN races (do not touch history/settled/locked/in-progress)
export async function handleRestartRaces(req: Request, res: Response) {
  try {
    const { RaceStateMachine } = await import('./race-state-machine');
    const { RaceTimer } = await import('./race-timer');
    const { createNewRaceIfNeeded, clearStuckRace } = await import('./sse');
    const { RacePhaseManager } = await import('./race-phase-improvements');

    // First perform a health check to identify stuck races
    const healthCheck = await RacePhaseManager.performHealthCheck();
    console.log(`🏥 Pre-restart health check: ${healthCheck.fixed} fixed, ${healthCheck.failed} failed`);

    // Cancel ALL non-terminal races to fully resync scheduling
    const open = await getDb().getRaces(RaceStatus.OPEN);
    const locked = await getDb().getRaces(RaceStatus.LOCKED);
    const inProgress = await getDb().getRaces(RaceStatus.IN_PROGRESS);

    let cancelled = 0;
    const toCancel = [...open, ...locked, ...inProgress];
    
    // Stop the race timer system temporarily
    await RaceTimer.stop();
    
    for (const r of toCancel) {
      try {
        await RaceStateMachine.transitionRace(r.id, RaceStatus.CANCELLED, 'admin_restart');
        RaceTimer.clearRaceTimer(r.id);
        await clearStuckRace(r.id);
        cancelled++;
      } catch (e) {
        console.error('Failed to cancel race during restart', r.id, e);
      }
    }
    
    // Restart the race timer system
    RaceTimer.start();

    // Reseed to target count of OPEN races when maintenance is OFF only
    const treasury = await getDb().getTreasury();
    if (!(treasury as any).maintenanceMode) {
      await createNewRaceIfNeeded();
      await createNewRaceIfNeeded();
      await createNewRaceIfNeeded();
    } else {
      console.log('🧰 Maintenance is ON: not reseeding new races until disabled');
    }

    // Optimize scheduling after restart
    await RacePhaseManager.optimizeScheduling();

    res.json({ 
      success: true, 
      cancelled, 
      cancelledByStatus: {
        open: open.length,
        locked: locked.length,
        inProgress: inProgress.length
      },
      healthCheck: {
        preRestart: {
          fixed: healthCheck.fixed,
          failed: healthCheck.failed
        }
      }
    });
  } catch (error) {
    console.error('Restart races error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleSettleStuckRaces(req: Request, res: Response) {
  try {
    if (!rateLimit(req.ip || 'unknown', 5, 60000)) {
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    const { RaceStateMachine } = await import('./race-state-machine');
    const { RaceTimer } = await import('./race-timer');
    
    // Get all races that might be stuck
    const allRaces = await getDb().getRaces();
    let settledCount = 0;
    
    for (const race of allRaces) {
      try {
        // Check if race should be reconciled
        const reconciledRace = await RaceStateMachine.reconcileRace(race);
        if (reconciledRace && reconciledRace.status !== race.status) {
          settledCount++;
          console.log(`🔧 Reconciled race ${race.id}: ${race.status} → ${reconciledRace.status}`);
          
          // Set up timer for next transition if needed
          if (reconciledRace.status !== RaceStatus.SETTLED && reconciledRace.status !== RaceStatus.CANCELLED) {
            RaceTimer.setupRaceTimer(reconciledRace);
          }
        }
      } catch (error) {
        console.error(`❌ Failed to reconcile race ${race.id}:`, error);
      }
    }

    res.json({ 
      success: true, 
      message: `Reconciled ${settledCount} stuck races` 
    });

  } catch (error) {
    console.error("Settle stuck races error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handleResetRaceMint(req: Request, res: Response) {
  try {
    // PRODUCTION SAFETY: This should rarely be needed in production
    const isProd = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
    if (isProd && process.env.ALLOW_RESET !== '1') {
      return res.status(403).json({ 
        error: "resetRaceMint is BLOCKED in production",
        message: "This operation should not be needed in production. Set ALLOW_RESET=1 to override."
      });
    }
    
    if (!rateLimit(req.ip || 'unknown', 2, 300000)) { // Very restrictive: 2 calls per 5 minutes
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    // Get current treasury
    const treasury = await getDb().getTreasury();
    
    console.log("🔄 Admin requested RACE mint reset");
    console.log("Current raceMint:", treasury.raceMint);
    
    // Clear the raceMint to force recreation
    treasury.raceMint = undefined;
    await getDb().updateTreasury(treasury);
    
    console.log("✅ RACE mint cleared from database - will be recreated on next server restart");
    
    res.json({
      success: true,
      message: "RACE mint reset successfully. Restart server to create new mint.",
      previousMint: treasury.raceMint
    });

  } catch (error) {
    console.error("Reset RACE mint error:", error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    });
  }
}

// Reset jackpot balances to 0 (both RACE and SOL ledgers)
export async function handleResetJackpots(req: Request, res: Response) {
  try {
    if (!rateLimit(req.ip || 'unknown', 2, 60000)) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    const current = await getDb().getTreasury();
    await getDb().updateTreasury({
      jackpotBalance: '0',
      jackpotBalanceSol: '0',
      raceMint: current.raceMint,
      maintenanceMode: (current as any).maintenanceMode || false,
      maintenanceMessage: (current as any).maintenanceMessage,
      maintenanceAnchorRaceId: (current as any).maintenanceAnchorRaceId
    } as any);
    console.log('🎯 Admin reset jackpots to 0 for both currencies');
    res.json({ success: true, jackpotBalance: '0', jackpotBalanceSol: '0' });
  } catch (error) {
    console.error('Reset jackpots error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleProcessMissedPayouts(req: Request, res: Response) {
  try {
    console.log('🔍 Checking for missed payouts...');
    
    const { calculateSettlement } = await import('./settlement');
    const { sendLamports, serverKeypair } = await import('./solana');
    const { LAMPORTS_PER_SOL } = await import('@solana/web3.js');
    
    // Get all settled SOL races
    const races = await getDb().getAllRaces();
    const settledRaces = races.filter(r => r.status === 'SETTLED');
    
    const results = {
      racesChecked: 0,
      missedPayouts: [] as any[],
      sentPayouts: [] as any[],
      errors: [] as any[]
    };
    
    for (const race of settledRaces) {
      try {
        results.racesChecked++;
        
        // Get bets for this race
        const bets = await getDb().getBetsForRace(race.id);
        
        // Only process SOL races
        const solBets = bets.filter((b: any) => b.currency === 'SOL');
        if (solBets.length === 0) continue;
        
        // Calculate settlement
        const settlement = await calculateSettlement(solBets as any, race as any);
        
        // Check existing transfers
        const existingTransfers = await getDb().getSettlementTransfers(race.id) || [];
        
        // Process each winner
        for (const [wallet, payout] of settlement.winnerPayouts.entries()) {
          if (!payout || payout.lte(0)) continue;
          
          // Skip escrow wallet
          if (wallet === serverKeypair.publicKey.toString()) continue;
          
          // Check if already paid
          const alreadyPaid = existingTransfers.some((t: any) =>
            t.transferType === 'PAYOUT' &&
            t.toWallet === wallet &&
            (t.currency === 'SOL') &&
            (t.status === 'SUCCESS' || !t.status)
          );
          
          if (alreadyPaid) continue;
          
          // Found missed payout!
          results.missedPayouts.push({
            raceId: race.id,
            wallet,
            amount: payout.toString()
          });
          
          // Send the payout
          try {
            const lamports = payout.mul(LAMPORTS_PER_SOL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
            const recipientPubkey = new PublicKey(wallet);
            
            const txSig = await sendLamports(
              serverKeypair,
              recipientPubkey,
              BigInt(lamports.toString())
            );
            
            // Record the transfer
            await getDb().recordSettlementTransfer({
              id: `manual_${Date.now()}_${wallet.slice(-6)}`,
              raceId: race.id,
              transferType: 'PAYOUT',
              toWallet: wallet,
              amount: payout.toString(),
              txSig,
              currency: 'SOL',
              ts: Date.now()
            });
            
            results.sentPayouts.push({
              raceId: race.id,
              wallet,
              amount: payout.toString(),
              txSig
            });
            
            console.log(`✅ Sent ${payout.toString()} SOL to ${wallet} (race ${race.id})`);
            
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            results.errors.push({
              raceId: race.id,
              wallet,
              amount: payout.toString(),
              error: errMsg
            });
            console.error(`❌ Failed to send to ${wallet}:`, errMsg);
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        results.errors.push({
          raceId: race.id,
          error: errMsg
        });
      }
    }
    
    console.log(`📊 Missed payouts check complete:
      - Races checked: ${results.racesChecked}
      - Missed payouts found: ${results.missedPayouts.length}
      - Successfully sent: ${results.sentPayouts.length}
      - Errors: ${results.errors.length}`);
    
    res.json(results);
    
  } catch (error) {
    console.error("Process missed payouts error:", error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : "Unknown error",
      details: error
    });
  }
}
