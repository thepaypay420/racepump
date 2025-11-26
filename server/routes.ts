import type { Express } from "express";
import { Request, Response } from "express";
import { getDb } from "./db";
import { selectedDatabase } from './db/index';
import { pgPool, usePgForReceipts } from './db/clients';
import { ensureRaceMintExists } from "./solana";
import { handleGetTokens } from "./runners";
import { handlePlaceBet, handleGetRaceTotals, handleGetUserBets } from "./bets";
import { handleClaimWinnings } from "./settlement";
import type { Race } from "@shared/schema";
import { buildRaceResultsTweet } from "./share";
import { 
  requireAdminAuth, 
  handleCreateRace, 
  handleLockRace, 
  handleCancelRace, 
  handleFaucet,
  handlePublicFaucet,
  handleAdminStats,
  handleResetRaceMint,
  handleResetRaces,
  handleClearRaces,
  handleSettleStuckRaces,
    handleForceStartRace,
    handleSetMaintenance,
    handleRestartRaces,
    handleResetJackpots,
    handleProcessMissedPayouts
} from "./admin";
import { handleSSEConnection, raceEvents } from "./sse";
import Decimal from 'decimal.js';
import { buildRaceswapPlan, getReflectionTokenMeta, getRaceswapPublicConfig, RaceswapPlanError } from "./raceswap";
import { getFallbackRaceswapTokens, getRaceswapTokenList } from "./raceswap-tokens";
import NodeCache from "node-cache";

const RACEPUMP_PUBLIC_BASE = (process.env.RACEPUMP_PUBLIC_BASE || "https://racepump.fun").replace(/\/$/, "");

// Cache for remote recent winners fetch to prevent repeated abort errors
// Cache failed attempts for 30 seconds to avoid spamming
const remoteRecentWinnersCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

type RaceBetAggregateMap = Record<string, {
  totalPotSol: string;
  betCountSol: number;
  totalPotRace: string;
  betCountRace: number;
}>;

export async function registerRoutes(app: Express): Promise<void> {
  // Dedicated mainnet connection for wallet balance lookups to avoid devnet bleed-through
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const {
    getAssociatedTokenAddress,
    getAccount,
    getMint,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  } = await import('@solana/spl-token');
  type TokenProgramId = typeof TOKEN_PROGRAM_ID;
  const tokenProgramPriority: TokenProgramId[] = Array.from(
    new Set(
      [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(
        (program): program is TokenProgramId => !!program
      )
    )
  );
  const balancesRpcUrl =
    process.env.RPC_URL_MAINNET ||
    process.env.RPC_URL ||
    'https://api.mainnet-beta.solana.com';
  const balancesConnection = new Connection(balancesRpcUrl, 'confirmed');
  const mintDecimalsCache = new Map<string, number>();
  const mintProgramCache = new Map<string, TokenProgramId>();
  const resolveMintInfo = async (
    mint: PublicKey
  ): Promise<{ decimals: number; programId: TokenProgramId }> => {
    const cacheKey = mint?.toString?.() || String(mint);
    const cachedDecimals = mintDecimalsCache.get(cacheKey);
    const cachedProgram = mintProgramCache.get(cacheKey);
    if (typeof cachedDecimals === 'number' && cachedProgram) {
      return { decimals: cachedDecimals, programId: cachedProgram };
    }
    for (const programId of tokenProgramPriority) {
      if (!programId) continue;
      try {
        const mintInfo = await getMint(balancesConnection, mint, undefined, programId);
        const decimals = Number(mintInfo?.decimals ?? 9);
        mintDecimalsCache.set(cacheKey, decimals);
        mintProgramCache.set(cacheKey, programId);
        return { decimals, programId };
      } catch (mintError) {
        const programLabel = typeof programId?.toBase58 === 'function'
          ? programId.toBase58()
          : 'unknown-program';
        console.warn(`⚠️ Failed to fetch mint info for ${cacheKey} via ${programLabel}:`, mintError);
      }
    }
    const fallbackProgram = tokenProgramPriority[0];
    mintDecimalsCache.set(cacheKey, 9);
    mintProgramCache.set(cacheKey, fallbackProgram);
    return { decimals: 9, programId: fallbackProgram };
  };
  
  // CRITICAL: Wait for hydration to complete before serving data requests
  const { hydrationPromise } = await import('./db');
  console.log('⏳ Waiting for database hydration to complete before serving requests...');
  await hydrationPromise;
  console.log('✅ Database hydration complete, ready to serve requests');
  
  // Initialization is now triggered by the caller after the server is listening

  // Simple health check (no DB access)
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      timestamp: Date.now(),
      version: "1.0.0",
      environment: process.env.NODE_ENV || 'development'
    });
  });

  // Enhanced database diagnostics (admin-only)
  app.get("/api/admin/db-diagnostics", requireAdminAuth, async (req, res) => {
    try {
      const { getDbDiagnostics } = await import('./db');
      const diagnostics = await getDbDiagnostics();
      res.json(diagnostics);
    } catch (error) {
      console.error('Diagnostics error:', error);
      res.status(500).json({ 
        error: 'Failed to fetch diagnostics',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

    // SSE endpoint for real-time updates
    app.get("/api/events", handleSSEConnection);

    // RACESwap public config & helpers
    app.get("/api/raceswap/config", async (_req, res) => {
      try {
        const config = await getRaceswapPublicConfig();
        res.json(config);
      } catch (error) {
        console.error("[raceswap] config error:", error);
        res.status(500).json({ error: "Failed to load RACESwap config" });
      }
    });

      app.get("/api/raceswap/tokens", async (req, res) => {
        try {
          const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
          const limit = limitParam ? Number(limitParam) : undefined;
          const tokens = await getRaceswapTokenList(limit);
          res.json(tokens);
        } catch (error) {
          console.error("[raceswap] token list error:", error);
          res.json(getFallbackRaceswapTokens());
        }
      });

      app.get("/api/raceswap/reflection", async (_req, res) => {
      try {
        const meta = await getReflectionTokenMeta();
        res.json(meta);
      } catch (error) {
        console.error("[raceswap] reflection error:", error);
        res.status(500).json({ error: "Failed to load reflection metadata" });
      }
    });

    app.post("/api/raceswap/plan", async (req, res) => {
      try {
        const { inputMint, outputMint, amount, slippageBps, disableReflection } = req.body || {};
        if (!inputMint || !outputMint || !amount) {
          return res.status(400).json({ error: "inputMint, outputMint, and amount are required" });
        }

        const ensureMint = (value: string, label: string) => {
          try {
            return new PublicKey(String(value)).toBase58();
          } catch {
            throw new Error(`Invalid ${label}`);
          }
        };

        const lamports = String(amount);
        if (!/^\d+$/.test(lamports)) {
          return res.status(400).json({ error: "amount must be a lamport string" });
        }

        const normalizedSlippage = Number(slippageBps ?? 50);
        if (!Number.isFinite(normalizedSlippage) || normalizedSlippage <= 0) {
          return res.status(400).json({ error: "Invalid slippageBps" });
        }

        const plan = await buildRaceswapPlan({
          inputMint: ensureMint(inputMint, "inputMint"),
          outputMint: ensureMint(outputMint, "outputMint"),
          totalAmount: lamports,
          slippageBps: Math.min(Math.max(Math.trunc(normalizedSlippage), 1), 5000),
          disableReflection: Boolean(disableReflection),
        });

        res.json(plan);
        } catch (error) {
          if (error instanceof RaceswapPlanError) {
            return res.status(error.statusCode).json({ error: error.message });
          }
          console.error("[raceswap] plan error:", error);
          res.status(500).json({ error: (error as Error)?.message || "Failed to build swap plan" });
        }
    });

  // -------- Referrals API --------
  app.get('/api/referrals/settings', async (req, res) => {
    try {
      const { getSettings } = await import('./referrals');
      const settings = await getSettings();
      res.json(settings);
    } catch (e) { 
      console.error('Referrals settings error:', e);
      res.status(500).json({ error: 'failed' });
    }
  });
  app.post('/api/referrals/code', async (req, res) => {
    try {
      const wallet = String((req.body?.wallet || '').trim());
      const desired = (req.body?.desired || '').toString();
      if (!wallet) return res.status(400).json({ error: 'wallet required' });
      const { setUserCode } = await import('./referrals');
      const out = await setUserCode(wallet, desired);
      res.json(out);
    } catch (e: any) { res.status(500).json({ error: e?.message || 'failed' }); }
  });
  app.get('/api/referrals/code/:wallet', async (req, res) => {
    try {
      const wallet = String(req.params.wallet);
      const { getUserCode } = await import('./referrals');
      const result = await getUserCode(wallet);
      res.json(result);
    } catch { res.status(500).json({ error: 'failed' }); }
  });
  app.post('/api/referrals/track', async (req, res) => {
    try {
      const code = String((req.body?.code || '').toString());
      const wallet = String((req.body?.wallet || '').toString());
      const source = (req.body?.source || '').toString();
      if (!code || !wallet) return res.status(400).json({ error: 'code and wallet required' });
      const { recordAttribution } = await import('./referrals');
      recordAttribution({ wallet, code, source });
      res.json({ success: true });
    } catch { res.status(500).json({ error: 'failed' }); }
  });

  // Verify wallet ownership for referral rewards
  app.post('/api/referrals/verify-wallet', async (req, res) => {
    try {
      const { wallet, message, signature } = req.body;
      
      if (!wallet || !message || !signature) {
        return res.status(400).json({ error: 'wallet, message, and signature are required' });
      }
      
      const { verifyWalletOwnership } = await import('./wallet-verification');
      const verification = verifyWalletOwnership(wallet, message, signature);
      
      if (!verification.valid) {
        return res.status(400).json({ 
          success: false, 
          error: verification.reason || 'Invalid verification' 
        });
      }
      
      // Mark the wallet as verified
      const { getDb } = await import('./db');
      await getDb()?.markReferralUserVerified?.(wallet);
      
      res.json({ 
        success: true, 
        wallet,
        verified: true,
        verifiedAt: Date.now()
      });
    } catch (e: any) {
      console.error('[api/referrals/verify-wallet] Error:', e);
      res.status(500).json({ error: e?.message || 'Verification failed' });
    }
  });

  // Get wallet verification status
  app.get('/api/referrals/verify-status/:wallet', async (req, res) => {
    try {
      const wallet = String(req.params.wallet);
      const { getDb } = await import('./db');
      const user = await getDb()?.getReferralUserByWallet?.(wallet);
      
      if (!user) {
        return res.json({ 
          wallet, 
          verified: false,
          exists: false
        });
      }
      
      res.json({ 
        wallet, 
        verified: user.verified || false,
        verifiedAt: user.verifiedAt,
        exists: true
      });
    } catch (e: any) {
      console.error('[api/referrals/verify-status] Error:', e);
      res.status(500).json({ error: 'Failed to get verification status' });
    }
  });

  // Referral summary for a wallet (direct/indirect counts and totals)
  app.get('/api/referrals/summary/:wallet', async (req, res) => {
    try {
      const wallet = String(req.params.wallet);
      const { getDb } = await import('./db');
      const { getUserCode } = await import('./referrals');
      const userCodeResult = await getUserCode(wallet);
      const code = userCodeResult.code;
      // Direct referrals are attributions pointing at this code
      const directWallets = await getDb()?.getDirectReferrals(code);
      // Indirect: referrals of referrals (one hop) by reading codes of direct wallets
      const directCodes = await getDb()?.getCodesForWallets(directWallets);
      let indirectWallets: string[] = [];
      for (const dc of directCodes) {
        const w = await getDb()?.getDirectReferrals(dc);
        indirectWallets = indirectWallets.concat(w);
      }
      const raceTotals = await getDb()?.getReferralTotalsForWallet(wallet, 'RACE');
      const solTotals = await getDb()?.getReferralTotalsForWallet(wallet, 'SOL');
      res.json({
        wallet,
        code,
        referredDirect: directWallets.length,
        referredIndirect: indirectWallets.length,
        totals: {
          race: raceTotals,
          sol: solTotals
        }
      });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
  });

  // Public routes
  app.get("/api/runners/top", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 12;
      if (limit < 4 || limit > 12) {
        return res.status(400).json({ error: "Limit must be between 4 and 12" });
      }

      const result = await handleGetTokens(limit);
      if (result.success) {
        res.json(result.data);
      } else {
        res.status(502).json({ error: result.error });
      }
    } catch (error) {
      console.error("Get runners error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Public token stats endpoint (GeckoTerminal-backed, cached)
  app.get('/api/token-stats', async (req, res) => {
    try {
      const mint = String((req.query.mint || '') as string).trim();
      if (!mint) {
        return res.status(400).json({ error: 'mint required' });
      }
      const poolParam = String((req.query.pool || req.query.poolAddress || '') as string).trim();
      const pool = poolParam || undefined;
      const { getTokenStats } = await import('./geckoterminal');
      const stats = await getTokenStats(mint, pool);
      // Encourage client-side caching briefly
      res.set('Cache-Control', 'public, max-age=30');
      res.json(stats);
    } catch (e: any) {
      console.error('token-stats error:', e);
      res.status(500).json({ error: 'Failed to fetch token stats' });
    }
  });

  // Race routes
    app.get("/api/races", async (req, res) => {
      try {
        const { status } = req.query;
        const db = getDb();
        let races = status ? await db?.getRaces(status as string) : await db?.getRaces();
        races = Array.isArray(races) ? races : [];

        // Hide races that contain invalid/mock-like runners (e.g., missing poolAddress) from active listings
        races = races.filter(r => {
          // Always show SETTLED/CANCELLED for history, but vet OPEN/LOCKED/IN_PROGRESS
          const s = r.status;
          if (s === 'SETTLED' || s === 'CANCELLED') return true;
          const allValid = Array.isArray(r.runners) && r.runners.length >= 3 && r.runners.every((runner: any) => typeof runner.poolAddress === 'string' && runner.poolAddress.length > 0);
          return allValid;
        });
        
        const raceIds = races.map(r => r.id);
        let raceAggregates: RaceBetAggregateMap | undefined;
        let aggregatesUnavailable = false;
        if (raceIds.length > 0 && db && typeof (db as any).getRaceBetAggregates === 'function') {
          try {
            const maybeAggregates = (db as any).getRaceBetAggregates(raceIds);
            raceAggregates = await Promise.resolve(maybeAggregates);
          } catch (aggregateError) {
            aggregatesUnavailable = true;
            console.warn('⚠️ Failed to fetch race bet aggregates, falling back to per-race scans:', aggregateError);
          }
        } else {
          aggregatesUnavailable = true;
        }
        
        // Use new state machine for status computation
        const { RaceStateMachine } = await import('./race-state-machine');
        
        // Add bet totals and computed status to each race
        const racesWithTotals = await Promise.all(races.map(async race => {
          let totalPotSolStr = raceAggregates?.[race.id]?.totalPotSol ?? '0';
          let totalPotRaceStr = raceAggregates?.[race.id]?.totalPotRace ?? '0';
          let betCountSol = raceAggregates?.[race.id]?.betCountSol ?? 0;
          let betCountRace = raceAggregates?.[race.id]?.betCountRace ?? 0;
          let betCount = betCountSol + betCountRace;

          if (aggregatesUnavailable) {
            const bets = ((await db?.getBetsForRace(race.id)) as any[]) || [];
            const betsSol = bets.filter(b => (b?.currency || 'RACE') === 'SOL');
            const betsRace = bets.filter(b => (b?.currency || 'RACE') !== 'SOL');
            const totalPotSol = betsSol.reduce((sum, bet) => sum.add(new Decimal(bet.amount || '0')), new Decimal(0));
            const totalPotRace = betsRace.reduce((sum, bet) => sum.add(new Decimal(bet.amount || '0')), new Decimal(0));
            totalPotSolStr = totalPotSol.toString();
            totalPotRaceStr = totalPotRace.toString();
            betCountSol = betsSol.length;
            betCountRace = betsRace.length;
            betCount = bets.length;
          }

          const totalPot = new Decimal(totalPotSolStr || '0').add(new Decimal(totalPotRaceStr || '0')).toString();
          
          const expectedStatus = await RaceStateMachine.getExpectedStatus(race);
          // Compute timing based on the effective status we expect now to avoid UI showing 0:00
          const effectiveRace = expectedStatus !== race.status ? { ...race, status: expectedStatus } : race;
          const timing = await RaceStateMachine.getRaceTiming(effectiveRace as any);
          
          return {
            ...race,
            totalPot,
            betCount,
            // Per-currency snapshots for multi-currency UI
            totalPotSol: totalPotSolStr,
            betCountSol,
            totalPotRace: totalPotRaceStr,
            betCountRace,
            computedStatus: expectedStatus,
            timing: {
              timeUntilNextTransition: timing.timeUntilNextTransition,
              nextTransition: timing.nextTransition,
              progress: timing.progress,
              uiTimeUntilNextTransition: timing.uiTimeUntilNextTransition,
              uiLabel: timing.uiLabel,
              targetTs: timing.targetTs,
              uiTargetTs: timing.uiTargetTs
            }
          };
        }));

        res.json(racesWithTotals);
      } catch (error) {
        console.error("Get races error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

  // GeckoTerminal OHLCV verification for race fairness
  app.get("/api/races/:raceId/ohlcv", async (req, res) => {
    try {
      const { raceId } = req.params;
      const race = await getDb()?.getRace(raceId);
      
      if (!race) {
        return res.status(404).json({ error: "Race not found" });
      }

      // Hide invalid/mock-like races from direct view unless finalized
      if (race.status !== 'SETTLED' && race.status !== 'CANCELLED') {
        const allValid = Array.isArray(race.runners) && race.runners.length >= 3 && race.runners.every((runner: any) => typeof runner.poolAddress === 'string' && runner.poolAddress.length > 0);
        if (!allValid) {
          return res.status(404).json({ error: 'Race unavailable' });
        }
      }

      if (race.status !== 'SETTLED') {
        return res.status(400).json({ error: "Race not settled yet" });
      }

      // Import GeckoTerminal functions
      const { getTokenOHLCV, calculateOHLCVPriceChange, getGeckoTerminalChartUrl } = 
        await import('./geckoterminal');

      // Derive verification window from actual race timing
      // Prefer precise block timestamps captured during LOCK and SETTLE
      const startMs = race.lockedBlockTimeMs || race.lockedTs || race.startTs;
      const endMs = race.settledBlockTimeMs || (race.lockedTs ? (race.lockedBlockTimeMs || race.lockedTs) + 20 * 60 * 1000 : race.startTs + 20 * 60 * 1000);
      const durationMs = Math.max(10 * 1000, (endMs - startMs));
      const raceDurationMinutes = Math.max(1, Math.ceil(durationMs / 60000));
      
      // Get OHLCV data for all runners
      const ohlcvResults = await Promise.allSettled(
        race.runners.map(async (runner) => {
          const candles = await getTokenOHLCV(runner.mint, startMs, raceDurationMinutes, runner.poolAddress);
          const priceAnalysis = calculateOHLCVPriceChange(candles, startMs, raceDurationMinutes);
          const chartUrl = await getGeckoTerminalChartUrl(runner.mint);
          
          return {
            mint: runner.mint,
            symbol: runner.symbol,
            name: runner.name,
            candles: candles.length,
            startPrice: priceAnalysis.startPrice,
            endPrice: priceAnalysis.endPrice,
            priceChange: priceAnalysis.priceChange,
            verified: priceAnalysis.verified,
            chartUrl
          };
        })
      );

      const verificationData = ohlcvResults.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          return {
            mint: race.runners[index].mint,
            symbol: race.runners[index].symbol,
            name: race.runners[index].name,
            candles: 0,
            startPrice: 0,
            endPrice: 0,
            priceChange: 0,
            verified: false,
            chartUrl: `https://www.geckoterminal.com/solana/pools?search=${race.runners[index].mint}`,
            error: 'Failed to fetch OHLCV data'
          };
        }
      });

      // Human-friendly duration label
      const durationLabel = durationMs < 60000 
        ? `${Math.round(durationMs / 1000)} seconds` 
        : `${Math.ceil(durationMs / 60000)} minutes`;

      res.json({
        raceId,
        raceStartTime: startMs,
        raceDuration: durationLabel,
        winnerIndex: race.winnerIndex,
        verificationData,
        dataSource: 'GeckoTerminal OHLCV API',
        timestamp: Date.now()
      });

    } catch (error) {
      console.error("OHLCV verification error:", error);
      res.status(500).json({ error: "Failed to fetch OHLCV verification data" });
    }
  });

  app.get("/api/races/:raceId", async (req, res) => {
    try {
      const { raceId } = req.params;
      const race = await getDb()?.getRace(raceId);
      
      if (!race) {
        return res.status(404).json({ error: "Race not found" });
      }

      // Use new state machine for status computation
      const { RaceStateMachine } = await import('./race-state-machine');

      // Hide invalid/mock-like races from direct view unless finalized
      if (race.status !== 'SETTLED' && race.status !== 'CANCELLED') {
        const allValid = Array.isArray(race.runners) && race.runners.length >= 3 && race.runners.every((runner: any) => typeof runner.poolAddress === 'string' && runner.poolAddress.length > 0);
        if (!allValid) {
          return res.status(404).json({ error: 'Race unavailable' });
        }
      }

      // Add bet totals and computed status
      const bets = await getDb()?.getBetsForRace(raceId);
      const totalPot = bets.reduce((sum, bet) => {
        return sum + parseFloat(bet.amount);
      }, 0);

      const expectedStatus = await RaceStateMachine.getExpectedStatus(race);
      const timing = await RaceStateMachine.getRaceTiming(race);

      res.json({
        ...race,
        totalPot: totalPot.toString(),
        betCount: bets.length,
        computedStatus: expectedStatus,
        timing: {
          timeUntilNextTransition: timing.timeUntilNextTransition,
          nextTransition: timing.nextTransition,
          progress: timing.progress,
          uiTimeUntilNextTransition: timing.uiTimeUntilNextTransition,
          uiLabel: timing.uiLabel,
          targetTs: timing.targetTs,
          uiTargetTs: timing.uiTargetTs
        }
      });
    } catch (error) {
      console.error("Get race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Per-wallet race result (win/loss) with tx link for fallback notifications
  app.get("/api/races/:raceId/result", async (req: Request, res: Response) => {
    try {
      const { raceId } = req.params;
      const wallet = (req.query.wallet as string) || '';
      if (!wallet) return res.status(400).json({ error: 'wallet required' });

      const race = await getDb()?.getRace(raceId);
      if (!race) return res.status(404).json({ error: 'Race not found' });

      // Optional currency scoping (defaults to RACE)
      const currency = String((req.query.currency as string) || 'RACE').toUpperCase();

      // Check settlement transfers for a payout to this wallet (respect currency)
      const transfers = await getDb()?.getSettlementTransfers(raceId) || [];
      const payout = transfers.find((t: any) => t.transferType === 'PAYOUT' && t.toWallet === wallet && ((t?.currency || 'RACE') === currency));

      // Sum total wagered for this wallet in this race (respect currency)
      const bets = (await getDb()?.getBetsForWallet(wallet, raceId) as any[]).filter(b => (b?.currency || 'RACE') === currency);
      const totalWagered = bets.reduce((sum: number, b: any) => sum + parseFloat(b.amount || '0'), 0);

      // Determine if this race resulted in a refund (no winning bets) in this currency
      // Also compute this wallet's expected payout as a fallback if no transfer was recorded yet
      let isRefundCase = false;
      let expectedPayoutStr: string | undefined;
      try {
        const allBets = (await getDb()?.getBetsForRace(raceId) as any[]).filter(b => (b?.currency || 'RACE') === currency);
        const { calculateSettlement } = await import('./settlement');
        const raceForCurrency = currency === 'SOL' ? { ...race, rakeBps: 500 } as any : race as any;
        const opts = currency === 'SOL' ? { treasuryRatio: 0.6, jackpotRatio: 0.4 } : undefined;
        const settlement = await calculateSettlement(allBets as any, raceForCurrency as any, opts as any);
        isRefundCase = !settlement.winnerPayouts || settlement.winnerPayouts.size === 0;
        const ew = settlement.winnerPayouts?.get?.(wallet);
        if (ew && typeof ew.toString === 'function') {
          expectedPayoutStr = ew.toString();
        }
      } catch {}

      if (payout) {
        if (isRefundCase) {
          return res.json({
            raceId,
            wallet,
            participated: true,
            win: false,
            refunded: true,
            payoutAmount: payout.amount,
            lostAmount: '0',
            txSig: payout.txSig,
            currency
          });
        } else {
          return res.json({
            raceId,
            wallet,
            participated: true,
            win: true,
            payoutAmount: payout.amount,
            lostAmount: '0',
            txSig: payout.txSig,
            currency
          });
        }
      }

      // Fallback: if no recorded transfer yet but math says we should be paid, return expected amount
      if (!payout && expectedPayoutStr && Number(expectedPayoutStr) > 0) {
        return res.json({
          raceId,
          wallet,
          participated: true,
          win: true,
          payoutAmount: expectedPayoutStr,
          lostAmount: '0',
          // no txSig yet; likely still pending or failed earlier
          currency,
          pending: true
        } as any);
      }

      if (totalWagered > 0) {
        if (isRefundCase) {
          return res.json({
            raceId,
            wallet,
            participated: true,
            win: false,
            refunded: true,
            payoutAmount: '0',
            lostAmount: '0',
            currency
          });
        } else {
          return res.json({
            raceId,
            wallet,
            participated: true,
            win: false,
            payoutAmount: '0',
            lostAmount: String(totalWagered),
            currency
          });
        }
      }

      // Did not participate
      return res.json({ raceId, wallet, participated: false, currency });
    } catch (error) {
      console.error('Race result endpoint error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get real-time race progress with Jupiter API price data
  app.get("/api/races/:raceId/progress", async (req, res) => {
    try {
      const { raceId } = req.params;
      const race = await getDb()?.getRace(raceId);
      
      if (!race) {
        return res.status(404).json({ error: "Race not found" });
      }
      
      if (race.status !== 'IN_PROGRESS' && race.status !== 'LOCKED') {
        return res.json({ currentLeader: null, priceChanges: [] });
      }
      
      // Add response caching headers to reduce redundant client requests
      res.set('Cache-Control', 'public, max-age=10');
      
      // Get current prices using fast provider with fallback
      const { getLivePrices } = await import('./runners');
      
      const raceRunners = race.runners.map(runner => ({
        mint: runner.mint,
        poolAddress: runner.poolAddress
      }));
      const currentPrices = await getLivePrices(raceRunners);
      
      // Calculate price changes using USD baseline from LOCK time
      const { pctGain } = await import('../shared/prices');
      
      const priceChanges = race.runners.map((runner: any) => {
        const currentPriceUsd = currentPrices.find(p => p.mint === runner.mint)?.price || runner.currentPrice || runner.initialPrice;
        const baselinePriceUsd = runner.initialPriceUsd || runner.initialPrice || 0;
        const gain = pctGain(baselinePriceUsd, currentPriceUsd);
        
        return {
          mint: runner.mint,
          symbol: runner.symbol,
          initialPrice: baselinePriceUsd,
          currentPrice: currentPriceUsd,
          priceChange: gain * 100 // Convert to percentage for legacy compatibility
        };
      });
      
      // BASELINE FIX LOGGING: Track polls with USD baseline (must be 0.000% immediately after LOCK)
      if (race.status === 'LOCKED' || race.status === 'IN_PROGRESS') {
        const deltaLog = priceChanges.reduce((acc, change) => {
          const pct = change.priceChange;
          acc[change.symbol] = `${pct.toFixed(3)}%`;
          return acc;
        }, {} as Record<string, string>);
        console.log(`[TICK] race=${raceId} deltas: ${JSON.stringify(deltaLog)}`);
        
        // BASELINE_MISMATCH assertion: flag if any delta > 0.2% immediately after lock
        if (race.status === 'LOCKED') {
          priceChanges.forEach(change => {
            if (Math.abs(change.priceChange) > 0.2) {
              console.log(`BASELINE_MISMATCH: ${change.symbol} shows ${change.priceChange.toFixed(3)}% immediately after LOCK (should be ~0.0%)`);
            }
          });
        }
      }
      
      // Find winner (highest price change)
      const winnerIndex = priceChanges.reduce((maxIndex, current, index) => 
        current.priceChange > priceChanges[maxIndex].priceChange ? index : maxIndex, 0
      );
      const winner = priceChanges[winnerIndex];
      
      // Find the winning runner with logo
      const winningRunner = race.runners.find(runner => runner.mint === winner.mint);
      
      res.json({
        currentLeader: {
          symbol: winner.symbol,
          priceChange: winner.priceChange,
          logoURI: winningRunner?.logoURI
        },
        priceChanges: priceChanges
      });
    } catch (error) {
      console.error("Error fetching race progress:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Historical price series for a race (for late viewers and replays)
  app.get("/api/races/:raceId/history", async (req, res) => {
    try {
      const { raceId } = req.params;
      const race = await getDb()?.getRace(raceId);
      if (!race) {
        return res.status(404).json({ error: "Race not found" });
      }

      // Determine race window
      const startMs = race.lockedBlockTimeMs || race.lockedTs || race.startTs;
      const endMs =
        race.status === 'SETTLED'
          ? (race.settledBlockTimeMs || startMs + 20 * 60 * 1000)
          : Date.now();
      const durationMs = Math.max(10 * 1000, endMs - startMs);
      const durationMinutes = Math.max(1, Math.ceil(durationMs / 60000));
      const durationSec = Math.ceil(durationMs / 1000);

      // Pull OHLCV candles for each runner and convert to relative change series
      const { getTokenOHLCV } = await import('./geckoterminal');

      const runnerHistories = await Promise.all(
        race.runners.map(async (runner: any, runnerIndex: number) => {
          try {
            const candles = await getTokenOHLCV(runner.mint, startMs, durationMinutes, runner.poolAddress);

            // Establish baseline from lock (prefer stored baseline if present)
            const baseline =
              runner.initialPriceUsd || runner.initialPrice || (candles[0]?.open ?? 0);
            if (!baseline || baseline <= 0) {
              // Fallback: cannot compute without baseline
              return {
                runnerIndex,
                mint: runner.mint,
                points: [{ t: 0, v: 1 }],
              };
            }

            // Convert candles to points: t in seconds since lock, v as price multiplier (1.0 = baseline)
            const points = [{ t: 0, v: 1 } as { t: number; v: number }];
            for (const c of candles) {
              const tSec = Math.max(
                0,
                Math.min(durationSec, Math.floor((c.timestamp - startMs) / 1000))
              );
              const pct = ((c.close - baseline) / baseline) * 100;
              const v = 1 + pct / 100;
              // Avoid duplicates at same t; keep last
              if (points.length && points[points.length - 1].t === tSec) {
                points[points.length - 1] = { t: tSec, v };
              } else {
                points.push({ t: tSec, v });
              }
            }

            // Ensure final point at current end of window
            if (points[points.length - 1]?.t < durationSec) {
              const last = points[points.length - 1] || { t: 0, v: 1 };
              points.push({ t: durationSec, v: last.v });
            }

            return { runnerIndex, mint: runner.mint, points };
          } catch (e) {
            console.warn(`history: failed for ${runner.mint}`, e);
            return { runnerIndex, mint: runner.mint, points: [{ t: 0, v: 1 }] };
          }
        })
      );

      res.json({
        raceId,
        startTs: startMs,
        durationSec,
        runners: runnerHistories,
        source: 'GeckoTerminal OHLCV'
      });
    } catch (error) {
      console.error('History endpoint error:', error);
      res.status(500).json({ error: 'Failed to build race history' });
    }
  });

  app.get("/api/races/:raceId/totals", async (req, res) => {
    try {
      const currency = ((req.query.currency as string) || 'SOL').toUpperCase();
      const { getDb } = await import('./db');
      const race = await getDb()?.getRace(req.params.raceId);
      if (!race) return res.status(404).json({ error: 'Race not found' });
      // Include seeds in totals so UI matches settlement
      const all = await getDb()?.getBetsForRace(req.params.raceId) as any[];
      const bets = all.filter(b => (b?.currency || 'RACE') === currency);
      const { calculateRaceTotals } = await import('./bets');
      const rbps = currency === 'SOL' ? 500 : race.rakeBps;
      const totals = calculateRaceTotals(bets as any, race.runners.length, rbps);
      res.json(totals);
    } catch (e) {
      console.error('Get race totals error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  // Filter by currency via query?currency=SOL|RACE handled in handler
  app.get("/api/races/:raceId/bets", handleGetUserBets);

  // Betting routes
  app.post("/api/bet", async (req, res) => {
    // Feature flag: block new bets globally (except server-side handlers may still reconcile)
    try {
      const blockBets = ((process.env.BLOCK_NEW_BETS || '').toLowerCase() === '1' || (process.env.BLOCK_NEW_BETS || '').toLowerCase() === 'true');
      // Block RACE currency bets until enabled
      const currency = String((req.body?.currency || '')).toUpperCase();
      const enableRace = ((process.env.ENABLE_RACE_BETS || '').toLowerCase() === '1' || (process.env.ENABLE_RACE_BETS || '').toLowerCase() === 'true');
      if (currency === 'RACE' && !enableRace) {
        return res.status(503).json({ error: 'RACE betting is coming soon. SOL betting is live now.' });
      }
      if (blockBets) {
        return res.status(503).json({ error: 'Betting is temporarily disabled (maintenance). Please try later.' });
      }
    } catch {}
    console.log('🚀 /api/bet endpoint hit!', JSON.stringify(req.body, null, 2));
    try {
      await handlePlaceBet(req, res);
    } catch (error) {
      console.error('🚨 Route error:', error);
      res.status(500).json({ error: error.message });
    }
  });
  // Check a tx signature for a bet and return parsed memo/transfer details for UI recovery (supports SPL and SOL)
  app.get("/api/bet/check/:sig", async (req, res) => {
    try {
      const sig = req.params.sig;
      const treasury = await getDb()?.getTreasury();
      const { serverKeypair, verifyTransaction, verifySolTransfer } = await import('./solana');
      const { PublicKey } = await import('@solana/web3.js');
      const escrow = serverKeypair.publicKey;

      // Try SPL path first if RACE mint exists
      if (treasury.raceMint) {
        try {
          const mint = new PublicKey(treasury.raceMint);
          const result = await verifyTransaction(sig, mint, escrow, BigInt(0));
          if (result && (result.valid || result.memo || (result.transfers && result.transfers.length > 0))) {
            return res.json(result);
          }
        } catch {}
      }

      // Fallback to SOL path with amount-agnostic check to surface memo/slot/blockTime
      try {
        const resultSol = await verifySolTransfer(sig, escrow, BigInt(0));
        return res.json(resultSol);
      } catch {}

      res.status(404).json({ valid: false, error: 'Transaction not found' });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  // Manual rescan for a wallet (optionally scoped to raceId). Useful if UI missed recording but chain shows transfer.
  app.post("/api/bet/rescan", async (req, res) => {
    try {
      const enabled = ((process.env.ENABLE_BET_RESCAN || '').toLowerCase() === '1' || (process.env.ENABLE_BET_RESCAN || '').toLowerCase() === 'true');
      if (!enabled) {
        return res.status(404).json({ error: 'Not found' });
      }
      const { wallet, raceId, pages, limitPerPage } = req.body || {};
      if (!wallet || typeof wallet !== 'string') {
        return res.status(400).json({ error: 'wallet required' });
      }
      const { rescanBetsForWallet } = await import('./reconcile');
      const result = await rescanBetsForWallet({ wallet, raceId, pages, limitPerPage });
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('Rescan error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/claim", async (req, res) => {
    // Feature flag: block settlements/claims globally
    try {
      const blockSettle = ((process.env.BLOCK_SETTLEMENTS || '').toLowerCase() === '1' || (process.env.BLOCK_SETTLEMENTS || '').toLowerCase() === 'true');
      if (blockSettle) {
        return res.status(503).json({ error: 'Settlement actions are paused (maintenance). Please try later.' });
      }
    } catch {}
    try {
      const { raceId, wallet } = req.body;
      
      if (!raceId || !wallet) {
        return res.status(400).json({ error: "raceId and wallet are required" });
      }
      // For security, we no longer expose manual claim if server handles auto payouts on settlement.
      return res.status(400).json({ error: "Claims are auto-paid on settlement" });
    } catch (error) {
      console.error("Claim error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Public faucet endpoint (no auth required for beta users)
  app.post("/api/faucet", handlePublicFaucet);

  // Admin routes (protected)
  app.post("/api/admin/race/create", requireAdminAuth, handleCreateRace);
  app.post("/api/admin/race/force-start", requireAdminAuth, handleForceStartRace);
  app.post("/api/admin/race/lock", requireAdminAuth, handleLockRace);
  app.post("/api/admin/race/cancel", requireAdminAuth, handleCancelRace);
  app.post("/api/admin/clear-races", requireAdminAuth, (req, res, next) => {
    try {
      const mode = selectedDatabase();
      const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
      if (isProd && mode === 'postgres') {
        return res.status(403).json({ error: 'Operation disabled in production' });
      }
    } catch {}
    return (handleClearRaces as any)(req, res, next);
  });
  app.post("/api/admin/settle-stuck", requireAdminAuth, handleSettleStuckRaces);
  app.post("/api/admin/faucet", requireAdminAuth, handleFaucet);
  app.post("/api/admin/reset-race-mint", requireAdminAuth, (req, res, next) => {
    try {
      const mode = selectedDatabase();
      const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
      if (isProd && mode === 'postgres') {
        return res.status(403).json({ error: 'Operation disabled in production' });
      }
    } catch {}
    return (handleResetRaceMint as any)(req, res, next);
  });
  // Block seed/reset operations in production
  app.post("/api/admin/reset-races", requireAdminAuth, (req, res, next) => {
    try {
      const mode = selectedDatabase();
      const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
      if (isProd && mode === 'postgres') {
        return res.status(403).json({ error: 'Operation disabled in production' });
      }
    } catch {}
    return (handleResetRaces as any)(req, res, next);
  });
  app.post("/api/admin/reset-jackpots", requireAdminAuth, (req, res, next) => {
    try {
      const mode = selectedDatabase();
      const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
      if (isProd && mode === 'postgres') {
        return res.status(403).json({ error: 'Operation disabled in production' });
      }
    } catch {}
    return (handleResetJackpots as any)(req, res, next);
  });
  app.get("/api/admin/stats", requireAdminAuth, handleAdminStats);
  app.post("/api/admin/maintenance", requireAdminAuth, handleSetMaintenance);
  app.post("/api/admin/restart-races", requireAdminAuth, handleRestartRaces);
  
  // Post news from monitor
  app.post("/api/admin/post-news", requireAdminAuth, async (req, res) => {
    try {
      const { headline, url } = req.body;
      
      if (!headline || typeof headline !== 'string') {
        return res.status(400).json({ error: 'Headline is required' });
      }
      
      const { postNews } = await import('./telegram-scheduler');
      const posted = await postNews(headline, url);
      
      if (posted) {
        res.json({ success: true, message: 'News posted successfully' });
      } else {
        res.json({ success: false, message: 'News not posted (dedupe or blocked)' });
      }
    } catch (error) {
      console.error('[api/admin/post-news] Error:', error);
      res.status(500).json({ error: 'Failed to post news', details: (error as Error).message });
    }
  });
  
  // Manual test triggers for Telegram scheduler
  app.post("/api/admin/test-referral-post", requireAdminAuth, async (req, res) => {
    try {
      const scheduler = await import('./telegram-scheduler');
      const postReferral = (scheduler as any).postReferral;
      if (!postReferral) {
        return res.status(500).json({ error: 'postReferral function not found' });
      }
      await postReferral(false);
      res.json({ success: true, message: 'Referral post triggered' });
    } catch (error) {
      console.error('[api/admin/test-referral-post] Error:', error);
      res.status(500).json({ error: 'Failed to trigger referral post', details: (error as Error).message });
    }
  });
  
  app.post("/api/admin/test-explainer-post", requireAdminAuth, async (req, res) => {
    try {
      const scheduler = await import('./telegram-scheduler');
      const postExplainer = (scheduler as any).postExplainer;
      if (!postExplainer) {
        return res.status(500).json({ error: 'postExplainer function not found' });
      }
      await postExplainer(false);
      res.json({ success: true, message: 'Explainer post triggered' });
    } catch (error) {
      console.error('[api/admin/test-explainer-post] Error:', error);
      res.status(500).json({ error: 'Failed to trigger explainer post', details: (error as Error).message });
    }
  });

  // Settlement management endpoints
  app.get("/api/admin/settlement/failed", requireAdminAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string || '100');
      const failedTransfers = await getDb().getFailedSettlementTransfers(limit);
      
      res.json({
        success: true,
        count: failedTransfers.length,
        transfers: failedTransfers
      });
    } catch (error) {
      console.error('[api/admin/settlement/failed] Error:', error);
      res.status(500).json({ error: 'Failed to fetch failed transfers', details: (error as Error).message });
    }
  });

  app.post("/api/admin/settlement/retry", requireAdminAuth, async (req, res) => {
    try {
      const limit = parseInt(req.body.limit || '100');
      const { retryFailedTransfers } = await import('./batched-settlement');
      
      const result = await retryFailedTransfers(limit);
      
      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error('[api/admin/settlement/retry] Error:', error);
      res.status(500).json({ error: 'Failed to retry transfers', details: (error as Error).message });
    }
  });

  app.post("/api/admin/process-missed-payouts", requireAdminAuth, handleProcessMissedPayouts);

  app.get("/api/admin/settlement/stats", requireAdminAuth, async (req, res) => {
    try {
      const db = getDb();
      
      // Get all transfers with status
      const query = `
        SELECT 
          status,
          currency,
          COUNT(*) as count,
          SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as successful,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending
        FROM settlement_transfers
        GROUP BY status, currency
      `;
      
      const result = await (db as any).pool.query(query);
      
      res.json({
        success: true,
        stats: result.rows
      });
    } catch (error) {
      console.error('[api/admin/settlement/stats] Error:', error);
      res.status(500).json({ error: 'Failed to fetch settlement stats', details: (error as Error).message });
    }
  });

    // Wallet balance routes
    app.get("/api/wallet/:address/balances", async (req, res) => {
      try {
        const { address } = req.params;
        const treasury = await getDb()?.getTreasury();
        const { raceMintAddress } = await import('./solana');
        
        // Choose mint: prefer environment RACE_MINT, fallback to DB
        const chosenMint = raceMintAddress || treasury.raceMint;
        if (!chosenMint) {
          return res.status(500).json({ error: "RACE mint not initialized" });
        }

        try {
          const publicKey = new PublicKey(address);
          const raceMintKey = new PublicKey(chosenMint);

          // Get SOL balance
          const solBalance = await balancesConnection.getBalance(publicKey);
          const solBalanceInSol = (solBalance / 1e9).toFixed(6);

          // Get RACE token balance, supporting both Token-2022 and legacy token programs
          let raceBalance = "0";
          const { decimals: raceDecimals, programId: preferredProgram } = await resolveMintInfo(raceMintKey);
          const programCandidates = [
            preferredProgram,
            ...tokenProgramPriority.filter(program => program !== preferredProgram)
          ];
          let detectedProgram: TokenProgramId | null = null;
          for (const programId of programCandidates) {
            if (!programId) continue;
            try {
              const tokenAccount = await getAssociatedTokenAddress(
                raceMintKey,
                publicKey,
                false,
                programId,
                ASSOCIATED_TOKEN_PROGRAM_ID
              );
              const account = await getAccount(
                balancesConnection,
                tokenAccount,
                undefined,
                programId
              );
              const rawAmount = new Decimal(account.amount?.toString?.() || '0');
              const divisor = new Decimal(10).pow(raceDecimals);
              raceBalance = rawAmount.div(divisor).toFixed(Math.min(6, Math.max(2, raceDecimals)));
              detectedProgram = programId;
              break;
            } catch (tokenError) {
              // Token account doesn't exist under this program; try next candidate
              continue;
            }
          }

          res.json({
            sol: solBalanceInSol,
            race: raceBalance,
            raceDecimals,
            raceProgram: detectedProgram?.toBase58?.()
          });
        } catch (balanceError) {
          console.error("Error fetching balances:", balanceError);
          res.json({
            sol: "0",
            race: "0", 
            raceDecimals: 9
          });
        }
      } catch (error) {
        console.error("Get balances error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

  // Operational visibility: recent settlement errors for Cursor/ops
  app.get('/api/settlement/errors', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '100'))));
      const raceId = String(req.query.raceId || '');
      const rows = raceId
        ? await getDb()?.getSettlementErrors(raceId, limit)
        : await getDb()?.getRecentSettlementErrors(limit);
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Internal server error' });
    }
  });

  // Public persistence diagnostics (safe, no sensitive data)
  app.get('/api/persistence', async (_req, res) => {
    try {
      const { getDbDiagnostics } = await import('./db/index');
      const diag = await getDbDiagnostics();
      const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
      const hasDbUrl = !!process.env.DATABASE_URL;
      
      const persistenceStatus = {
        status: diag.postgres?.ready ? 'healthy' : (isProd && !hasDbUrl ? 'warning' : 'dev-mode'),
        backend: diag.postgres?.ready ? 'postgres' : 'sqlite-only',
        persistent: diag.postgres?.ready,
        warning: !diag.postgres?.ready && isProd ? 'Postgres not configured - data will reset on redeploy' : undefined,
        postgres: {
          ready: diag.postgres?.ready,
          configured: hasDbUrl,
          receipts: diag.postgres?.bets_count || 0,
          leaderboard_stats: diag.postgres?.user_stats_count || 0,
          leaderboard_results: diag.postgres?.user_race_results_count || 0,
          recent_winners: diag.postgres?.recent_winners_count || 0,
        },
        sqlite: {
          receipts: diag.sqlite?.bets_count || 0,
          leaderboard_stats: diag.sqlite?.user_stats_count || 0,
          leaderboard_results: diag.sqlite?.user_race_results_count || 0,
          recent_winners: diag.sqlite?.recent_winners_count || 0,
        },
        setup_required: isProd && !hasDbUrl
      };
      
      res.json(persistenceStatus);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'failed' });
    }
  });

  // Admin-only: full database diagnostics to verify SQLite vs Postgres usage in deployment
  app.get('/api/admin/db-diagnostics', requireAdminAuth, async (_req, res) => {
    try {
      // Use selector-based diagnostics to avoid touching SQLite in production
      const { getDbDiagnostics } = await import('./db/index');
      const diag = await getDbDiagnostics();
      res.json(diag);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'failed' });
    }
  });

  // User receipts and stats endpoints (read-only)
  app.get('/api/user/:wallet/receipts', async (req, res) => {
    try {
      const wallet = req.params.wallet;
      const limit = Math.max(1, Math.min(50, parseInt((req.query.limit as string) || '20')));
      
      // Try SQLite first, but if it's empty and Postgres is available, hydrate from Postgres
      let bases = await getDb()?.getUserRecentResults(wallet, Math.max(limit * 2, 20));
      
      // CRITICAL FIX: Always check Postgres if SQLite has no data for this wallet
      if (bases.length === 0 && pgPool) {
        // SQLite is empty but Postgres might have data - try to load from Postgres
        console.log(`🔍 SQLite empty for wallet ${wallet.slice(0, 8)}..., checking Postgres...`);
        try {
          const pgResults = await pgPool.query(
            `SELECT race_id, bet_amount, payout_amount, win, edge_points, ts 
             FROM user_race_results 
             WHERE wallet = $1 
             ORDER BY ts DESC 
             LIMIT $2`,
            [wallet, Math.max(limit * 2, 20)]
          );
          if (pgResults.rows && pgResults.rows.length > 0) {
            console.log(`📦 Found ${pgResults.rows.length} receipts in Postgres for ${wallet.slice(0, 8)}...`);
            // Hydrate into SQLite for future requests
            for (const row of pgResults.rows) {
              try {
                await getDb()?.upsertUserRaceResult({
                  wallet,
                  raceId: String(row.race_id),
                  betAmount: String(row.bet_amount || '0'),
                  payoutAmount: String(row.payout_amount || '0'),
                  win: Boolean(row.win),
                  edgePoints: String(row.edge_points || '0'),
                  ts: Number(row.ts) || Date.now()
                });
              } catch (e) {
                console.warn('⚠️ Failed to hydrate single result:', e);
              }
            }
            // Re-read from SQLite now that it's hydrated
            bases = await getDb()?.getUserRecentResults(wallet, Math.max(limit * 2, 20));
            console.log(`✅ Hydrated ${pgResults.rows.length} receipts for ${wallet.slice(0, 8)}... from Postgres into SQLite`);
          } else {
            console.log(`ℹ️  No receipts found in Postgres for ${wallet.slice(0, 8)}...`);
          }
        } catch (e) {
          console.error('❌ Failed to load receipts from Postgres:', e);
        }
      }
      
      // Start from the most recent races this user participated in (currency-agnostic)

      const allRows: Array<{ raceId: string; betAmount: string; payoutAmount: string; win: number | boolean; edgePoints?: string; ts: number; txSig?: string; currency: 'SOL' | 'RACE'; pending?: boolean; error?: string }> = [];

      // Optional: prefetch Postgres transfers/errors for these races when enabled
      let pgTransfersByRace: Map<string, Array<any>> | null = null;
      let pgErrorsByRace: Map<string, Array<any>> | null = null;
      if (usePgForReceipts) {
        try {
          const raceIds = Array.from(new Set(bases.map((b: any) => String(b.raceId))));
          if (raceIds.length > 0) {
            const transfersQuery = `
              SELECT id, race_id, transfer_type, to_wallet, amount, tx_sig, COALESCE(currency,'RACE') AS currency, ts
              FROM settlement_transfers
              WHERE to_wallet = $1 AND race_id = ANY($2)
            `;
            const tRes = await pgPool.query(transfersQuery, [wallet, raceIds]);
            pgTransfersByRace = new Map<string, Array<any>>();
            for (const row of tRes.rows || []) {
              const key = String(row.race_id);
              const arr = pgTransfersByRace.get(key) || [];
              arr.push({
                id: String(row.id),
                raceId: String(row.race_id),
                transferType: String(row.transfer_type),
                toWallet: String(row.to_wallet),
                amount: String(row.amount ?? '0'),
                txSig: String(row.tx_sig ?? ''),
                currency: String(row.currency || 'RACE'),
                ts: Number(row.ts) || Date.now()
              });
              pgTransfersByRace.set(key, arr);
            }

            const errorsQuery = `
              SELECT id, race_id, to_wallet, amount, COALESCE(currency,'RACE') AS currency, error, ts
              FROM settlement_errors
              WHERE to_wallet = $1 AND race_id = ANY($2)
            `;
            const eRes = await pgPool.query(errorsQuery, [wallet, raceIds]);
            pgErrorsByRace = new Map<string, Array<any>>();
            for (const row of eRes.rows || []) {
              const key = String(row.race_id);
              const arr = pgErrorsByRace.get(key) || [];
              arr.push({
                id: String(row.id),
                raceId: String(row.race_id),
                toWallet: row.to_wallet ? String(row.to_wallet) : undefined,
                amount: row.amount !== null && row.amount !== undefined ? String(row.amount) : undefined,
                currency: (String(row.currency || 'RACE').toUpperCase() === 'SOL' ? 'SOL' : 'RACE') as 'SOL' | 'RACE',
                error: String(row.error || ''),
                ts: Number(row.ts) || Date.now()
              });
              pgErrorsByRace.set(key, arr);
            }
          }
        } catch (e) {
          // If PG fails, fall back to SQLite-only path
          pgTransfersByRace = null;
          pgErrorsByRace = null;
        }
      }

      for (const r of bases) {
        const raceId = r.raceId;
        const transfersAll = (pgTransfersByRace ? (pgTransfersByRace.get(raceId) || []) : (await getDb()?.getSettlementTransfers(raceId) || []));
        const betsAll = (await getDb()?.getBetsForWallet(wallet, raceId) || []) as Array<{ sig?: string; ts?: number; clientId?: string; memo?: string; currency?: string; amount?: string }>;
        const nonSeed = betsAll.filter(b => (b?.clientId !== 'HOUSE_SEED' && b?.memo !== 'HOUSE_SEED'));
        const considered = nonSeed.length > 0 ? nonSeed : betsAll;

        for (const currency of ['RACE', 'SOL'] as const) {
          const betsC = considered.filter(b => String(b?.currency || 'RACE').toUpperCase() === currency);
          const betSum = betsC.reduce((sum, b) => sum + (parseFloat(b?.amount || '0') || 0), 0);
          const lastBet = betsC.reduce((latest, b) => {
            if (!latest) return b;
            const bt = Number(b?.ts || 0);
            const lt = Number((latest as any)?.ts || 0);
            return bt >= lt ? b : latest;
          }, undefined as any);
          const payoutsC = transfersAll.filter(t => t.transferType === 'PAYOUT' && t.toWallet === wallet && ((t?.currency || 'RACE') === currency));
          const payoutSum = payoutsC.reduce((sum, t) => sum + (parseFloat(t?.amount || '0') || 0), 0);
          const payoutTx = payoutsC[0]?.txSig;
          const payoutTs = payoutsC[0]?.ts;

          let isRefundCase = false;
          let expectedPayoutStr: string | undefined;
          try {
            // Only compute settlement if the race had any bets in this currency
            if (betsC.length > 0 || transfersAll.some(t => (t?.currency || 'RACE') === currency)) {
              const race = await getDb()?.getRace(raceId);
              if (race) {
                const { calculateSettlement } = await import('./settlement');
                const raceForCurrency = currency === 'SOL' ? { ...race, rakeBps: 500 } as any : race as any;
                const opts = currency === 'SOL' ? { treasuryRatio: 0.6, jackpotRatio: 0.4 } : undefined;
                const settlement = await calculateSettlement((await getDb()?.getBetsForRace(raceId) as any[]).filter(b => (b?.currency || 'RACE') === currency) as any, raceForCurrency as any, opts as any);
                isRefundCase = !settlement.winnerPayouts || settlement.winnerPayouts.size === 0;
                const ew = settlement.winnerPayouts?.get?.(wallet);
                if (ew && typeof ew.toString === 'function') {
                  expectedPayoutStr = ew.toString();
                }
              }
            }
          } catch {}

          // Decide inclusion: only include rows where user participated or received payout/refund in this currency
          const include = (betSum > 0) || (payoutSum > 0) || (expectedPayoutStr && Number(expectedPayoutStr) > 0) || isRefundCase;
          if (!include) continue;

          // Pull pending/error info for this race+wallet if applicable
          let pending: boolean | undefined;
          let errorMsg: string | undefined;
          if (payoutSum === 0) {
            try {
              const errs = pgErrorsByRace ? (pgErrorsByRace.get(raceId) || []) : (await getDb()?.getSettlementErrors(raceId, 200) || []);
              const mine = errs.find((e: any) => e.toWallet === wallet && ((e?.currency || 'RACE') === currency));
              if (mine) {
                pending = true;
                errorMsg = mine.error;
              }
            } catch {}
          }

          // Determine final amounts and flags for this currency row
          const payoutAmount = payoutSum > 0 ? payoutSum.toString() : (isRefundCase ? (betSum.toString()) : (expectedPayoutStr || '0'));
          const win = payoutSum > 0 ? (!isRefundCase) : ((expectedPayoutStr && Number(expectedPayoutStr) > 0) ? true : false);
          const txSig = payoutTx || lastBet?.sig;
          const ts = payoutTs || Number(lastBet?.ts || r.ts);

          allRows.push({
            raceId,
            betAmount: betSum.toString(),
            payoutAmount,
            win,
            edgePoints: r.edgePoints,
            ts,
            txSig,
            currency,
            pending,
            error: errorMsg
          });
        }
      }

      // Sort by timestamp desc and cap to requested limit
      const sorted = allRows.sort((a, b) => b.ts - a.ts).slice(0, limit);
      res.json(sorted);
    } catch (error) {
      console.error('User receipts error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/user/:wallet/summary', async (req, res) => {
    try {
      const wallet = req.params.wallet;
      // Prefer summarized stats; if missing, aggregate from results
      let stats = await getDb()?.getUserStats(wallet);
      if (!stats || stats.totalRaces === undefined) {
        stats = getDb()?.getUserStatsFromResults(wallet) as any;
      }
      res.json(stats || { wallet, totalRaces: 0, wins: 0, losses: 0, totalWagered: '0', totalAwarded: '0', edgePoints: '0', lastUpdated: 0 });
    } catch (error) {
      console.error('User summary error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Share routes for win posters
  app.get("/api/share/race/:raceId/win/:wallet", async (req, res) => {
    try {
      const { raceId } = req.params;

      const race = await getDb()?.getRace(raceId) as Race | undefined;
      if (!race) {
        return res.status(404).json({ error: "Race not found" });
      }

      // Compute simple totals
      const bets = await getDb()?.getBetsForRace(raceId) || [];
      const totalPot = bets.reduce((sum: number, b: any) => {
        const n = parseFloat(b.amount || '0');
        return sum + (isNaN(n) ? 0 : n);
      }, 0);
      const betCount = bets.length;

      // Results URL
      const resultsUrl = `${req.protocol}://${req.get('host')}/race/${raceId}/results`;

      // Build a neat, length-safe tweet
      const tweet = buildRaceResultsTweet(race, {
        totalPot,
        betCount,
        resultsUrl
      });

      const intent = new URL('https://twitter.com/intent/tweet');
      intent.searchParams.set('text', tweet);
      return res.redirect(intent.toString());
    } catch (error) {
      console.error("Share poster error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Treasury endpoint
  app.get("/api/treasury", async (req, res) => {
    try {
      const treasury = await getDb()?.getTreasury();
      const { serverKeypair, treasuryPubkey, jackpotPubkey } = await import('./solana');
      // Expose configured bet min/max to clients for preflight validation (per currency)
      let betMinRace: string | undefined;
      let betMaxRace: string | undefined;
      let betMinSol: string | undefined;
      let betMaxSol: string | undefined;
      try {
        const minRaceStr = (process.env.BET_MIN_RACE || process.env.BET_MIN || '').trim();
        const maxRaceStr = (process.env.BET_MAX_RACE || process.env.BET_MAX || '').trim();
        const minSolStr = (process.env.BET_MIN_SOL || '').trim();
        const maxSolStr = (process.env.BET_MAX_SOL || '').trim();
        betMinRace = minRaceStr || undefined;
        betMaxRace = maxRaceStr || undefined;
        betMinSol = minSolStr || undefined;
        betMaxSol = maxSolStr || undefined;
      } catch {}
      // Meme reward configuration
      const memeRewardEnabled = String(process.env.ENABLE_MEME_REWARD || '').toLowerCase() === 'true' || 
                                 String(process.env.ENABLE_MEME_REWARD || '').toLowerCase() === '1';
      const memeRewardSolAmount = process.env.MEME_REWARD_SOL_AMOUNT || '0.1';
      
      res.json({
        ...treasury,
        escrowPubkey: serverKeypair.publicKey.toString(),
        treasuryPubkey: treasuryPubkey?.toString() || serverKeypair.publicKey.toString(),
        jackpotPubkey: jackpotPubkey?.toString() || serverKeypair.publicKey.toString(),
        houseSeedAmountSol: (process.env.HOUSE_SEED_AMOUNT_SOL || '').trim() || '0.01',
        houseSeedAmountRace: (process.env.HOUSE_SEED_AMOUNT_RACE || process.env.HOUSE_SEED_AMOUNT || '').trim() || '1000',
        betMinRace,
        betMaxRace,
        betMinSol,
        betMaxSol,
        memeRewardEnabled,
        memeRewardSolAmount
      });
    } catch (error) {
      console.error("Get treasury error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

    async function fetchRemoteRecentWinners(limit: number): Promise<any[]> {
      const cacheKey = `remote-recent-winners-${limit}`;
      
      // Check if we've recently failed to fetch (avoid repeated abort errors)
      const cachedFailure = remoteRecentWinnersCache.get<boolean>(`${cacheKey}-failed`);
      if (cachedFailure) {
        // Silently return empty array if we recently failed (don't log to avoid spam)
        return [];
      }
      
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${RACEPUMP_PUBLIC_BASE}/api/recent-winners?limit=${limit}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        let result: any[] = [];
        if (Array.isArray(payload)) result = payload;
        else if (Array.isArray(payload?.recentWinners)) result = payload.recentWinners;
        else if (Array.isArray(payload?.data)) result = payload.data;
        
        // Cache successful results for 60 seconds
        if (result.length > 0) {
          remoteRecentWinnersCache.set(cacheKey, result, 60);
        }
        return result;
      } catch (error) {
        // Cache the failure for 30 seconds to prevent repeated attempts
        remoteRecentWinnersCache.set(`${cacheKey}-failed`, true, 30);
        // Only log if it's not an abort error (to reduce log spam)
        if (!(error as Error)?.message?.includes("aborted") && !(error as Error)?.message?.includes("AbortError")) {
          console.warn("[recent-winners] remote fallback failed:", (error as Error)?.message || error);
        }
        return [];
      }
    }

    // Recent winners endpoint
    app.get('/api/recent-winners', async (req, res) => {
      try {
        const limit = Math.min(parseInt(req.query.limit as string) || 6, 10);
        let recentWinners = await getDb()?.getRecentWinners(limit);
        
        // Only try remote fallback if we have no local winners AND haven't tried recently
        if (!recentWinners?.length) {
          const cacheKey = `remote-recent-winners-${limit}`;
          const cached = remoteRecentWinnersCache.get<any[]>(cacheKey);
          if (cached && cached.length > 0) {
            recentWinners = cached;
          } else {
            recentWinners = await fetchRemoteRecentWinners(limit);
          }
        }
        // Don't return early - always proceed to decoration/top-up logic even if recentWinners is empty

      // Use new state machine for status computation and timing
      const { RaceStateMachine } = await import('./race-state-machine');
      const { RaceStatus } = await import('@shared/schema');
      
      // Helper to enrich a race with totals (including per-currency) and timing for UI
      const decorate = async (race: any) => {
        // Prefer persisted pot values from recent_winners snapshot (avoids recompute after redeploy)
        const persistedPot = (race as any).totalPot;
        const persistedCount = (race as any).betCount;
        const persistedPotSol = (race as any).totalPotSol;
        const persistedPotRace = (race as any).totalPotRace;
        const persistedCountSol = (race as any).betCountSol;
        const persistedCountRace = (race as any).betCountRace;

        // If persisted currency-specific pots exist, use them; otherwise compute from bets as fallback
        let totalPotSol: number;
        let totalPotRace: number;
        let betCountSol: number;
        let betCountRace: number;

        if (persistedPotSol !== undefined && persistedPotRace !== undefined) {
          // Use persisted values (most reliable after redeploy)
          totalPotSol = parseFloat(persistedPotSol) || 0;
          totalPotRace = parseFloat(persistedPotRace) || 0;
          betCountSol = persistedCountSol !== undefined ? Number(persistedCountSol) : 0;
          betCountRace = persistedCountRace !== undefined ? Number(persistedCountRace) : 0;
        } else {
          // Fallback: compute from bets (if available in SQLite)
          const bets = await getDb()?.getBetsForRace(race.id) as any[];
          const betsSol = bets.filter(b => (b?.currency || 'RACE') === 'SOL');
          const betsRace = bets.filter(b => (b?.currency || 'RACE') !== 'SOL');
          totalPotSol = betsSol.reduce((sum, bet) => sum + parseFloat(bet.amount || '0'), 0);
          totalPotRace = betsRace.reduce((sum, bet) => sum + parseFloat(bet.amount || '0'), 0);
          betCountSol = betsSol.length;
          betCountRace = betsRace.length;
        }

        // Compute combined totals for legacy compatibility
        const computedPot = totalPotSol + totalPotRace;
        let totalPot = persistedPot !== undefined ? Number(persistedPot) : computedPot;
        let betCount = persistedCount !== undefined ? Number(persistedCount) : (betCountSol + betCountRace);

        // Final fallback: try user_race_results if both persisted and computed are 0
        if (totalPot === 0 && betCount === 0) {
          const snap = await getDb()?.getRacePotSnapshot(race.id);
          const snapPot = parseFloat(snap.totalPot || '0');
          if (snapPot > 0) {
            totalPot = snapPot;
            betCount = snap.betCount;
          }
        }

        const expectedStatus = await RaceStateMachine.getExpectedStatus(race);
        const timing = await RaceStateMachine.getRaceTiming(race);

        return {
          ...race,
          totalPot: totalPot.toString(),
          betCount,
          // Per-currency snapshots for UI to render amounts according to selected mode
          totalPotSol: totalPotSol.toString(),
          betCountSol,
          totalPotRace: totalPotRace.toString(),
          betCountRace,
          computedStatus: expectedStatus,
          timing: {
            timeUntilNextTransition: timing.timeUntilNextTransition,
            nextTransition: timing.nextTransition,
            progress: timing.progress,
            uiTimeUntilNextTransition: timing.uiTimeUntilNextTransition,
            uiLabel: timing.uiLabel,
            targetTs: timing.targetTs,
            uiTargetTs: timing.uiTargetTs
          }
        };
      };

      // Start with persisted recent winners and decorate
      let winnersWithDetails: any[] = [];
      if (recentWinners?.length > 0) {
        winnersWithDetails = (await Promise.all(recentWinners.map(decorate)))
          // Strict safety filter: settled races with a determined winner only
          .filter((r: any) => (r.status === 'SETTLED' || r.computedStatus === 'SETTLED') && r.winnerIndex !== undefined);
      }

      // If we have fewer than requested, top-up from settled races history (without duplicates)
      if (winnersWithDetails.length < limit) {
        const have = new Set(winnersWithDetails.map((r: any) => r.id));
        const settledRaces = await getDb()?.getRaces(RaceStatus.SETTLED as any);
        const candidates = await Promise.all(settledRaces
          .filter((r: any) => r.winnerIndex !== undefined && !have.has(r.id))
          .sort((a: any, b: any) => (b.settledBlockTimeMs || b.startTs || b.createdAt || 0) - (a.settledBlockTimeMs || a.startTs || a.createdAt || 0))
          .slice(0, Math.max(0, limit - winnersWithDetails.length))
          .map(decorate));
        winnersWithDetails = winnersWithDetails.concat(candidates);
      }
      // Final cap to limit and stable order: most recently settled first
      winnersWithDetails = winnersWithDetails
        .sort((a: any, b: any) => (b.settledBlockTimeMs || b.startTs || b.createdAt || 0) - (a.settledBlockTimeMs || a.startTs || a.createdAt || 0))
        .slice(0, limit);
      
      res.json(winnersWithDetails);
    } catch (error) {
      console.error('Recent winners error:', error);
      res.status(500).json({ error: 'Failed to fetch recent winners' });
    }
  });

  // Admin reconciliation endpoint (read-only summary; requires admin)
  app.get('/api/admin/reconciliation', requireAdminAuth, async (req, res) => {
    try {
      const { getRaceMint, serverKeypair, treasuryPubkey, jackpotPubkey, getSplTokenBalance } = await import('./solana');
      const { Decimal } = await import('decimal.js');
      const decimals = 9;
      const format = (v: bigint) => new Decimal(v.toString()).div(new Decimal(10).pow(decimals)).toString();

      // Ledger aggregates
      const ledger = await getDb()?.getLedgerAggregates();

      // On-chain balances
      let escrow = '0', treasuryBal = '0', jackpotBal = '0';
      try {
        const mint = await getRaceMint();
        const escrowOwner = serverKeypair.publicKey;
        const treasuryOwner = treasuryPubkey || serverKeypair.publicKey;
        const jackpotOwner = jackpotPubkey || serverKeypair.publicKey;
        const [eb, tb, jb] = await Promise.all([
          getSplTokenBalance(mint, escrowOwner),
          getSplTokenBalance(mint, treasuryOwner),
          getSplTokenBalance(mint, jackpotOwner)
        ]);
        escrow = format(eb); treasuryBal = format(tb); jackpotBal = format(jb);
      } catch {}

      res.json({
        ledger,
        onchain: { escrow, treasury: treasuryBal, jackpot: jackpotBal }
      });
    } catch (error) {
      console.error('Reconciliation error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Per-race flow audit: compute expected vs actual flows including rake split, payouts, jackpot, referrals
  app.get('/api/admin/race/:raceId/audit', requireAdminAuth, async (req, res) => {
    try {
      const raceId = String(req.params.raceId);
      const race = await getDb()?.getRace(raceId);
      if (!race) return res.status(404).json({ error: 'Race not found' });

      const { calculateSettlement } = await import('./settlement');
      const DecimalLib = await import('decimal.js');
      const Decimal = DecimalLib.default;

      // Collect all bets and transfers
      const allBets = (await getDb()?.getBetsForRace(raceId) || []) as Array<any>;
      const transfers = (await getDb()?.getSettlementTransfers(raceId) || []) as Array<any>;

      // Helper to compute numbers for a currency
      const auditForCurrency = async (currency: 'RACE' | 'SOL') => {
        const bets = allBets.filter(b => (String(b?.currency || 'RACE').toUpperCase()) === currency);
        const totals = bets.reduce((sum, b) => sum.add(new Decimal(String(b.amount || '0'))), new Decimal(0));
        const raceForCurrency = currency === 'SOL' ? { ...race, rakeBps: 500 } as any : race as any;
        const opts = currency === 'SOL' ? { treasuryRatio: 0.6, jackpotRatio: 0.4 } : undefined;
        const settlement = await calculateSettlement(bets as any, raceForCurrency as any, opts as any);

        const actualRake = transfers
          .filter(t => t.transferType === 'RAKE' && (String(t?.currency || 'RACE').toUpperCase()) === currency)
          .reduce((s, t) => s.add(new Decimal(String(t.amount || '0'))), new Decimal(0));
        const actualPayouts = transfers
          .filter(t => t.transferType === 'PAYOUT' && (String(t?.currency || 'RACE').toUpperCase()) === currency)
          .reduce((s, t) => s.add(new Decimal(String(t.amount || '0'))), new Decimal(0));
        const jackpotPush = transfers
          .filter(t => t.transferType === 'JACKPOT' && t.toWallet === 'jackpot' && (String(t?.currency || 'RACE').toUpperCase()) === currency)
          .reduce((s, t) => s.add(new Decimal(String(t.amount || '0'))), new Decimal(0));
        const jackpotPull = transfers
          .filter(t => t.transferType === 'JACKPOT' && t.toWallet === 'escrow' && (String(t?.currency || 'RACE').toUpperCase()) === currency)
          .reduce((s, t) => s.add(new Decimal(String(t.amount || '0'))), new Decimal(0));

        const referrals = await getDb()?.getReferralRewardSumsForRace(raceId);
        const refPaid = new Decimal(String(referrals[currency].paid || '0'));
        const refPending = new Decimal(String(referrals[currency].pending || '0'));

        // Expected values
        const expectedRake = settlement.treasuryRake;
        const expectedJackpotContribution = settlement.jackpotContribution;
        const expectedJackpotPayout = settlement.jackpotPayout;
        const expectedPrizePool = settlement.prizePool;

        // Escrow delta approximation: starting from total bets + jackpot pull - payouts - rake - jackpot push - paid referrals
        const escrowDelta = totals
          .add(jackpotPull)
          .sub(actualPayouts)
          .sub(actualRake)
          .sub(jackpotPush)
          .sub(refPaid);

        return {
          totals: totals.toString(),
          expected: {
            rake: expectedRake.toString(),
            jackpotContribution: expectedJackpotContribution.toString(),
            jackpotPayout: expectedJackpotPayout.toString(),
            prizePool: expectedPrizePool.toString()
          },
          actual: {
            rake: actualRake.toString(),
            payouts: actualPayouts.toString(),
            jackpotPush: jackpotPush.toString(),
            jackpotPull: jackpotPull.toString(),
            referrals: { paid: refPaid.toString(), pending: refPending.toString() }
          },
          escrowDelta: escrowDelta.toString(),
          currency
        };
      };

      const raceAudit = await auditForCurrency('RACE');
      const solAudit = await auditForCurrency('SOL');

      res.json({ raceId, status: race.status, rakeBps: race.rakeBps, jackpotFlag: race.jackpotFlag, RACE: raceAudit, SOL: solAudit, ts: Date.now() });
    } catch (error) {
      console.error('Race audit error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Global leaderboard endpoint (supports currency=SOL for native SOL leaderboard)
  app.get('/api/leaderboard', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, parseInt((req.query.limit as string) || '25')));
      const wallet = (req.query.wallet as string) || '';
      const currency = ((req.query.currency as string) || '').toUpperCase();

      if (currency === 'SOL') {
        // SOL leaderboard: aggregate from user_race_results joined with bets for currency filtering
        if (!pgPool) {
          return res.json({ top: [], you: undefined, rank: null });
        }
        
        try {
          // Get top N wallets by edge points for SOL bets only
          // Win/loss calculated per race: win if payout >= wagered (break-even or profit)
          const topQuery = await pgPool.query(`
            WITH race_outcomes AS (
              SELECT 
                urr.wallet,
                urr.race_id,
                SUM(urr.bet_amount) as race_wagered,
                SUM(urr.payout_amount) as race_payout,
                SUM(urr.edge_points) as race_edge_points,
                MAX(urr.ts) as race_ts
              FROM user_race_results urr
              INNER JOIN bets b ON urr.wallet = b.wallet AND urr.race_id = b.race_id
              WHERE b.currency = 'SOL'
              GROUP BY urr.wallet, urr.race_id
            )
            SELECT 
              wallet,
              COUNT(*)::int as total_races,
              SUM(CASE WHEN race_payout >= race_wagered THEN 1 ELSE 0 END)::int as wins,
              SUM(CASE WHEN race_payout < race_wagered THEN 1 ELSE 0 END)::int as losses,
              SUM(race_wagered)::text as total_wagered,
              SUM(race_payout)::text as total_awarded,
              SUM(race_edge_points)::text as edge_points,
              MAX(race_ts) as last_updated
            FROM race_outcomes
            GROUP BY wallet
            ORDER BY SUM(race_edge_points) DESC, wins DESC
            LIMIT $1
          `, [limit]);

          const top = topQuery.rows.map((r: any) => ({
            wallet: String(r.wallet),
            totalRaces: Number(r.total_races) || 0,
            wins: Number(r.wins) || 0,
            losses: Number(r.losses) || 0,
            totalWagered: String(r.total_wagered ?? '0'),
            totalAwarded: String(r.total_awarded ?? '0'),
            edgePoints: String(r.edge_points ?? '0'),
            lastUpdated: Number(r.last_updated) || 0
          }));

          let you: any = undefined;
          let rank: number | null = null;
          
          if (wallet) {
            const youQuery = await pgPool.query(`
              WITH race_outcomes AS (
                SELECT 
                  urr.wallet,
                  urr.race_id,
                  SUM(urr.bet_amount) as race_wagered,
                  SUM(urr.payout_amount) as race_payout,
                  SUM(urr.edge_points) as race_edge_points,
                  MAX(urr.ts) as race_ts
                FROM user_race_results urr
                INNER JOIN bets b ON urr.wallet = b.wallet AND urr.race_id = b.race_id
                WHERE b.currency = 'SOL' AND urr.wallet = $1
                GROUP BY urr.wallet, urr.race_id
              )
              SELECT 
                wallet,
                COUNT(*)::int as total_races,
                SUM(CASE WHEN race_payout >= race_wagered THEN 1 ELSE 0 END)::int as wins,
                SUM(CASE WHEN race_payout < race_wagered THEN 1 ELSE 0 END)::int as losses,
                SUM(race_wagered)::text as total_wagered,
                SUM(race_payout)::text as total_awarded,
                SUM(race_edge_points)::text as edge_points,
                MAX(race_ts) as last_updated
              FROM race_outcomes
              GROUP BY wallet
            `, [wallet]);

            if (youQuery.rows.length > 0) {
              const r = youQuery.rows[0];
              you = {
                wallet: String(r.wallet),
                totalRaces: Number(r.total_races) || 0,
                wins: Number(r.wins) || 0,
                losses: Number(r.losses) || 0,
                totalWagered: String(r.total_wagered ?? '0'),
                totalAwarded: String(r.total_awarded ?? '0'),
                edgePoints: String(r.edge_points ?? '0'),
                lastUpdated: Number(r.last_updated) || 0
              };

              // Get rank
              const rankQuery = await pgPool.query(`
                WITH wallet_ranks AS (
                  SELECT 
                    urr.wallet,
                    SUM(urr.edge_points) as ep,
                    SUM(CASE WHEN urr.win THEN 1 ELSE 0 END) as w
                  FROM user_race_results urr
                  INNER JOIN bets b ON urr.wallet = b.wallet AND urr.race_id = b.race_id
                  WHERE b.currency = 'SOL'
                  GROUP BY urr.wallet
                )
                SELECT COUNT(*)::int + 1 as rank
                FROM wallet_ranks
                WHERE ep > (SELECT ep FROM wallet_ranks WHERE wallet = $1)
                  OR (ep = (SELECT ep FROM wallet_ranks WHERE wallet = $1) AND w > (SELECT w FROM wallet_ranks WHERE wallet = $1))
              `, [wallet]);
              
              rank = rankQuery.rows[0]?.rank || null;
            }
          }

          return res.json({ top, you, rank });
        } catch (error) {
          console.error('SOL leaderboard error:', error);
          return res.json({ top: [], you: undefined, rank: null });
        }
      }

      // Ensure consistency: if stats are behind results, rebuild in-line (cheap) or fallback for response
      const statsSummary = await getDb()?.getUserStatsSummary();
      const resultsSummary = await getDb()?.getUserRaceResultsSummary();

      const statsBehind =
        statsSummary.walletCount === 0 ||
        (resultsSummary.walletCount > statsSummary.walletCount) ||
        (resultsSummary.lastUpdated > statsSummary.lastUpdated);

      let top = await getDb()?.getLeaderboard(limit);
      let you = wallet ? await getDb()?.getUserStats(wallet) : undefined;
      let rank = wallet ? await getDb()?.getUserRank(wallet) : null;

      // CRITICAL FIX: Always check Postgres if SQLite is empty or behind
      if (usePgForReceipts || statsBehind || !top || top.length === 0) {
        // Prefer Postgres-backed results when flag enabled or when SQLite is behind
        console.log(`🔍 SQLite leaderboard empty or behind (stats=${statsSummary.walletCount}, results=${resultsSummary.walletCount}), checking Postgres...`);
        const pgTop = await getDb()?.getLeaderboardFromPostgres(limit);
        if (pgTop && pgTop.length > 0) {
          top = pgTop as any;
          console.log(`✅ Loaded ${pgTop.length} leaderboard entries from Postgres`);
          
          // Hydrate top leaderboard entries into SQLite for future requests (skip in Postgres-only mode)
          if (false && pgPool && (statsSummary.walletCount === 0 || statsBehind)) {
            try {
              console.log(`🔄 Hydrating ${pgTop.length} top leaderboard entries into SQLite...`);
              for (const entry of pgTop) {
                try {
                  // Hydrate the user_race_results first if needed
                  const pgResults = await pgPool.query(
                    `SELECT race_id, bet_amount, payout_amount, win, edge_points, ts 
                     FROM user_race_results 
                     WHERE wallet = $1`,
                    [entry.wallet]
                  );
                  for (const row of pgResults.rows) {
                    await getDb()?.upsertUserRaceResult({
                      wallet: entry.wallet,
                      raceId: String(row.race_id),
                      betAmount: String(row.bet_amount || '0'),
                      payoutAmount: String(row.payout_amount || '0'),
                      win: Boolean(row.win),
                      edgePoints: String(row.edge_points || '0'),
                      ts: Number(row.ts) || Date.now()
                    });
                  }
                  // Then recalc stats
                  await getDb()?.recalcUserStats(entry.wallet);
                } catch (e) {
                  console.warn(`⚠️ Failed to hydrate stats for ${entry.wallet.slice(0, 8)}:`, e);
                }
              }
              await getDb()?.checkpoint();
              console.log(`✅ Hydrated ${pgTop.length} leaderboard entries into SQLite`);
            } catch (e) {
              console.error('❌ Failed to hydrate leaderboard into SQLite:', e);
            }
          }
          
          if (wallet && (!you || you.totalRaces === undefined)) {
            you = await getDb()?.getUserStatsFromPostgres(wallet) as any;
          }
          if (wallet && (rank === null)) {
            rank = await getDb()?.getUserRankFromPostgres(wallet);
          }
        } else {
          // Fallback to direct aggregation from SQLite results
          console.log('⚠️ Postgres leaderboard empty, falling back to SQLite aggregate');
          top = getDb()?.getLeaderboardFromResults(limit);
          if (wallet && (!you || you.totalRaces === undefined)) {
            you = getDb()?.getUserStatsFromResults(wallet);
          }
          if (wallet && (rank === null)) {
            rank = getDb()?.getUserRankFromResults(wallet);
          }
        }
      } else {
        console.log(`ℹ️  Serving leaderboard from SQLite (${top.length} entries)`);
      }

      res.json({ top, you, rank });
    } catch (error) {
      console.error('Leaderboard error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Emergency cleanup endpoint (now requires admin auth)
  app.post("/api/emergency/clear-races", requireAdminAuth, async (req, res) => {
    try {
      console.log("🚨 EMERGENCY: Clearing all races and starting fresh...");
      
      // Import required modules
      const { RaceTimer } = await import('./race-timer');
      const { clearStuckRace } = await import('./sse');
      
      // Get all races before clearing
      const allRaces = await getDb()?.getRaces();
      
      // Stop the race timer system
      await RaceTimer.stop();
      
      // Clear in-memory state for all races
      for (const race of allRaces) {
        await clearStuckRace(race.id);
        RaceTimer.clearRaceTimer(race.id);
      }
      
      // Clear all races and bets from database
      await getDb()?.clearRaces();
      
      // Clear any token cache to ensure fresh data
      const { clearTokenCache } = await import('./runners');
      clearTokenCache();
      
      // Restart the race timer system
      RaceTimer.start();
      
      // Force restart race system with fresh data
      const { initializeRaces } = await import('./sse');
      await initializeRaces();
      
      console.log("✅ EMERGENCY: Successfully cleared races and restarted system");
      res.json({ success: true, message: "All races cleared and system restarted" });
    } catch (error) {
      console.error("❌ EMERGENCY: Failed to clear races:", error);
      res.status(500).json({ error: "Failed to clear races" });
    }
  });

  // Jupiter API proxy endpoints for V2 raceswap
  app.get("/api/jupiter/quote", async (req, res) => {
    try {
      const { inputMint, outputMint, amount, slippageBps = '50', platformFeeBps } = req.query;
      
      if (!inputMint || !outputMint || !amount) {
        return res.status(400).json({ error: 'Missing required parameters: inputMint, outputMint, amount' });
      }

      // Try multiple endpoints (Replit blocks some Jupiter domains)
      let queryParams = `inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
      if (platformFeeBps) {
        queryParams += `&platformFeeBps=${platformFeeBps}`;
      }

      const endpoints = [
        `https://lite-api.jup.ag/swap/v1/quote?${queryParams}`,
        `https://api.jup.ag/swap/v1/quote?${queryParams}`
      ];
      
      let response, data;
      for (const url of endpoints) {
        try {
          response = await fetch(url);
          data = await response.json();
          if (response.ok && data && !data.error) {
            break; // Success!
          }
        } catch (err) {
          console.log(`Failed endpoint: ${url}`);
          continue; // Try next endpoint
        }
      }
      
      if (!response) {
        return res.status(503).json({ error: 'Failed to reach Jupiter quote API' });
      }
      
      if (!response.ok) {
        return res.status(response.status).json(data);
      }
      
      res.json(data);
    } catch (error: any) {
      console.error('[api/jupiter/quote] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to get Jupiter quote' });
    }
  });

  app.post("/api/jupiter/swap-instructions", async (req, res) => {
    try {
      const { quoteResponse, userPublicKey, wrapAndUnwrapSol = true, useSharedAccounts = true, feeAccount } = req.body;
      
      if (!quoteResponse || !userPublicKey) {
        return res.status(400).json({ error: 'Missing required parameters: quoteResponse, userPublicKey' });
      }

      // Try multiple endpoints (Replit blocks some Jupiter domains)
      const endpoints = [
        'https://lite-api.jup.ag/swap/v1/swap-instructions',
        'https://api.jup.ag/swap/v1/swap-instructions'
      ];
      
      let response, data;
      for (const url of endpoints) {
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              quoteResponse,
              userPublicKey,
              wrapAndUnwrapSol,
              useSharedAccounts,
              feeAccount,
              dynamicComputeUnitLimit: true,
              prioritizationFeeLamports: 'auto',
            }),
          });
          data = await response.json();
          if (response.ok && data && !data.error) {
            break; // Success!
          }
        } catch (err) {
          console.log(`Failed endpoint: ${url}`);
          continue; // Try next endpoint
        }
      }
      
      if (!response) {
        return res.status(503).json({ error: 'Failed to reach Jupiter swap API' });
      }
      
      if (!response.ok) {
        return res.status(response.status).json(data);
      }
      
      res.json(data);
    } catch (error: any) {
      console.error('[api/jupiter/swap-instructions] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to get Jupiter swap instructions' });
    }
  });

  // Server is created and managed by the caller
}

export async function initializeApp() {
  try {
    console.log("Initializing Pump Racers application...");
    
    console.log("📊 Step A: Getting treasury state...");
    // Get current treasury state with timeout and fallback
    let treasury: any;
    try {
      const treasuryPromise = getDb()?.getTreasury();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Treasury query timeout after 5s')), 5000)
      );
      treasury = await Promise.race([treasuryPromise, timeoutPromise]) as any;
      console.log("✅ Step A complete: Treasury loaded from database");
    } catch (dbError) {
      console.warn("⚠️ Treasury query failed, using default state:", dbError);
      // Fallback to default treasury (app can run without DB)
      treasury = {
        jackpotBalance: '0',
        jackpotBalanceSol: '0',
        raceMint: null,
        maintenanceMode: false,
        maintenanceMessage: null,
        maintenanceAnchorRaceId: null
      };
      console.log("✅ Step A complete: Using default treasury (database unavailable)");
    }
    
    console.log("🪙 Step B: Ensuring RACE mint exists...");
    // Ensure RACE mint exists
    const { mint, updated } = await ensureRaceMintExists(treasury);
    console.log("✅ Step B complete: RACE mint verified");
    
    if (updated) {
      console.log("📝 Updating treasury with new RACE mint...");
      // Update treasury with new mint address
      await getDb()?.updateTreasury({
        ...treasury,
        raceMint: mint.toString()
      });
      console.log("Updated treasury with new RACE mint");
    }

    console.log("⏱️ Step C: Starting countdown updater...");
    // Start automatic race timing system ASAP and seed races
    const { startCountdownUpdater, initializeRaces } = await import('./sse');
    startCountdownUpdater();
    console.log("⏰ Automatic race timing system started");
    
    console.log("🏁 Step D: Initializing races...");
    await initializeRaces();
    console.log("✅ Step D complete: Races initialized");

    console.log("🔧 Step E: Improving race phase system...");
    // Initialize improved phase system
    const { improveRacePhaseSystem } = await import('./race-phase-improvements');
    await improveRacePhaseSystem();
    console.log("✅ Step E complete: Race phase system improved");

    // Start bet reconciler to backfill bets when client confirmation races occur
    try {
      const { startBetReconciler, oneOffBootRescanBets } = await import('./reconcile');
      // Kick off a light boot rescan (non-blocking)
      oneOffBootRescanBets(300).catch(() => {});
      // Then keep reconciling periodically
      startBetReconciler(30000);
      console.log('🔄 Bet reconciler started');
    } catch (e) {
      console.warn('⚠️ Failed to start bet reconciler:', e);
    }

    console.log("Application initialization complete");
    console.log("Server ready to accept connections");
    
  } catch (error) {
    console.error("Failed to initialize application:", error);
    throw error;
  }
}
