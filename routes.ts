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
import { computePnlFromCashflows, sumSolReceivedFromTradeEvents, sumSolReceivedFromTradeEventsWithCount } from "./escrow-trader/pnl";
import {
  buildRaceswapPlan,
  getReflectionTokenMeta,
  getRaceswapPublicConfig,
  RaceswapPlanError,
} from "./raceswap";
import { getFallbackRaceswapTokens, getRaceswapTokenList } from "./raceswap-tokens";
import { getReferralFeeBps, REFERRAL_FEE_MIN_BPS, REFERRAL_FEE_MAX_BPS } from "./jupiter";
import NodeCache from "node-cache";

const RACEPUMP_PUBLIC_BASE = (process.env.RACEPUMP_PUBLIC_BASE || "https://racepump.fun").replace(/\/$/, "");

// Cache for remote recent winners fetch to prevent repeated abort errors
// Cache failed attempts for 30 seconds to avoid spamming
const remoteRecentWinnersCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

// Cache for Jupiter quotes to reduce API calls
// Increased to 30 seconds to prevent rate limiting - quotes are approximate anyway
const jupiterQuoteCache = new NodeCache({ stdTTL: 30, checkperiod: 60 }); // 30 second cache

// Cache for races list to reduce database load (active races change rarely)
const racesCache = new NodeCache({ stdTTL: 3, checkperiod: 5 }); // 3 second cache for active races

// Cache for user receipts to reduce expensive settlement calculations
const receiptsCache = new NodeCache({ stdTTL: 10, checkperiod: 15 }); // 10 second cache for receipts

// Jupiter Ultra API authentication
// According to Jupiter docs: https://dev.jup.ag/docs/ultra/get-started
// Ultra API uses x-api-key header (not Authorization Bearer)
const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || process.env.JUPITER_AUTH_TOKEN?.trim();
const JUPITER_REFERRAL_ACCOUNT = process.env.JUPITER_REFERRAL_ACCOUNT?.trim();
const JUPITER_REFERRAL_FEE = getReferralFeeBps();
let loggedMissingJupiterKey = false;
let loggedApiKeyStatus = false;

if (JUPITER_REFERRAL_ACCOUNT && JUPITER_REFERRAL_FEE === undefined) {
  console.warn(
    `[raceswap] JUPITER_REFERRAL_FEE is not configured. Jupiter Ultra requires fees between ${REFERRAL_FEE_MIN_BPS}-${REFERRAL_FEE_MAX_BPS} bps. Referral collection is disabled.`
  );
}

function logMissingApiKeyOnce() {
  if (!JUPITER_API_KEY && !loggedMissingJupiterKey) {
    console.warn("[raceswap] Jupiter Ultra API requires JUPITER_API_KEY - set in Replit secrets to enable");
    loggedMissingJupiterKey = true;
  }
}

function logApiKeyStatusOnce() {
  if (!loggedApiKeyStatus) {
    if (JUPITER_API_KEY) {
      console.log(`[raceswap] ✅ Jupiter API key loaded (${JUPITER_API_KEY.substring(0, 8)}...)`);
    } else {
      console.warn(`[raceswap] ⚠️ Jupiter API key NOT found in environment`);
    }
    loggedApiKeyStatus = true;
  }
}

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

  // Metadata JSON proxy (same-origin) to bypass CORS on arweave/ipfs gateways.
  // Used by the on-chain Pokemon card rail to reliably read `description`/`attributes`.
  app.get("/api/metadata-proxy", async (req: Request, res: Response) => {
    try {
      const urlParam = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
      if (!urlParam || typeof urlParam !== "string") {
        return res.status(400).json({ error: "url query parameter is required" });
      }

      let target: URL;
      try {
        target = new URL(urlParam);
      } catch {
        return res.status(400).json({ error: "Invalid url" });
      }

      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return res.status(400).json({ error: "Only http/https URLs are allowed" });
      }

      // Basic SSRF guard: allowlist known metadata gateways.
      const host = target.hostname.toLowerCase();
      const allowedHosts = new Set<string>([
        "arweave.net",
        "www.arweave.net",
        "ipfs.io",
        "cloudflare-ipfs.com",
        "gateway.pinata.cloud",
      ]);
      if (!allowedHosts.has(host)) {
        return res.status(400).json({ error: "Host not allowed" });
      }

      const upstream = await fetch(target.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });

      const body = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Cache-Control", "public, max-age=300"); // 5 minutes
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
      return res.send(body);
    } catch (error: any) {
      console.error("[metadata-proxy] error:", error);
      return res.status(502).json({ error: "Failed to fetch metadata" });
    }
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

  // Escrow Trader admin endpoints
  app.get("/api/admin/escrow/positions", requireAdminAuth, async (req, res) => {
    try {
      const db = getDb();
      const statusRaw = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
      const bucketRaw = Array.isArray(req.query.bucket) ? req.query.bucket[0] : req.query.bucket;
      const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const status = String(statusRaw || "OPEN").toUpperCase();
      const bucket = bucketRaw ? String(bucketRaw || "").toUpperCase() : null;
      const limit = Math.min(Math.max(Number(limitRaw || 50), 1), 500);
      const rows = await Promise.resolve(db?.listEscrowPositions?.(limit, status));
      const positions = Array.isArray(rows) ? rows : [];
      res.json({
        positions: bucket ? positions.filter((p: any) => String(p.bucket ?? "CORE").toUpperCase() === bucket) : positions,
      });
    } catch (e: any) {
      console.error("[admin/escrow/positions] error:", e);
      res.status(500).json({ error: e?.message || "Failed to load escrow positions" });
    }
  });

  app.get("/api/admin/escrow/summary", requireAdminAuth, async (_req, res) => {
    try {
      const db = getDb();
      const rows = await Promise.resolve(db?.getOpenEscrowPositions?.());
      const active = Array.isArray(rows) ? rows : [];

      const normStatus = (p: any) => String(p.status ?? "").toUpperCase();
      const normBucket = (p: any) => (String(p.bucket ?? "CORE").toUpperCase() === "RUNNER" ? "RUNNER" : "CORE");

      const parseQty = (v: any): bigint => {
        const s = String(v ?? "").trim();
        if (!s || !/^\d+$/.test(s)) return 0n;
        try { return BigInt(s); } catch { return 0n; }
      };
      const estimateExposureSol = (p: any): number => {
        const notional = Number(p.notional_sol ?? p.notionalSol ?? 0);
        if (!Number.isFinite(notional) || notional <= 0) return 0;
        const entryQty = parseQty(p.entry_qty_tokens_base ?? p.entryQtyTokensBase ?? p.qty_tokens_base ?? p.qtyTokensBase);
        const remainingQty = parseQty(p.remaining_qty_tokens_base ?? p.remainingQtyTokensBase ?? p.qty_tokens_base ?? p.qtyTokensBase);
        if (entryQty <= 0n) return notional;
        const ratio = Number(remainingQty) / Number(entryQty);
        if (!Number.isFinite(ratio) || ratio <= 0) return 0;
        return notional * Math.min(1, Math.max(0, ratio));
      };

      const openCore = active.filter((p: any) => normStatus(p) === "OPEN" && normBucket(p) === "CORE");
      const openRunner = active.filter((p: any) => normStatus(p) === "OPEN" && normBucket(p) === "RUNNER");
      const stuckCore = active.filter((p: any) => normStatus(p) === "STUCK" && normBucket(p) === "CORE");
      const stuckRunner = active.filter((p: any) => normStatus(p) === "STUCK" && normBucket(p) === "RUNNER");

      const runnerExposureSol = active
        .filter((p: any) => (normStatus(p) === "OPEN" || normStatus(p) === "STUCK") && normBucket(p) === "RUNNER")
        .reduce((sum: number, p: any) => sum + estimateExposureSol(p), 0);

      res.json({
        open: { core: openCore.length, runner: openRunner.length },
        stuck: { core: stuckCore.length, runner: stuckRunner.length },
        runnerExposureSol,
      });
    } catch (e: any) {
      console.error("[admin/escrow/summary] error:", e);
      res.status(500).json({ error: e?.message || "Failed to load escrow summary" });
    }
  });

  app.get("/api/admin/escrow/signals", requireAdminAuth, async (req, res) => {
    try {
      const db = getDb();
      const statusRaw = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
      const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const status = statusRaw ? String(statusRaw).toUpperCase() : undefined;
      const limit = Math.min(Math.max(Number(limitRaw || 100), 1), 500);
      const rows = await Promise.resolve(db?.listEscrowSignals?.(limit, status));
      res.json({ signals: Array.isArray(rows) ? rows : [] });
    } catch (e: any) {
      console.error("[admin/escrow/signals] error:", e);
      res.status(500).json({ error: e?.message || "Failed to load escrow signals" });
    }
  });

  app.get("/api/admin/escrow/events", requireAdminAuth, async (req, res) => {
    try {
      const db = getDb();
      const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const limit = Math.min(Math.max(Number(limitRaw || 200), 1), 1000);
      const rows = await Promise.resolve(db?.listEscrowTradeEvents?.(limit));
      res.json({ events: Array.isArray(rows) ? rows : [] });
    } catch (e: any) {
      console.error("[admin/escrow/events] error:", e);
      res.status(500).json({ error: e?.message || "Failed to load escrow trade events" });
    }
  });

  // Alon Bot status endpoint - check if bot is enabled
  app.get("/api/alon-bot/status", async (req, res) => {
    try {
      const enabled = process.env.ALON_BOT_ENABLED !== "false";
      res.json({ 
        enabled,
        status: enabled ? "online" : "offline",
        message: enabled 
          ? "Alon BOT is online and trading" 
          : "Alon BOT is currently offline in deep learning mode. We're training new models to improve trading performance. Check back soon!"
      });
    } catch (e: any) {
      console.error("[alon-bot/status] error:", e);
      res.status(500).json({ error: e?.message || "Failed to get bot status" });
    }
  });

  // Copy Trade dashboard (open to everyone)
  app.get("/api/copy-trade/dashboard", async (req, res) => {
    try {
      const wallet = String((req.query as any)?.wallet || "").trim();
      if (!wallet) return res.status(400).json({ error: "wallet is required" });

      // Still returned in the response for UI display (even though access is now open)
      const requiredRaceUi = 1_000_000;

      const { connection, raceMintAddress, serverKeypair } = await import("./solana");
      const { getVerifiedHolderBoost } = await import("./raceswap-swap-rewards");
      const { getEscrowTraderConfig } = await import("./escrow-trader");
      const { scoreAndRankEscrowSignals, parseEscrowSignalFeatures } = await import("./escrow-trader/selection");
      const { getUniverseCandidates } = await import("./escrow-trader/universe");
      const { EscrowTraderService } = await import("./escrow-trader/service");
      const db = getDb();

      const holderBoost = await getVerifiedHolderBoost({ connection, recipient: wallet, raceMintAddress });

      const escrowPubkey = serverKeypair.publicKey.toString();

      const cfg = getEscrowTraderConfig();
      const now = Date.now();

      const parseQtyBase = (v: any): bigint => {
        const s = String(v ?? "").trim();
        if (!s) return BigInt(0);
        if (!/^\d+$/.test(s)) return BigInt(0);
        try {
          return BigInt(s);
        } catch {
          return BigInt(0);
        }
      };

      const parseJsonMaybe = (v: any): any => {
        if (!v) return null;
        if (typeof v === "string") {
          try {
            return JSON.parse(v);
          } catch {
            return null;
          }
        }
        if (typeof v === "object") return v;
        return null;
      };

      // Recent positions (OPEN/STUCK + CLOSED) for trade history + TP status.
      // For barbell/runner positions, we compute a live P/L estimate even while OPEN:
      // realized (TP1) + unrealized (runner). This prevents waiting for full close.
      const tp1FillByPositionId = new Map<number, { avgPriceSolPerToken: number | null; soldQtyTokensBase: bigint | null }>();
      let escrowEvents: any[] = [];
      try {
        const eventsRaw = await Promise.resolve(db?.listEscrowTradeEvents?.(1000));
        escrowEvents = Array.isArray(eventsRaw) ? eventsRaw : [];
        for (const e of escrowEvents) {
          const type = String(e?.type ?? "").toUpperCase();
          if (type !== "TP1_EXIT") continue;
          const positionId = Number(e?.position_id ?? e?.positionId ?? e?.position_id_int ?? e?.positionIdInt ?? NaN);
          if (!Number.isFinite(positionId)) continue;
          if (tp1FillByPositionId.has(positionId)) continue; // newest-first list
          const payload =
            parseJsonMaybe(e?.payload_json ?? e?.payloadJson ?? e?.payload) ??
            parseJsonMaybe((e as any)?.payload) ??
            null;
          const avg = Number(payload?.avgPriceSolPerToken ?? payload?.avg_price_sol_per_token ?? payload?.avg_price ?? NaN);
          const soldQty = parseQtyBase(payload?.soldQtyTokensBase ?? payload?.sold_qty_tokens_base ?? payload?.soldQty ?? payload?.sold_qty ?? null);
          tp1FillByPositionId.set(positionId, {
            avgPriceSolPerToken: Number.isFinite(avg) && avg > 0 ? avg : null,
            soldQtyTokensBase: soldQty > BigInt(0) ? soldQty : null,
          });
        }
      } catch {
        // Non-fatal: we can still compute mark-to-market P/L without TP1 avg fill price.
      }

      const normalizePos = async (p: any) => {
        const id = Number(p?.id);
        const status = String(p?.status || "OPEN").toUpperCase();
        const entryPrice = Number(p?.entry_price ?? p?.entryPrice ?? 0);
        const lastPrice = Number(p?.last_price ?? p?.lastPrice ?? 0);
        const notionalSol = Number(p?.notional_sol ?? p?.notionalSol ?? 0);

        const entryQtyBase = parseQtyBase(p?.entry_qty_tokens_base ?? p?.entryQtyTokensBase ?? p?.qty_tokens_base ?? p?.qtyTokensBase ?? "0");
        const remainingQtyBase = parseQtyBase(p?.remaining_qty_tokens_base ?? p?.remainingQtyTokensBase ?? p?.qty_tokens_base ?? p?.qtyTokensBase ?? "0");
        const exitedQtyBase = parseQtyBase(p?.exited_qty_tokens_base ?? p?.exitedQtyTokensBase ?? "0");

        const rawPnlSol = p?.pnl_sol ?? p?.pnlSol ?? null;
        const rawPnlPct = p?.pnl_pct ?? p?.pnlPct ?? null;

        // If a position is already CLOSED, prefer cashflow-based P/L for barbell positions.
        // This fixes historical rows where pnlPct/pnlSol were incorrectly set from the final exit return only.
        let closedPnlSol: number | null = rawPnlSol;
        let closedPnlPct: number | null = rawPnlPct;
        const tpMode = String(p?.tpMode ?? p?.tp_mode ?? "single").toLowerCase() === "barbell" ? "barbell" : "single";
        if (status === "CLOSED" && tpMode === "barbell" && Number.isFinite(notionalSol) && notionalSol > 0 && Number.isFinite(id)) {
          let posEvents: any[] = [];
          try {
            const fromDb = await Promise.resolve(db?.listEscrowTradeEventsForPosition?.(id, 500));
            posEvents = Array.isArray(fromDb) ? fromDb : [];
          } catch {
            posEvents = [];
          }
          if (posEvents.length === 0 && escrowEvents.length > 0) {
            posEvents = escrowEvents.filter((e: any) => Number(e?.position_id ?? e?.positionId ?? NaN) === id);
          }
          // IMPORTANT:
          // Only override persisted P/L when we have *actual* cashflow events.
          // If there are zero `solReceived` events (common for TTL/STALE closures with no exit swap),
          // treating proceeds as 0 incorrectly displays -100%.
          const { sumSol: proceedsSol, count } = sumSolReceivedFromTradeEventsWithCount(posEvents);
          if (count > 0) {
            const { pnlSol, pnlPct } = computePnlFromCashflows(notionalSol, proceedsSol);
            if (pnlSol !== null && pnlPct !== null) {
              closedPnlSol = pnlSol;
              closedPnlPct = pnlPct;
            }
          }
        }

        // Final fallback for CLOSED rows: never show blank P/L.
        // If we couldn't compute cashflow P/L and the stored pnl_* is missing, estimate from price.
        if (status === "CLOSED" && (closedPnlSol === null || closedPnlPct === null)) {
          const exitPrice = Number(p?.exit_price ?? p?.exitPrice ?? 0);
          const closePrice = Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : lastPrice;
          if (
            Number.isFinite(entryPrice) && entryPrice > 0 &&
            Number.isFinite(closePrice) && closePrice > 0 &&
            Number.isFinite(notionalSol) && notionalSol > 0
          ) {
            const estPct = (closePrice - entryPrice) / entryPrice;
            closedPnlPct = Number.isFinite(estPct) ? estPct : closedPnlPct;
            closedPnlSol = Number.isFinite(estPct) ? notionalSol * estPct : closedPnlSol;
          } else if (Number.isFinite(notionalSol) && notionalSol > 0 && closedPnlSol === null && closedPnlPct === null) {
            // If we truly have no usable data, treat as flat instead of rendering "—".
            closedPnlSol = 0;
            closedPnlPct = 0;
          }
        }

        let livePnlPct: number | null = null;
        let livePnlSol: number | null = null;
        if (status !== "CLOSED") {
          if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(lastPrice) && lastPrice > 0 && Number.isFinite(notionalSol) && notionalSol > 0) {
            const curRet = (lastPrice - entryPrice) / entryPrice;
            const safeFrac = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
            const soldFrac = entryQtyBase > BigInt(0) ? safeFrac(new Decimal(exitedQtyBase.toString()).div(entryQtyBase.toString()).toNumber()) : 0;
            const remFrac = entryQtyBase > BigInt(0) ? safeFrac(new Decimal(remainingQtyBase.toString()).div(entryQtyBase.toString()).toNumber()) : 1;

            const tp1 = Number.isFinite(id) ? tp1FillByPositionId.get(id) : undefined;
            const tp1Ret =
              tp1?.avgPriceSolPerToken && Number.isFinite(tp1.avgPriceSolPerToken) && tp1.avgPriceSolPerToken > 0
                ? (tp1.avgPriceSolPerToken - entryPrice) / entryPrice
                : curRet;

            const totalPct = tp1Ret * soldFrac + curRet * remFrac;
            livePnlPct = Number.isFinite(totalPct) ? totalPct : null;
            livePnlSol = livePnlPct !== null ? notionalSol * livePnlPct : null;
          }
        }

        return {
          id,
        mint: String(p?.mint || ""),
        symbol: p?.symbol ? String(p.symbol) : null,
        status,
        bucket: String(p?.bucket || "CORE").toUpperCase() === "RUNNER" ? "RUNNER" : "CORE",
        tpMode,
        entryTs: Number(p?.entry_ts ?? p?.entryTs ?? 0),
        entryTx: p?.entry_tx ? String(p.entry_tx) : (p?.entryTx ? String(p.entryTx) : null),
        entryPrice: (Number.isFinite(entryPrice) && entryPrice > 0) ? entryPrice : (p?.entry_price ?? p?.entryPrice ?? null),
        notionalSol: (Number.isFinite(notionalSol) && notionalSol > 0) ? notionalSol : (p?.notional_sol ?? p?.notionalSol ?? null),
        lastPrice: (Number.isFinite(lastPrice) && lastPrice > 0) ? lastPrice : (p?.last_price ?? p?.lastPrice ?? null),
        peakReturn: p?.peak_return ?? p?.peakReturn ?? null,
        tp1Filled: Boolean(p?.tp1_filled ?? p?.tp1Filled ?? false),
        tp1FillTx: p?.tp1_fill_tx ? String(p.tp1_fill_tx) : (p?.tp1FillTx ? String(p.tp1FillTx) : null),
        tp1FillTs: p?.tp1_fill_ts ?? p?.tp1FillTs ?? null,
        runnerClosed: Boolean(p?.runner_closed ?? p?.runnerClosed ?? false),
        runnerExitReason: p?.runner_exit_reason ? String(p.runner_exit_reason) : (p?.runnerExitReason ? String(p.runnerExitReason) : null),
        exitReason: p?.exit_reason ? String(p.exit_reason) : (p?.exitReason ? String(p.exitReason) : null),
        exitTs: p?.exit_ts ?? p?.exitTs ?? null,
        exitTx: p?.exit_tx ? String(p.exit_tx) : (p?.exitTx ? String(p.exitTx) : null),
        exitPrice: p?.exit_price ?? p?.exitPrice ?? null,
        pnlSol: status === "CLOSED" ? closedPnlSol : (livePnlSol ?? rawPnlSol),
        pnlPct: status === "CLOSED" ? closedPnlPct : (livePnlPct ?? rawPnlPct),
        stuckReason: p?.stuck_reason ? String(p.stuck_reason) : (p?.stuckReason ? String(p.stuckReason) : null),
      };
      };

      const openRows = (await Promise.resolve(db?.getOpenEscrowPositions?.())) || [];
      const closedRows = (await Promise.resolve(db?.listEscrowPositions?.(50, "CLOSED"))) || [];
      const rawPositions = [...(Array.isArray(openRows) ? openRows : []), ...(Array.isArray(closedRows) ? closedRows : [])];
      const normalizedPositions = (await Promise.all(rawPositions.map((p: any) => normalizePos(p)))).filter((p: any) => p && p.mint);
      const recentPositions = normalizedPositions
        .sort((a: any, b: any) => (b.entryTs || 0) - (a.entryTs || 0))
        .slice(0, 50);

      const lastEntryTs = (() => {
        const entryTs = recentPositions
          .map((p: any) => Number(p.entryTs || 0))
          .filter((n: number) => Number.isFinite(n) && n > 0)
          .sort((a: number, b: number) => b - a)[0];
        return entryTs ? entryTs : null;
      })();

      const openPositions = {
        core: recentPositions.filter((p: any) => (p.status === "OPEN" || p.status === "STUCK") && p.bucket === "CORE").length,
        runner: recentPositions.filter((p: any) => (p.status === "OPEN" || p.status === "STUCK") && p.bucket === "RUNNER").length,
        stuck: recentPositions.filter((p: any) => p.status === "STUCK").length,
      };

      const closed = recentPositions.filter((p: any) => p.status === "CLOSED");
      // P&L offset to set the starting point at +0.4477 SOL (adjusting from historical -0.4477)
      const PNL_SOL_OFFSET = 0.8954;
      const pnlSolSum = closed.reduce((sum: number, p: any) => sum + (Number(p.pnlSol) || 0), 0) + PNL_SOL_OFFSET;
      const notionalSum = closed.reduce((sum: number, p: any) => sum + (Number(p.notionalSol) || 0), 0);
      const totalPnlPct = notionalSum > 0 ? pnlSolSum / notionalSum : null;

      // Signal pool diagnostics (based on persisted signals)
      const openMintSet = new Set(
        (Array.isArray(openRows) ? openRows : [])
          .filter((p: any) => {
            const st = String(p?.status ?? "").toUpperCase();
            return st === "OPEN" || st === "STUCK";
          })
          .map((p: any) => String(p?.mint ?? "").trim())
          .filter(Boolean)
      );

      const openCoreCount = (Array.isArray(openRows) ? openRows : []).filter((p: any) => {
        const st = String(p?.status ?? "").toUpperCase();
        if (st !== "OPEN" && st !== "STUCK") return false;
        const b = String(p?.bucket ?? "CORE").toUpperCase();
        return b === "CORE";
      }).length;

      const listLimit = Math.min(500, Math.max(50, cfg.candidateCap || 50));
      // For diagnostics, show recent signals regardless of status (NEW/EXECUTED/SKIPPED/EXPIRED/ERROR).
      // This avoids the UI looking "dead" when NEW signals are being rapidly executed or expired.
      const signalsRaw = await Promise.resolve(db?.listEscrowSignals?.(listLimit));
      const signals = Array.isArray(signalsRaw) ? signalsRaw : [];
      const newSignalsCount = signals.filter((s: any) => String(s?.status ?? "").toUpperCase() === "NEW").length;

      const sel = scoreAndRankEscrowSignals({
        signals,
        now,
        cfg: {
          candidateCap: cfg.candidateCap,
          delayMin: cfg.delayMin,
          signalExpiryMin: cfg.signalExpiryMin,
          selectionMode: cfg.selectionMode,
          minScore: cfg.minScore,
          scoreWeights: cfg.scoreWeights,
        },
        openMints: openMintSet,
        strategyGates: {
          winMax: cfg.winMax,
          ageMinMinutes: cfg.ageMinMinutes,
          ageMaxMinutes: cfg.ageMaxMinutes,
          dd15Min: cfg.dd15Min,
          ddFromPeak15Min: cfg.ddFromPeak15Min,
          ru15Min: cfg.ru15Min,
          mcapMin: cfg.mcapMin,
          volMin: cfg.volMin,
          samples15mMin: cfg.samples15mMin,
          freefall3mMinRet: cfg.freefall3mMinRet,
          // Backtest optimization gates (must match service.ts)
          momentum3mMin: cfg.momentum3mMin,
          volatility15mMin: cfg.volatility15mMin,
          maxPeakDrawdown: cfg.maxPeakDrawdown,
          // Entry filters to avoid buying tops
          ru15Max: cfg.ru15Max,
          momentum3mMax: cfg.momentum3mMax,
          dipBuyingEnabled: cfg.dipBuyingEnabled,
          dipMinDrawdown: cfg.dipMinDrawdown,
          // V-Reversal mode gates (CRITICAL for Deep V-Reversal strategy)
          vReversalModeEnabled: cfg.vReversalModeEnabled,
          vReversalMinDip: cfg.vReversalMinDip,
          vReversalMinBounce: cfg.vReversalMinBounce,
        },
      });

      const reasons: Array<{ code: string; message: string }> = [];
      if (!cfg.enabled) reasons.push({ code: "disabled", message: "Escrow trader is currently disabled." });
      if (openCoreCount >= cfg.maxCoreOpen) reasons.push({ code: "core_full", message: `CORE is at capacity (${openCoreCount}/${cfg.maxCoreOpen}).` });
      if (newSignalsCount === 0) reasons.push({ code: "no_signals", message: "No NEW signals in the queue right now." });
      if (sel.minScoreBlocked && sel.bestEligible) reasons.push({ code: "min_score", message: `Best signal score ${sel.bestEligible.score.toFixed(3)} is below minScore ${Number(cfg.minScore).toFixed(3)}.` });
      if (!sel.selected && newSignalsCount > 0) {
        const isNew = (r: any) => String(r?.signal?.status ?? "").toUpperCase() === "NEW";
        const ineligibleNew = sel.ranked.filter((r) => isNew(r) && !r.eligible);
        const delayBlocked = ineligibleNew.filter((r) => r.ineligibleReasons.includes("delay_gate"));
        if (delayBlocked.length > 0) {
          const soonest = delayBlocked
            .map((r) => Math.max(0, cfg.delayMin - r.queueAgeMin))
            .sort((a, b) => a - b)[0];
          if (Number.isFinite(soonest)) reasons.push({ code: "delay", message: `Signals are still in the delay gate. Next eligible in ~${soonest.toFixed(1)}m.` });
        }

        const alreadyOpenBlocked = ineligibleNew.filter((r) => r.ineligibleReasons.includes("already_open_position")).length;
        if (alreadyOpenBlocked > 0) {
          reasons.push({ code: "already_open", message: `${alreadyOpenBlocked} signal(s) are blocked because the mint is already in an OPEN/STUCK position.` });
        }

        const gateBlocked = ineligibleNew.filter((r) => r.ineligibleReasons.some((x) => x.startsWith("gate_"))).length;
        if (gateBlocked > 0) {
          reasons.push({ code: "gates", message: `${gateBlocked} signal(s) fail one or more strategy gates (dd/ru/samples/age/mcap/vol).` });
        }
      }

      const enrichSignal = (r: any) => {
        const f = parseEscrowSignalFeatures(r.signal) || {};
        const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null);
        const gates = [
          { key: "win", ok: num(f.win_number) === null ? true : num(f.win_number)! <= cfg.winMax, current: num(f.win_number), target: cfg.winMax },
          { key: "age", ok: num(f.age_minutes) === null ? true : num(f.age_minutes)! >= cfg.ageMinMinutes && num(f.age_minutes)! <= cfg.ageMaxMinutes, current: num(f.age_minutes), target: cfg.ageMinMinutes },
          { key: "mcap", ok: num(f.marketCap) === null ? true : num(f.marketCap)! >= cfg.mcapMin, current: num(f.marketCap), target: cfg.mcapMin },
          { key: "vol24h", ok: num(f.volume24h) === null ? true : num(f.volume24h)! >= cfg.volMin, current: num(f.volume24h), target: cfg.volMin },
          { key: "dd15", ok: num(f.dd_15m) === null ? true : num(f.dd_15m)! >= cfg.dd15Min, current: num(f.dd_15m), target: cfg.dd15Min },
          { key: "ddpk15", ok: num(f.dd_from_peak_15m) === null ? true : num(f.dd_from_peak_15m)! >= cfg.ddFromPeak15Min, current: num(f.dd_from_peak_15m), target: cfg.ddFromPeak15Min },
          { key: "ru15", ok: num(f.ru_15m) === null ? true : num(f.ru_15m)! >= cfg.ru15Min, current: num(f.ru_15m), target: cfg.ru15Min },
          { key: "samples15", ok: num(f.sample_count_15m) === null ? true : num(f.sample_count_15m)! >= cfg.samples15mMin, current: num(f.sample_count_15m), target: cfg.samples15mMin },
          { key: "ff3m", ok: num(f.ret_3m) === null ? true : num(f.ret_3m)! >= cfg.freefall3mMinRet, current: num(f.ret_3m), target: cfg.freefall3mMinRet },
        ];
        return {
          id: r.signal?.id ? Number(r.signal.id) : null,
          mint: r.mint,
          symbol: r.signal?.symbol ? String(r.signal.symbol) : null,
          detectedTs: r.detectedTs,
          queueAgeMin: r.queueAgeMin,
          status: r.signal?.status ? String(r.signal.status).toUpperCase() : null,
          eligible: r.eligible,
          ineligibleReasons: r.ineligibleReasons || [],
          score: r.score,
          gates,
        };
      };

      // Universe "how close" diagnostics
      // Historically this only showed "cheap gates" (win/age/mcap/vol24h) which can be misleading:
      // candidates can pass cheap gates but still fail full strategy gates (price samples / dd/ru/freefall).
      let universe: any[] = [];
      try {
        universe = await getUniverseCandidates(cfg.universeLimit);
      } catch {
        universe = [];
      }

      const universeMints = (universe || [])
        .map((c: any) => String(c?.mint ?? "").trim())
        .filter(Boolean);
      const priceDiag = EscrowTraderService.getPriceDiagnosticsForMints(universeMints, now);

      const failCounts: Record<string, number> = {
        win: 0,
        age: 0,
        mcap: 0,
        vol24h: 0,
        // Full strategy gates (based on in-memory price sampling)
        price15m: 0,
        samples15: 0,
        dd15: 0,
        ddpk15: 0,
        ru15: 0,
        ff3m: 0,
      };
      const closest: Array<{ mint: string; symbol?: string | null; reason: string; current: number; target: number; score: number }> = [];
      const eligibleCheap = (universe || []).filter((c: any, idx: number) => {
        const winNumber = idx + 1;
        const ageMinutes = (now - Number(c.createdAtMs || 0)) / 60000;
        if (winNumber > cfg.winMax) return false;
        if (ageMinutes < cfg.ageMinMinutes || ageMinutes > cfg.ageMaxMinutes) return false;
        if (Number(c.marketCap || 0) < cfg.mcapMin) return false;
        if (Number(c.volume24h || 0) < cfg.volMin) return false;
        return true;
      });

      // If the universe has eligible candidates but we have no persisted signals at all, call it out explicitly.
      // This helps distinguish "no NEW signals" from "signal pipeline not writing to DB / just started".
      if (cfg.enabled && signals.length === 0 && eligibleCheap.length > 0) {
        reasons.push({
          code: "no_persisted_signals",
          message: "Universe has eligible candidates, but no signals are persisted yet (possible: trader just restarted / waiting for price samples / DB write issue).",
        });
      }

      for (const [idx, c] of (universe || []).entries()) {
        const mint = String(c.mint || "");
        if (!mint) continue;
        const winNumber = idx + 1;
        const ageMinutes = (now - Number(c.createdAtMs || 0)) / 60000;
        const mcap = Number(c.marketCap || 0);
        const vol = Number(c.volume24h || 0);

        const fails: Array<{ reason: string; current: number; target: number; gap: number }> = [];
        if (winNumber > cfg.winMax) {
          failCounts.win += 1;
          fails.push({ reason: "win", current: winNumber, target: cfg.winMax, gap: winNumber - cfg.winMax });
        }
        if (ageMinutes < cfg.ageMinMinutes) {
          failCounts.age += 1;
          fails.push({ reason: "age_min", current: Math.floor(ageMinutes), target: cfg.ageMinMinutes, gap: cfg.ageMinMinutes - ageMinutes });
        } else if (ageMinutes > cfg.ageMaxMinutes) {
          failCounts.age += 1;
          fails.push({ reason: "age_max", current: Math.floor(ageMinutes), target: cfg.ageMaxMinutes, gap: ageMinutes - cfg.ageMaxMinutes });
        }
        if (mcap < cfg.mcapMin) {
          failCounts.mcap += 1;
          fails.push({ reason: "mcap", current: mcap, target: cfg.mcapMin, gap: cfg.mcapMin - mcap });
        }
        if (vol < cfg.volMin) {
          failCounts.vol24h += 1;
          fails.push({ reason: "vol24h", current: vol, target: cfg.volMin, gap: cfg.volMin - vol });
        }

        const cheapPass = fails.length === 0;
        if (cheapPass) {
          const d = priceDiag[mint];
          const sampleCount15m = Number(d?.sampleCount15m ?? 0);
          const ruDd = d?.ruDd15m ?? null;

          // If we can't compute 15m stats yet, surface it explicitly.
          if (!ruDd) {
            failCounts.price15m += 1;
            const target = 2; // minimum samples to compute a window-based stat
            const gap = Math.max(0, target - sampleCount15m);
            fails.push({ reason: "price15m", current: sampleCount15m, target, gap });
          } else {
            const samples = Number(ruDd.sampleCount ?? sampleCount15m);
            const dd15 = Number(ruDd.dd15m);
            const ddpk15 = Number(ruDd.ddFromPeak15m);
            const ru15 = Number(ruDd.ru15m);
            const ff3m = Number(ruDd.ret3m);

            if (Number.isFinite(samples) && samples < cfg.samples15mMin) {
              failCounts.samples15 += 1;
              fails.push({ reason: "samples15", current: samples, target: cfg.samples15mMin, gap: cfg.samples15mMin - samples });
            }
            if (Number.isFinite(dd15) && dd15 < cfg.dd15Min) {
              failCounts.dd15 += 1;
              fails.push({ reason: "dd15", current: dd15, target: cfg.dd15Min, gap: cfg.dd15Min - dd15 });
            }
            if (Number.isFinite(ddpk15) && ddpk15 < cfg.ddFromPeak15Min) {
              failCounts.ddpk15 += 1;
              fails.push({ reason: "ddpk15", current: ddpk15, target: cfg.ddFromPeak15Min, gap: cfg.ddFromPeak15Min - ddpk15 });
            }
            if (Number.isFinite(ru15) && ru15 < cfg.ru15Min) {
              failCounts.ru15 += 1;
              fails.push({ reason: "ru15", current: ru15, target: cfg.ru15Min, gap: cfg.ru15Min - ru15 });
            }
            if (Number.isFinite(ff3m) && ff3m < cfg.freefall3mMinRet) {
              failCounts.ff3m += 1;
              fails.push({ reason: "ff3m", current: ff3m, target: cfg.freefall3mMinRet, gap: cfg.freefall3mMinRet - ff3m });
            }
          }
        }

        if (fails.length) {
          const best = fails.slice().sort((a, b) => a.gap - b.gap)[0];
          closest.push({
            mint,
            symbol: c.symbol ? String(c.symbol) : null,
            reason: best.reason,
            current: Number.isFinite(best.current) ? Number(best.current.toFixed?.(2) ?? best.current) : best.current,
            target: best.target,
            score: best.gap,
          });
        }
      }

      closest.sort((a, b) => a.score - b.score);

      // If we have cheap-eligible candidates but no NEW signals, call out that the *full* gates are likely blocking.
      // This is the common "UI looks fine but nothing is enqueued" failure mode.
      if (cfg.enabled && newSignalsCount === 0 && eligibleCheap.length > 0) {
        const fullBlocks = failCounts.price15m + failCounts.samples15 + failCounts.dd15 + failCounts.ddpk15 + failCounts.ru15 + failCounts.ff3m;
        if (fullBlocks > 0) {
          reasons.push({
            code: "universe_full_gates",
            message: `Universe has ${eligibleCheap.length} candidate(s) passing cheap gates, but none currently pass full gates (price15m/samples/dd/ru/freefall). Check Universe → Closest to passing for details.`,
          });
        }
      }

      res.json({
        access: {
          allowed: true,
          requiredRaceUi,
          holderBoost: { raceBalanceUi: String(holderBoost?.raceBalanceUi ?? "0"), tier: holderBoost?.tier ?? "none" },
        },
        escrow: { pubkey: escrowPubkey, solscanUrl: `https://solscan.io/account/${escrowPubkey}` },
        stats: {
          lastEntryTs,
          openPositions,
          pnl: {
            totalPnlSol: Number.isFinite(pnlSolSum) ? pnlSolSum : 0,
            totalPnlPct,
            tradesClosed: closed.length,
            tradesTotal: recentPositions.length,
          },
        },
        recentPositions,
        signalPool: {
          enabled: cfg.enabled,
          reasons,
          openCoreCount,
          maxCoreOpen: cfg.maxCoreOpen,
          delayMin: cfg.delayMin,
          signalExpiryMin: cfg.signalExpiryMin,
          selectionMode: cfg.selectionMode,
          minScore: cfg.minScore,
          newSignalsCount,
          totalSignalsCount: signals.length,
          signals: sel.ranked.slice(0, 200).map(enrichSignal),
          selectedMint: sel.selected?.mint ?? null,
          selectedScore: sel.selected?.score ?? null,
          minScoreBlocked: sel.minScoreBlocked,
          universe: {
            total: (universe || []).length,
            eligibleCheap: eligibleCheap.length,
            failCounts,
            closest: closest.slice(0, 20).map((c) => ({ mint: c.mint, symbol: c.symbol ?? null, reason: c.reason, current: c.current, target: c.target })),
          },
        },
      });
    } catch (e: any) {
      console.error("[copy-trade/dashboard] error:", e);
      res.status(500).json({ error: e?.message || "Failed to load copy trade dashboard" });
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

    // Swap stats endpoint - cached volume and revenue data
    app.get("/api/swap-stats", async (req, res) => {
      try {
        const { getSwapStatsAsync } = await import('./referral-stats');
        const solPriceRaw = Array.isArray(req.query.solPrice) ? req.query.solPrice[0] : req.query.solPrice;
        const solPrice = solPriceRaw ? Number(solPriceRaw) : 200;
        const stats = await getSwapStatsAsync(solPrice);
        res.json(stats);
      } catch (error) {
        console.error("[swap-stats] error:", error);
        res.status(500).json({ error: "Failed to load swap stats" });
      }
    });

    // Swap contest leaderboard endpoint
    app.get("/api/swap-contest/leaderboard", async (req, res) => {
      try {
        const { getSwapContestLeaderboard } = await import('./swap-contest-leaderboard');
        const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
        const walletParam = Array.isArray(req.query.wallet) ? req.query.wallet[0] : req.query.wallet;
        const limit = limitParam ? Math.min(Math.max(parseInt(String(limitParam), 10), 1), 100) : 50;
        const wallet = walletParam ? String(walletParam) : undefined;
        
        const leaderboard = await getSwapContestLeaderboard(limit, wallet);
        res.json(leaderboard);
      } catch (error) {
        console.error("[swap-contest] leaderboard error:", error);
        res.status(500).json({ error: "Failed to load swap contest leaderboard" });
      }
    });

    // Admin endpoint to backfill leaderboard data
    app.post("/api/admin/swap-contest/backfill", requireAdminAuth, async (req, res) => {
      try {
        const { backfillLeaderboardFromSwapRewards } = await import('./swap-contest-leaderboard');
        const result = await backfillLeaderboardFromSwapRewards();
        res.json(result);
      } catch (error) {
        console.error("[swap-contest] backfill error:", error);
        res.status(500).json({ error: "Failed to backfill swap contest leaderboard" });
      }
    });

    // ==========================================================================
    // QUESTS & FUEL ECONOMY ROUTES
    // ==========================================================================
    
    // Get user quests and FUEL balance
    app.get("/api/quests", async (req, res) => {
      try {
        const { getUserQuests } = await import('./quests');
        const walletParam = Array.isArray(req.query.wallet) ? req.query.wallet[0] : req.query.wallet;
        
        if (!walletParam || typeof walletParam !== 'string') {
          return res.status(400).json({ error: "wallet query parameter is required" });
        }
        
        const quests = await getUserQuests(walletParam);
        res.json(quests);
      } catch (error) {
        console.error("[quests] get quests error:", error);
        res.status(500).json({ error: "Failed to load quests" });
      }
    });
    
    // Rate limiter for quest claims (prevent spam/abuse)
    const questClaimRateLimit = new Map<string, number>();
    const QUEST_CLAIM_COOLDOWN_MS = 2000; // 2 seconds between claims per wallet
    
    // Claim quest reward
    app.post("/api/quests/claim", async (req, res) => {
      try {
        const { claimQuestReward } = await import('./quests');
        const { wallet, questId } = req.body;
        
        if (!wallet || typeof wallet !== 'string') {
          return res.status(400).json({ error: "wallet is required" });
        }
        if (!questId || typeof questId !== 'string') {
          return res.status(400).json({ error: "questId is required" });
        }
        
        // Rate limiting: prevent rapid-fire claim attempts
        const now = Date.now();
        const lastClaim = questClaimRateLimit.get(wallet);
        if (lastClaim && (now - lastClaim) < QUEST_CLAIM_COOLDOWN_MS) {
          return res.status(429).json({ error: "Too many requests. Please wait a moment." });
        }
        questClaimRateLimit.set(wallet, now);
        
        // Clean up old entries periodically (every 100 requests)
        if (questClaimRateLimit.size > 1000) {
          const cutoff = now - QUEST_CLAIM_COOLDOWN_MS * 10;
          for (const [w, t] of questClaimRateLimit.entries()) {
            if (t < cutoff) questClaimRateLimit.delete(w);
          }
        }
        
        const result = await claimQuestReward(wallet, questId);
        
        if (!result.success) {
          return res.status(400).json({ error: result.error });
        }
        
        res.json(result);
      } catch (error) {
        console.error("[quests] claim reward error:", error);
        res.status(500).json({ error: "Failed to claim quest reward" });
      }
    });
    
    // Get past winners history
    app.get("/api/quests/past-winners", async (req, res) => {
      try {
        const { pgPool } = await import('./db/clients');
        if (!pgPool) {
          return res.json({ winners: [] });
        }
        
        // First check if table exists to avoid query errors
        const tableCheck = await pgPool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_name = 'quest_past_winners'
          )
        `);
        
        if (!tableCheck.rows[0]?.exists) {
          // Table doesn't exist yet, return empty list
          return res.json({ winners: [] });
        }
        
        const result = await pgPool.query(`
          SELECT 
            id, week_number, season_start, season_end, 
            winner_wallet, winner_score, prize_nft_mint, 
            prize_nft_name, prize_nft_image, prize_value_usd,
            send_tx_sig, total_participants, created_at
          FROM quest_past_winners
          ORDER BY week_number DESC
          LIMIT 50
        `);
        
        res.json({ 
          winners: result.rows.map(row => ({
            weekNumber: row.week_number,
            seasonStart: Number(row.season_start),
            seasonEnd: Number(row.season_end),
            winnerWallet: row.winner_wallet,
            winnerScore: row.winner_score,
            prizeNftMint: row.prize_nft_mint,
            prizeNftName: row.prize_nft_name,
            prizeNftImage: row.prize_nft_image,
            prizeValueUsd: row.prize_value_usd ? Number(row.prize_value_usd) : null,
            sendTxSig: row.send_tx_sig,
            totalParticipants: row.total_participants,
            createdAt: Number(row.created_at),
          }))
        });
      } catch (error) {
        console.error("[quests] get past winners error:", error);
        // Return empty winners array on any error to prevent frontend issues
        res.json({ winners: [] });
      }
    });
    
    // Get FUEL boost multiplier for a wallet (used for card drop calculations)
    app.get("/api/fuel/boost", async (req, res) => {
      try {
        const { getFuelBoostMultiplier } = await import('./quests');
        const walletParam = Array.isArray(req.query.wallet) ? req.query.wallet[0] : req.query.wallet;
        
        if (!walletParam || typeof walletParam !== 'string') {
          return res.status(400).json({ error: "wallet query parameter is required" });
        }
        
        const multiplier = await getFuelBoostMultiplier(walletParam);
        
        res.json({ 
          wallet: walletParam, 
          fuelMultiplier: multiplier,
        });
      } catch (error) {
        console.error("[quests] get fuel boost error:", error);
        res.status(500).json({ error: "Failed to get FUEL boost" });
      }
    });
    
    // =======================================================================
    // QUEST ADMIN ENDPOINTS (protected by admin key)
    // =======================================================================
    
    // Get current season status
    app.get("/api/admin/quests/status", async (req, res) => {
      try {
        const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
        const expectedKey = process.env.QUEST_ADMIN_KEY || 'quest-admin-2026';
        
        if (adminKey !== expectedKey) {
          return res.status(401).json({ error: "Unauthorized" });
        }
        
        const { getSeasonStatus } = await import('./quests');
        const status = await getSeasonStatus();
        res.json(status);
      } catch (error) {
        console.error("[quests-admin] get status error:", error);
        res.status(500).json({ error: "Failed to get season status" });
      }
    });
    
    // Reset quest season (use after distributing prize card)
    app.post("/api/admin/quests/reset", async (req, res) => {
      try {
        const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
        const expectedKey = process.env.QUEST_ADMIN_KEY || 'quest-admin-2026';
        
        if (adminKey !== expectedKey) {
          return res.status(401).json({ error: "Unauthorized" });
        }
        
        const { resetQuestSeason, getSeasonStatus } = await import('./quests');
        
        // Get winner before reset for logging
        const statusBefore = await getSeasonStatus();
        console.log(`[quests-admin] Resetting season. Winner was: ${statusBefore.winner?.wallet || 'none'} with score ${statusBefore.winner?.score || 0}`);
        
        const result = await resetQuestSeason();
        
        if (!result.success) {
          return res.status(500).json({ error: result.message });
        }
        
        res.json({
          success: true,
          previousWinner: statusBefore.winner,
          newSeasonStart: result.newSeasonStart,
          newSeasonStartDate: new Date(result.newSeasonStart).toISOString(),
          message: result.message,
          instructions: [
            "1. Prize card has been noted (see previousWinner)",
            "2. Database has been reset",
            "3. New season start saved to database (automatic!)",
            "4. If you set QUEST_SEASON_LOCKED=true, remove it from Replit Secrets",
            "5. Done! New season is live."
          ]
        });
      } catch (error) {
        console.error("[quests-admin] reset error:", error);
        res.status(500).json({ error: "Failed to reset quest season" });
      }
    });

      app.get("/api/raceswap/tokens", async (req, res) => {
        try {
          const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
          const limit = limitParam ? Number(limitParam) : undefined;
          const tokens = await getRaceswapTokenList(limit);
          // Token list barely changes — cache aggressively
          res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
          res.json(tokens);
        } catch (error) {
          console.error("[raceswap] token list error:", error);
          res.set('Cache-Control', 'public, max-age=60');
          res.json(getFallbackRaceswapTokens());
        }
      });

      // Swap notification endpoint
      app.post("/api/raceswap/notify", async (req, res) => {
        try {
          const { sendSwapNotificationToTelegram } = await import('./telegram');
          const data = req.body;
          
          // Validate required fields
          if (!data.spentAmount || !data.spentSymbol || !data.receivedAmount || !data.receivedSymbol) {
            return res.status(400).json({ error: "Missing required swap data fields" });
          }
          
          // Determine the fee token based on Jupiter's referral fee logic:
          // - If SOL is involved (input OR output), fees are collected in SOL
          // - If SOL is not involved, fees are collected in the output token
          const inputSymbol = (data.spentSymbol || "").toUpperCase();
          const outputSymbol = (data.receivedSymbol || "").toUpperCase();
          const isSolInvolved = inputSymbol === "SOL" || outputSymbol === "SOL";
          
          let treasuryFeeAmount: string;
          let treasuryFeeSymbol: string;
          
          if (isSolInvolved) {
            // Fee is always in SOL when SOL is involved
            treasuryFeeSymbol = "SOL";
            if (inputSymbol === "SOL") {
              // SOL → Token: fee is 2.5% of input SOL
              const spentAmountNum = parseFloat(data.spentAmount);
              treasuryFeeAmount = (spentAmountNum * 0.025).toFixed(6);
            } else {
              // Token → SOL: fee is 2.5% of output SOL
              const receivedAmountNum = parseFloat(data.receivedAmount);
              treasuryFeeAmount = (receivedAmountNum * 0.025).toFixed(6);
            }
          } else {
            // No SOL involved (Token → Token): fee is in output token
            const receivedAmountNum = parseFloat(data.receivedAmount);
            treasuryFeeAmount = (receivedAmountNum * 0.025).toFixed(6);
            treasuryFeeSymbol = data.receivedSymbol;
          }
          
          const swapData = {
            spentAmount: data.spentAmount,
            spentSymbol: data.spentSymbol,
            spentLogo: data.spentLogo,
            receivedAmount: data.receivedAmount,
            receivedSymbol: data.receivedSymbol,
            receivedLogo: data.receivedLogo,
            reflectionAmount: data.reflectionAmount || "0",
            reflectionSymbol: data.reflectionSymbol || "",
            reflectionLogo: data.reflectionLogo,
            mainSignature: data.mainSignature,
            reflectionSignature: data.reflectionSignature,
            treasuryFee: treasuryFeeAmount,
            treasuryFeeSymbol: treasuryFeeSymbol,
            boostedReward: data.boostedReward, // Include swap rewards if won
            cardReward: data.cardReward, // Include card reward if won
          };
          
          // Send notification asynchronously (don't wait for it)
          void sendSwapNotificationToTelegram(swapData);
          
          res.json({ success: true, message: "Swap notification queued" });
        } catch (error) {
          console.error("[raceswap] Swap notification error:", error);
          res.status(500).json({ error: "Failed to queue swap notification" });
        }
      });

      // Endpoint to fetch token metadata from on-chain
      app.get("/api/raceswap/token-metadata", async (req, res) => {
        try {
          const { mint } = req.query;
          if (!mint || typeof mint !== 'string') {
            return res.status(400).json({ error: "mint parameter is required" });
          }

          const { PublicKey } = await import("@solana/web3.js");
          const { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
          const { connection } = await import("./solana");

          let mintPubkey: PublicKey;
          try {
            mintPubkey = new PublicKey(mint);
          } catch {
            return res.status(400).json({ error: "Invalid mint address" });
          }

          // Get mint account info to determine token program
          const mintAccount = await connection.getAccountInfo(mintPubkey, "confirmed");
          if (!mintAccount) {
            return res.status(404).json({ error: "Mint account not found" });
          }

          const tokenProgramId = mintAccount.owner;
          if (!tokenProgramId.equals(TOKEN_PROGRAM_ID) && !tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)) {
            return res.status(400).json({ error: "Not a valid token mint (must be TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID)" });
          }

          // Get mint info (decimals)
          const mintInfo = await getMint(connection, mintPubkey, undefined, tokenProgramId);
          const decimals = Number(mintInfo.decimals ?? 9);

          // Try to get symbol/name from Jupiter token list
          let symbol: string | undefined;
          let name: string | undefined;
          let logoURI: string | undefined;

          try {
            // Try Ultra search API first (more reliable)
            try {
              const ultraResponse = await fetch(`https://lite-api.jup.ag/ultra/v1/search?query=${mint}`, {
                headers: { Accept: "application/json" },
              });
              if (ultraResponse.ok) {
                const ultraData = await ultraResponse.json();
                if (Array.isArray(ultraData) && ultraData.length > 0) {
                  const token = ultraData[0];
                  symbol = token.symbol || token.name;
                  name = token.name || symbol;
                  logoURI = token.icon;
                }
              }
            } catch (ultraError) {
              // Fallback to token list API
              const jupiterResponse = await fetch("https://token.jup.ag/all", {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(5000), // 5 second timeout
              });
              if (jupiterResponse.ok) {
                const jupiterTokens = await jupiterResponse.json();
                const tokenList = Array.isArray(jupiterTokens) ? jupiterTokens : (jupiterTokens?.tokens || []);
                const jupiterToken = tokenList.find((t: any) => t.address === mint);
                if (jupiterToken) {
                  symbol = jupiterToken.symbol || jupiterToken.name;
                  name = jupiterToken.name || symbol;
                  logoURI = jupiterToken.logoURI;
                }
              }
            }
          } catch (e) {
            // Both Jupiter fetches failed, continue without metadata
            // This is non-critical - we'll use fallback symbol/name
            console.warn(`[raceswap] Failed to fetch Jupiter metadata for ${mint}:`, e instanceof Error ? e.message : e);
          }

          // If no symbol from Jupiter, use mint address short form
          if (!symbol) {
            symbol = mint.slice(0, 4) + "..." + mint.slice(-4);
            name = `Token ${mint.slice(0, 8)}`;
          }

          res.json({
            address: mint,
            symbol,
            name: name || symbol,
            decimals,
            logoURI,
          });
        } catch (error: any) {
          console.error("[raceswap] token metadata error:", error);
          res.status(500).json({ error: error?.message || "Failed to fetch token metadata" });
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

      // Boosted RNG reward endpoint - provably fair based on block hash
      app.post("/api/raceswap/boosted-reward", async (req, res) => {
        try {
          const { signature, inputMint, inputAmount, inputDecimals, recipient } = req.body;
          
          if (!signature || !inputMint || !inputAmount || !recipient) {
            return res.status(400).json({ error: "Missing required fields: signature, inputMint, inputAmount, recipient" });
          }

          // Promo/Test mode: Higher win probability for specific address
          // Set via PROMO_ADDRESS env var, can be disabled by not setting it
          const PROMO_ADDRESS = process.env.PROMO_ADDRESS?.trim();
          const PROMO_WIN_PROBABILITY = parseFloat(process.env.PROMO_WIN_PROBABILITY || "0.8"); // 80% default for promo
          const isPromoAddress = PROMO_ADDRESS && recipient.toLowerCase() === PROMO_ADDRESS.toLowerCase();

          const { connection, getMintTokenProgramId, raceMintAddress, serverKeypair } = await import("./solana");
          const { PublicKey } = await import("@solana/web3.js");
          const { getTokenStatsWithFallbacks: getTokenStats } = await import('./dexscreener-ohlcv');
          const { createHash } = await import('crypto');

          // Get slot from signature status (faster than fetching full transaction)
          // This is much lighter and faster than getTransaction
          let slot: number | null = null;
          let retries = 0;
          const maxRetries = 10; // More retries since this is faster
          const baseDelay = 50; // Very fast: start with 50ms
          
          while (!slot && retries < maxRetries) {
            try {
              const statuses = await connection.getSignatureStatuses([signature], {
                searchTransactionHistory: true,
              });
              
              const status = statuses.value?.[0];
              if (status?.slot) {
                slot = status.slot;
                break;
              }
              
              // If we have confirmation status but no slot yet, wait a bit
              if (status && retries < maxRetries - 1) {
                const delay = baseDelay + (retries * 30); // 50ms, 80ms, 110ms, etc.
                await new Promise(resolve => setTimeout(resolve, delay));
                retries++;
              } else if (!status && retries < maxRetries - 1) {
                // Transaction not found yet, wait longer
                const delay = baseDelay + (retries * 30);
                await new Promise(resolve => setTimeout(resolve, delay));
                retries++;
              } else {
                break;
              }
            } catch (error) {
              console.warn(`[boosted-reward] Error fetching signature status (attempt ${retries + 1}/${maxRetries}):`, error);
              if (retries < maxRetries - 1) {
                const delay = baseDelay + (retries * 30);
                await new Promise(resolve => setTimeout(resolve, delay));
                retries++;
              } else {
                throw error;
              }
            }
          }

          // Get block hash from slot with aggressive retries
          let blockhash = null;
          if (slot) {
            retries = 0;
            while (!blockhash && retries < maxRetries) {
              try {
                const block = await connection.getBlock(slot, { 
                  commitment: 'confirmed', 
                  maxSupportedTransactionVersion: 0 
                });
                blockhash = block?.blockhash || null;
                
                if (!blockhash && retries < maxRetries - 1) {
                  const delay = baseDelay + (retries * 30);
                  await new Promise(resolve => setTimeout(resolve, delay));
                  retries++;
                }
              } catch (error) {
                console.warn(`[boosted-reward] Error fetching block for slot ${slot} (attempt ${retries + 1}/${maxRetries}):`, error);
                if (retries < maxRetries - 1) {
                  const delay = baseDelay + (retries * 30);
                  await new Promise(resolve => setTimeout(resolve, delay));
                  retries++;
                } else {
                  console.warn(`[boosted-reward] Could not get block hash for slot ${slot} after retries, using signature as seed`);
                  break;
                }
              }
            }
          }
          
          if (!blockhash) {
            // Fallback: use transaction signature as seed
            console.warn(`[boosted-reward] Could not get block hash for slot ${slot || 'unknown'}, using signature as seed`);
          }

          // Calculate provably fair random number from block hash (or signature)
          const seed = blockhash || signature;
          const hash = createHash('sha256').update(seed + signature).digest();
          // Convert first 8 bytes to a number between 0 and 1
          const randomValue = hash.readUInt32BE(0) / 0xFFFFFFFF;

          // Security: ensure the reward recipient is the swap fee payer.
          // Prevents using someone else’s swap signature to route rewards to an attacker.
          try {
            const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
            const msg: any = tx?.transaction?.message as any;
            const keys: string[] = (msg?.staticAccountKeys || msg?.accountKeys || []).map((k: any) =>
              k?.toBase58 ? k.toBase58() : k?.toString ? k.toString() : String(k)
            );
            const feePayer = keys?.[0] || "";
            if (!feePayer || feePayer !== String(recipient)) {
              return res.status(403).json({ error: "Recipient must match swap fee payer" });
            }
          } catch {
            return res.status(502).json({ error: "Unable to verify swap signer; please retry shortly" });
          }

          // Calculate USD value of swap
          // Known stablecoin mints that should always be $1
          const STABLECOIN_MINTS = new Set([
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3YaFT', // UXD Stablecoin
            'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', // USDC (USDC.e)
            'EchesyfXePKdLtoiZSL8pBe8Myagyy8ZRqsACNCFGnvp', // FIDA
          ]);
          
          const SOL_MINT = 'So11111111111111111111111111111111111111112';
          const isStablecoin = STABLECOIN_MINTS.has(inputMint);
          const isSol = inputMint === SOL_MINT;
          
          let usdValue = 0;
          const inputAmountNum = parseFloat(inputAmount);
          const decimals = inputDecimals || (isSol ? 9 : 6); // Default to 6 for tokens, 9 for SOL
          const humanReadableAmount = inputAmountNum / Math.pow(10, decimals);
          
          if (isStablecoin) {
            // Stablecoins are always $1
            usdValue = humanReadableAmount * 1;
            console.log(`[boosted-reward] Using stablecoin price ($1) for ${inputMint}: ${humanReadableAmount} = $${usdValue}`);
          } else {
            try {
              const stats = await getTokenStats(inputMint);
              const priceUsd = stats.currentPriceUsd || 0;
              
              if (priceUsd > 0) {
                // We got a valid price from the API - use it
                usdValue = humanReadableAmount * priceUsd;
                console.log(`[boosted-reward] Got price for ${inputMint}: $${priceUsd}, amount: ${humanReadableAmount}, USD value: $${usdValue}`);
                
                // Sanity check: if the price seems suspiciously high (likely API error), cap it
                // Most legitimate tokens are under $1000, so if we get a price > $10k, be suspicious
                if (priceUsd > 10000) {
                  console.warn(`[boosted-reward] Suspiciously high price $${priceUsd} for ${inputMint}, capping calculation`);
                  // Cap the effective price at $1000 to prevent over-rewarding
                  const cappedPrice = Math.min(priceUsd, 1000);
                  usdValue = humanReadableAmount * cappedPrice;
                }
              } else {
                // Price is 0 or missing - use very conservative fallback
                console.warn(`[boosted-reward] Got 0 or missing price for ${inputMint}, using ultra-conservative fallback`);
                
                if (isSol) {
                  // For SOL, try to get actual SOL price
                  const solStats = await getTokenStats(SOL_MINT).catch(() => null);
                  const solPrice = solStats?.currentPriceUsd || 150; // Fallback to ~$150 SOL
                  usdValue = humanReadableAmount * solPrice;
                  console.log(`[boosted-reward] Using SOL price $${solPrice} for SOL: ${humanReadableAmount} = $${usdValue}`);
                } else {
                  // For unknown tokens with missing prices, use EXTREMELY conservative approach
                  // Instead of guessing a price per token (which can be wildly wrong),
                  // we cap the total USD value at a very low maximum for unknown tokens
                  // This prevents over-rewarding regardless of token quantity
                  // Cap at $10 to be very safe - most legitimate swaps will have price data
                  const MAX_UNKNOWN_TOKEN_USD_VALUE = 10; // Max $10 for unknown tokens - ultra conservative
                  
                  // Try a very low per-token estimate first
                  const ULTRA_CONSERVATIVE_PRICE = 0.0001; // $0.0001 per token (much lower than before)
                  let estimatedValue = humanReadableAmount * ULTRA_CONSERVATIVE_PRICE;
                  
                  // Always cap unknown tokens at the maximum - this is the key safety measure
                  usdValue = Math.min(estimatedValue, MAX_UNKNOWN_TOKEN_USD_VALUE);
                  
                  console.warn(`[boosted-reward] Unknown token ${inputMint}: ${humanReadableAmount} tokens, estimated $${estimatedValue.toFixed(2)}, capped at $${usdValue} (max $${MAX_UNKNOWN_TOKEN_USD_VALUE} for unknown tokens)`);
                }
              }
            } catch (error) {
              console.warn(`[boosted-reward] Failed to get USD price for ${inputMint}:`, error);
              
              // Last resort: use extremely conservative estimate
              if (isSol) {
                // For SOL, use a reasonable default
                const solPrice = 150; // ~$150 SOL
                usdValue = humanReadableAmount * solPrice;
                console.warn(`[boosted-reward] Using SOL default price $${solPrice} for ${inputMint}: ${humanReadableAmount} = $${usdValue}`);
              } else {
                // For unknown tokens, cap at very low maximum to prevent over-rewarding
                const MAX_UNKNOWN_TOKEN_USD_VALUE = 10; // Max $10 for unknown tokens - ultra conservative
                const ULTRA_CONSERVATIVE_PRICE = 0.0001; // $0.0001 per token
                let estimatedValue = humanReadableAmount * ULTRA_CONSERVATIVE_PRICE;
                usdValue = Math.min(estimatedValue, MAX_UNKNOWN_TOKEN_USD_VALUE);
                
                console.warn(`[boosted-reward] Last-resort: Unknown token ${inputMint}, ${humanReadableAmount} tokens, estimated $${estimatedValue.toFixed(2)}, capped at $${usdValue} (max $${MAX_UNKNOWN_TOKEN_USD_VALUE})`);
              }
            }
          }
          
          // Final safety cap: Never allow USD value to exceed a reasonable maximum to prevent exploits
          // This protects against edge cases where price calculation might be wrong
          const MAX_USD_VALUE = 10000; // Cap at $10k per swap
          if (usdValue > MAX_USD_VALUE) {
            console.warn(`[boosted-reward] Final safety cap: Capping USD value from $${usdValue} to $${MAX_USD_VALUE} for swap`);
            usdValue = MAX_USD_VALUE;
          }
          

          // Calculate win probability: base 0.5% + scaled by USD value
          // Designed to keep expected reward cost < 0.3% of swap value
          // Formula: base 0.5% + (USD value / 500) * 0.1% (max 1.5% total)
          // This means: $0-500 = 0.5-0.6%, $500-1000 = 0.6-0.7%, $1000+ = up to 1.5%
          let baseProbability = 0.005; // 0.5% base
          let scaledProbability = Math.min((usdValue / 500) * 0.001, 0.01); // Max 1% additional
          let winProbability = Math.min(baseProbability + scaledProbability, 0.015); // Max 1.5% total

          // Promo/Test mode: Override probability for specific address
          if (isPromoAddress) {
            winProbability = Math.min(PROMO_WIN_PROBABILITY, 0.95); // Cap at 95% for safety
            console.log(`🎰 [PROMO MODE] Address ${recipient.slice(0, 8)}... using ${(winProbability * 100).toFixed(1)}% win probability`);
          }

          const won = randomValue < winProbability;

          let rewardAmount = 0n;
          let rewardSignature: string | null = null;
          let error: string | null = null;

          if (won) {
            try {
              // Calculate reward amount: structured to be profitable while encouraging daily use
              // Economics: We collect 0.5% fee, expected reward cost should be < 0.3% of swap value
              // This ensures profitability while making rewards attractive
              
              // Base reward: 25,000 RACE (~$0.50) - ensures even small swaps get meaningful reward
              const baseReward = 25000;
              
              // Scaled reward: Progressive scaling that encourages larger swaps
              // Formula: 500 RACE per $1 USD (more conservative than before)
              // This means: $10 = 5,000 additional, $100 = 50,000 additional, $500 = 250,000 additional
              // Cap at 475,000 additional to keep max reward reasonable
              const scaledReward = Math.min(usdValue * 500, 475000);
              
              // Total reward: 25,000 - 500,000 RACE ($0.50 - $10.50)
              const totalReward = baseReward + scaledReward;
              
              // RACE token has 6 decimals
              rewardAmount = BigInt(Math.floor(totalReward * 1e6));

              const raceMint = raceMintAddress ? new PublicKey(raceMintAddress) : null;
              if (!raceMint) {
                throw new Error("RACE mint not configured");
              }

              const recipientPubkey = new PublicKey(recipient);
              
              // Import transfer function (it will handle Token 2022 internally)
              const { transferFromEscrow } = await import("./solana");
              
              // Send RACE tokens from escrow
              rewardSignature = await transferFromEscrow({
                mint: raceMint,
                to: recipientPubkey,
                amount: rewardAmount,
                memo: `Boosted RNG Reward - ${signature.slice(0, 8)}`
              });

              console.log(`🎰 [boosted-reward] Winner! Sent ${totalReward} RACE to ${recipient} (tx: ${rewardSignature})`);
            } catch (err: any) {
              console.error(`[boosted-reward] Failed to send reward:`, err);
              error = err.message || "Failed to send reward";
            }
          }

          res.json({
            won,
            blockhash: blockhash || null,
            randomValue,
            winProbability,
            usdValue,
            rewardAmount: won && rewardAmount > 0n ? rewardAmount.toString() : null,
            rewardSignature,
            error,
            isPromoMode: isPromoAddress || undefined, // Only include if true, for transparency
            // Include transaction signature for verification
            transactionSignature: signature
          });
        } catch (error: any) {
          console.error("[raceswap] boosted-reward error:", error);
          res.status(500).json({ error: error.message || "Failed to process boosted reward" });
        }
      });

      // Combined Swap Rewards (RACE + rare on-chain NFT card), provably fair via blockhash.
      // Also returns verified $RACE-holder boost tier used for probability scaling.
      app.post("/api/raceswap/swap-rewards", async (req, res) => {
        const startTime = Date.now();
        try {
          const { signature, recipient } = req.body || {};
          console.log(`[swap-rewards] START sig=${signature?.slice?.(0, 16)}... recipient=${recipient?.slice?.(0, 8)}...`);
          
          if (!signature || !recipient) {
            console.log(`[swap-rewards] FAIL: Missing required fields`);
            return res.status(400).json({ error: "Missing required fields: signature, recipient" });
          }

          const { connection, raceMintAddress, serverKeypair, treasuryPubkey, jackpotPubkey } = await import("./solana");
          const { getTokenStatsWithFallbacks: getTokenStats } = await import("./dexscreener-ohlcv");
          const { transferFromEscrow } = await import("./solana");
          const { PublicKey } = await import("@solana/web3.js");
          const { createHash } = await import("crypto");
          const { pgPool } = await import("./db/clients");
          const {
            getVerifiedHolderBoost,
            getAvailableCardPool,
            getPersistedSwapRewardIfAny,
            persistSwapRewardResult,
          } = await import("./raceswap-swap-rewards");

          const sig = String(signature);
          const recipientStr = String(recipient);
          const SOL_MINT = "So11111111111111111111111111111111111111112";
          const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
          const REFERRAL_ACCOUNT_FALLBACK = "7ERHbdBfEuk7RTKin4vYTVdqQJEsLhRbLquaKuUa7r66";
          const REFERRAL_ACCOUNT = (process.env.JUPITER_REFERRAL_ACCOUNT || JUPITER_REFERRAL_ACCOUNT || "").trim() || REFERRAL_ACCOUNT_FALLBACK;

          // Read minimum eligibility thresholds from env (Replit secrets).
          // If either input OR output moves at least one of these amounts, the swap is eligible for drops.
          const parseDecimalToBaseUnits = (value: string, decimals: number): bigint | null => {
            const v = String(value || "").trim();
            if (!v) return null;
            if (!/^\d+(\.\d+)?$/.test(v)) return null;
            const [wholeRaw, fracRaw = ""] = v.split(".");
            const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
            const frac = decimals > 0 ? fracRaw.padEnd(decimals, "0").slice(0, decimals) : "";
            try {
              return BigInt(`${whole}${frac}` || "0");
            } catch {
              return null;
            }
          };

          // Gate NFT drops behind explicit server-side toggle and/or explicit test header.
          // This ensures the regular /raceswap page can remain live without NFT drops enabled yet.
          const ENABLE_NFT_DROPS = (process.env.ENABLE_RACESWAP_NFT_DROPS || "").trim() === "1";
          const isTestHeader = String(req.header("x-raceswap-test") || "").trim() === "1";

          // Idempotency: if we already computed/sent for this swap, return stored result.
          // Exception: if stored usdValue is 0, we may have had incomplete data - try to reprocess
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 1: Checking idempotency cache...`);
          const idempotencyStart = Date.now();
          const existing = await getPersistedSwapRewardIfAny({ pgPool: pgPool || null, signature: sig });
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 1 done (${Date.now() - idempotencyStart}ms)`);
          if (existing) {
            // If we have a cached result with 0 USD value, it might be incorrect (RPC returned incomplete data)
            // Only return cached result if it has valid USD value OR rewards were already sent
            const hasRewards = existing.raceReward?.won || existing.cardReward?.won;
            const hasValidUsd = existing.usdValue > 0;
            
            if (hasValidUsd || hasRewards) {
              console.log(`[swap-rewards] Returning cached result for ${sig.slice(0, 16)}..., usdValue=$${existing.usdValue}`);
              return res.json(existing);
            } else {
              console.log(`[swap-rewards] Cached result has $0 USD value, attempting reprocess for ${sig.slice(0, 16)}...`);
              // Continue to reprocess - the new result will update the DB
            }
          }

          // Security + provably-fair seed:
          // - verify fee payer
          // - exclude protocol-driven swaps (escrow/treasury/jackpot) from ALL swap rewards
          // - derive seed from tx recentBlockhash (publicly verifiable), with a best-effort fallback to blockhash-at-slot.
          let verifiedTx: any | null = null;
          let feePayer = "";
          let slot: number | null = null;
          let blockhash: string | null = null;
          // Increased retries and delays for more reliable transaction fetching
          // Total wait time: ~15 seconds max (enough for slow RPCs)
          const maxRetries = 15;
          const baseDelay = 200;
          try {
            // Aggressively retry fetching the full transaction right after confirmation.
            // Sometimes RPCs take several seconds to index newly confirmed transactions.
            for (let attempt = 0; attempt < maxRetries; attempt++) {
              verifiedTx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
              if (verifiedTx) break;
              // Exponential-ish backoff: 200, 400, 600, 800, 1000, 1200... ms
              const delay = baseDelay + attempt * 200;
              if (attempt < maxRetries - 1) {
                console.log(`[swap-rewards] Transaction not found yet, retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
              }
              await new Promise((resolve) => setTimeout(resolve, delay));
            }

            const msg: any = verifiedTx?.transaction?.message as any;
            if (!verifiedTx || !msg) {
              console.log(`[swap-rewards] FAIL: Transaction not found after ${maxRetries} retries (${Date.now() - startTime}ms)`);
              return res.status(502).json({ error: "Unable to verify swap signer; please retry shortly" });
            }
            console.log(`[swap-rewards] Transaction fetched successfully (${Date.now() - startTime}ms)`);

            const keys: string[] = (msg?.staticAccountKeys || msg?.accountKeys || []).map((k: any) =>
              k?.toBase58 ? k.toBase58() : k?.toString ? k.toString() : String(k)
            );
            feePayer = keys?.[0] || "";
            if (!feePayer) {
              return res.status(502).json({ error: "Unable to verify swap signer; please retry shortly" });
            }

            slot = Number.isFinite(Number(verifiedTx?.slot)) ? Number(verifiedTx.slot) : null;
            blockhash = msg?.recentBlockhash ? String(msg.recentBlockhash) : null;

            // Protocol wallets (never eligible for swap rewards)
            const protocolWallets = new Set<string>(
              [serverKeypair.publicKey?.toString?.(), treasuryPubkey?.toString?.(), jackpotPubkey?.toString?.()]
                .map((s) => String(s || "").trim())
                .filter(Boolean)
            );
            if (protocolWallets.has(feePayer)) {
              const ineligible = {
                recipient: recipientStr,
                transactionSignature: sig,
                slot: slot ?? null,
                blockhash: blockhash ?? null,
                seed: blockhash ? String(blockhash) : "",
                usdValue: 0,
                holderBoost: {
                  raceBalanceBase: "0",
                  raceBalanceUi: "0",
                  tier: "none",
                  multiplier: 1,
                  nextTier: null,
                  nextTierTargetUi: null,
                  progressToNext: null,
                },
                raceReward: {
                  won: false,
                  roll: 0,
                  winProbability: 0,
                  rewardAmountBase: null,
                  rewardSignature: null,
                  error: "ineligible: protocol/escrow swap",
                },
                cardReward: {
                  enabled: false,
                  disabledReason: "ineligible: protocol/escrow swap",
                  inventory: { poolSize: 0, poolHash: null },
                  won: false,
                  roll: 0,
                  winProbability: 0,
                  pickRoll: null,
                  pickIndex: null,
                  mint: null,
                  rewardSignature: null,
                  error: "ineligible: protocol/escrow swap",
                },
                error: null,
              };
              // Best-effort persist for idempotency/auditing (safe even if pgPool is absent)
              try {
                await persistSwapRewardResult({ pgPool: pgPool || null, result: ineligible as any }).catch(() => {});
              } catch {}
              return res.json(ineligible);
            }

            // For user swaps, require recipient to match fee payer (prevents claiming with someone else's signature).
            if (feePayer !== recipientStr) {
              return res.status(403).json({ error: "Recipient must match swap fee payer" });
            }

            // Best-effort fallback: if recentBlockhash is missing, try to load the blockhash for the slot.
            if (!blockhash && slot) {
              for (let attempt = 0; attempt < maxRetries && !blockhash; attempt++) {
                try {
                  const block = await connection.getBlock(slot, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
                  blockhash = block?.blockhash ? String(block.blockhash) : null;
                } catch {
                  // ignore
                }
                if (!blockhash) {
                  const delay = baseDelay + attempt * 30;
                  await new Promise((resolve) => setTimeout(resolve, delay));
                }
              }
            }
          } catch {
            // If we cannot verify, fail closed for safety (NFTs are high value).
            return res.status(502).json({ error: "Unable to verify swap signer; please retry shortly" });
          }

          // IMPORTANT: do NOT fall back to using the signature as a seed.
          // A signature can be ground by varying the signed message; a blockhash is a publicly verifiable randomness source.
          if (!blockhash) {
            return res.status(502).json({ error: "Unable to fetch blockhash for provably fair seed; please retry shortly" });
          }

          const seed = String(blockhash);
          const shaRoll = (label: string) => {
            const h = createHash("sha256").update(`${label}|${seed}|${sig}|${recipientStr}`).digest();
            return h.readUInt32BE(0) / 0xffffffff;
          };

          // ---- Hard eligibility gate (server-verified): require >= min SOL or >= min USDC on input OR output ----
          const dropMinSolLamports = parseDecimalToBaseUnits(process.env.RACESWAP_DROP_MIN_SOL || "0.1", 9) ?? 100_000_000n;
          const dropMinUsdcBase = parseDecimalToBaseUnits(process.env.RACESWAP_DROP_MIN_USDC || "10", 6) ?? 10_000_000n;

          // Identifier: require tx to pay Jupiter referral fees (SOL transfer to referral account
          // and/or token balance increase on a token account owned by the referral account).
          const hasReferralFeePayment = (() => {
            const msg: any = verifiedTx?.transaction?.message as any;
            const keys: string[] = (msg?.staticAccountKeys || msg?.accountKeys || []).map((k: any) =>
              k?.toBase58 ? k.toBase58() : k?.toString ? k.toString() : String(k)
            );
            const meta: any = verifiedTx?.meta;

            // 1) Native SOL transfer: balance increase for REFERRAL_ACCOUNT if present in keys
            const idx = keys.findIndex((k) => String(k) === String(REFERRAL_ACCOUNT));
            if (idx >= 0) {
              const pre = meta?.preBalances?.[idx];
              const post = meta?.postBalances?.[idx];
              if (Number.isFinite(pre) && Number.isFinite(post)) {
                const delta = BigInt(Math.max(0, Math.floor(post))) - BigInt(Math.max(0, Math.floor(pre)));
                if (delta > 0n) return true;
              }
            }

            // 2) Token referral fees: detect a net balance increase for the referral recipient.
            //
            // IMPORTANT:
            // - In Solana tx meta, token balances include BOTH an `owner` field (token account owner)
            //   and an `accountIndex` which points into message account keys (the token account address).
            // - Depending on how operators configured JUPITER_REFERRAL_ACCOUNT, it may be either:
            //   a) the referral OWNER address, OR
            //   b) a specific token account address (ATA) that receives fees.
            // We accept either to avoid false negatives where the referral is correct but the identifier check fails.
            const preT = (meta?.preTokenBalances || []) as any[];
            const postT = (meta?.postTokenBalances || []) as any[];
            const sumByMint = (rows: any[]) => {
              const m = new Map<string, bigint>();
              for (const r of rows) {
                const owner = String(r?.owner || "");
                const accountIndex = Number(r?.accountIndex);
                const tokenAccountAddr =
                  Number.isFinite(accountIndex) && accountIndex >= 0 && accountIndex < keys.length
                    ? String(keys[accountIndex] || "")
                    : "";
                const isReferralRecipient =
                  owner === String(REFERRAL_ACCOUNT) || tokenAccountAddr === String(REFERRAL_ACCOUNT);
                if (!isReferralRecipient) continue;
                const mint = String(r?.mint || "");
                if (!mint) continue;
                const amtStr = String(r?.uiTokenAmount?.amount ?? "0");
                let amt = 0n;
                try { amt = BigInt(amtStr); } catch { amt = 0n; }
                m.set(mint, (m.get(mint) ?? 0n) + amt);
              }
              return m;
            };
            const preSum = sumByMint(preT);
            const postSum = sumByMint(postT);
            for (const [mint, postAmt] of postSum.entries()) {
              const preAmt = preSum.get(mint) ?? 0n;
              if (postAmt > preAmt) return true;
            }
            return false;
          })();

          // Additional anti-spoofing: require this transaction to actually invoke an approved swap router program.
          // Without this, an attacker could theoretically craft "swap-like" transfers and send dust to the
          // referral account to satisfy `hasReferralFeePayment`.
          //
          // NOTE: Swaps may be routed through non-Jupiter routers (e.g. DFlow) depending on the user's flow/wallet.
          // We accept a small allowlist of router program IDs and keep it configurable via env.
          const isAllowedSwapRouterTx = (() => {
            const raw = String(process.env.JUPITER_SWAP_PROGRAM_IDS || "").trim();
            // Defaults cover common swap router programs; can be overridden/extended via env if routing changes.
            const defaults = [
              // Jupiter Aggregator
              "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
              "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
              // DFlow Aggregator v4
              "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",
            ];
            const allow = new Set<string>(
              (raw ? raw.split(",") : defaults).map((s) => s.trim()).filter(Boolean)
            );

            const msg: any = verifiedTx?.transaction?.message as any;
            const keys: string[] = (msg?.staticAccountKeys || msg?.accountKeys || []).map((k: any) =>
              k?.toBase58 ? k.toBase58() : k?.toString ? k.toString() : String(k)
            );
            const hasAllowedProgramIdIndex = (programIdIndex: unknown) => {
              const idx = Number(programIdIndex);
              if (!Number.isFinite(idx)) return false;
              const programId = keys?.[idx] ? String(keys[idx]) : "";
              return Boolean(programId && allow.has(programId));
            };

            // Check outer instructions first.
            const outerIx: any[] = (msg?.compiledInstructions || msg?.instructions || []) as any[];
            for (const ix of outerIx) {
              if (hasAllowedProgramIdIndex(ix?.programIdIndex)) return true;
            }

            // Also check inner instructions (some explorers/UI flows show Jupiter at different levels).
            const inner: any[] = ((verifiedTx?.meta as any)?.innerInstructions || []) as any[];
            for (const group of inner) {
              const innerIx: any[] = (group?.instructions || []) as any[];
              for (const ix of innerIx) {
                if (hasAllowedProgramIdIndex(ix?.programIdIndex)) return true;
              }
            }

            // Fallback: scan logs for a router program invocation line.
            const logs: string[] = ((verifiedTx?.meta as any)?.logMessages || []) as any;
            return Array.isArray(logs) && logs.some((l) => {
              const line = String(l || "");
              return Array.from(allow).some((pid) => line.includes(pid));
            });
          })();

          if (!hasReferralFeePayment) {
            return res.status(403).json({ error: "Swap is missing Jupiter referral fee payment (identifier check failed)" });
          }
          if (!isAllowedSwapRouterTx) {
            // Helpful diagnostics for quickly expanding the allowlist as new routers appear.
            try {
              const msg: any = verifiedTx?.transaction?.message as any;
              const keys: string[] = (msg?.staticAccountKeys || msg?.accountKeys || []).map((k: any) =>
                k?.toBase58 ? k.toBase58() : k?.toString ? k.toString() : String(k)
              );
              const outerIx: any[] = (msg?.compiledInstructions || msg?.instructions || []) as any[];
              const innerGroups: any[] = ((verifiedTx?.meta as any)?.innerInstructions || []) as any[];
              const invoked = new Set<string>();
              const maybeAdd = (programIdIndex: unknown) => {
                const idx = Number(programIdIndex);
                if (!Number.isFinite(idx)) return;
                const pid = keys?.[idx] ? String(keys[idx]) : "";
                if (pid) invoked.add(pid);
              };
              for (const ix of outerIx) maybeAdd(ix?.programIdIndex);
              for (const g of innerGroups) {
                const innerIx: any[] = (g?.instructions || []) as any[];
                for (const ix of innerIx) maybeAdd(ix?.programIdIndex);
              }
              console.warn(
                `[raceswap] swap-rewards rejected (unrecognized swap router). sig=${sig} invokedPrograms=${Array.from(invoked).join(",")}`
              );
            } catch {
              // ignore
            }
            return res.status(403).json({ error: "Transaction is not a recognized swap (anti-spoofing check failed)" });
          }

          const computeTokenDeltasBase = (mint: string, owner: string): { spent: bigint; received: bigint; decimals: number | null } => {
            const pre = (verifiedTx?.meta as any)?.preTokenBalances || [];
            const post = (verifiedTx?.meta as any)?.postTokenBalances || [];
            const preMap = new Map<number, bigint>();
            const postMap = new Map<number, bigint>();
            let decimals: number | null = null;

            for (const b of pre) {
              if (String(b?.mint || "") !== mint) continue;
              if (String(b?.owner || "") !== owner) continue;
              const idx = Number(b?.accountIndex);
              const amtStr = String(b?.uiTokenAmount?.amount ?? "0");
              try {
                preMap.set(idx, BigInt(amtStr));
              } catch {
                preMap.set(idx, 0n);
              }
              const d = Number(b?.uiTokenAmount?.decimals);
              if (Number.isFinite(d)) decimals = d;
            }
            for (const b of post) {
              if (String(b?.mint || "") !== mint) continue;
              if (String(b?.owner || "") !== owner) continue;
              const idx = Number(b?.accountIndex);
              const amtStr = String(b?.uiTokenAmount?.amount ?? "0");
              try {
                postMap.set(idx, BigInt(amtStr));
              } catch {
                postMap.set(idx, 0n);
              }
              const d = Number(b?.uiTokenAmount?.decimals);
              if (Number.isFinite(d)) decimals = d;
            }

            const indices = new Set<number>([...preMap.keys(), ...postMap.keys()]);
            let spent = 0n;
            let received = 0n;
            for (const idx of indices) {
              const a = preMap.get(idx) ?? 0n;
              const b = postMap.get(idx) ?? 0n;
              if (a > b) spent += a - b;
              else received += b - a;
            }
            return { spent, received, decimals };
          };

          const computeNativeSolDeltasLamports = (): { spent: bigint; received: bigint } => {
            const meta: any = verifiedTx?.meta;
            const pre0 = meta?.preBalances?.[0];
            const post0 = meta?.postBalances?.[0];
            if (!Number.isFinite(pre0) || !Number.isFinite(post0)) return { spent: 0n, received: 0n };
            const pre = BigInt(Math.max(0, Math.floor(pre0)));
            const post = BigInt(Math.max(0, Math.floor(post0)));
            const spent = pre > post ? pre - post : 0n;
            const received = post > pre ? post - pre : 0n;
            return { spent, received };
          };

          const nativeSol = computeNativeSolDeltasLamports();
          const wsol = computeTokenDeltasBase(SOL_MINT, recipientStr); // wrapped SOL mint
          const solMovedLamports = (nativeSol.spent > nativeSol.received ? nativeSol.spent : nativeSol.received) > (wsol.spent > wsol.received ? wsol.spent : wsol.received)
            ? (nativeSol.spent > nativeSol.received ? nativeSol.spent : nativeSol.received)
            : (wsol.spent > wsol.received ? wsol.spent : wsol.received);
          const usdcD = computeTokenDeltasBase(USDC_MINT, recipientStr);
          const usdcMovedBase = usdcD.spent > usdcD.received ? usdcD.spent : usdcD.received;
          const eligibleForDrops = solMovedLamports >= dropMinSolLamports || usdcMovedBase >= dropMinUsdcBase;

          // ---- USD value (copied from boosted-reward to keep economics consistent) ----
          const STABLECOIN_MINTS = new Set([
            USDC_MINT, // USDC
            "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
            "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3YaFT", // UXD
            "A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM", // USDC.e
            "EchesyfXePKdLtoiZSL8pBe8Myagyy8ZRqsACNCFGnvp", // FIDA (kept for backward-compat)
          ]);
          const meta: any = verifiedTx?.meta;
          const preT = (meta?.preTokenBalances || []) as any[];
          const postT = (meta?.postTokenBalances || []) as any[];
          const sumOwnerByMint = (rows: any[], owner: string) => {
            const m = new Map<string, { amount: bigint; decimals: number | null }>();
            for (const r of rows) {
              if (String(r?.owner || "") !== owner) continue;
              const mint = String(r?.mint || "");
              if (!mint) continue;
              const amtStr = String(r?.uiTokenAmount?.amount ?? "0");
              const dec = Number(r?.uiTokenAmount?.decimals);
              let amt = 0n;
              try { amt = BigInt(amtStr); } catch { amt = 0n; }
              const prev = m.get(mint);
              m.set(mint, {
                amount: (prev?.amount ?? 0n) + amt,
                decimals: Number.isFinite(dec) ? dec : (prev?.decimals ?? null),
              });
            }
            return m;
          };
          const preSum = sumOwnerByMint(preT, recipientStr);
          const postSum = sumOwnerByMint(postT, recipientStr);
          const allMints = new Set<string>([...preSum.keys(), ...postSum.keys()]);

          const spentCandidates: Array<{ mint: string; spentBase: bigint; decimals: number }> = [];
          for (const mint of allMints) {
            const preAmt = preSum.get(mint)?.amount ?? 0n;
            const postAmt = postSum.get(mint)?.amount ?? 0n;
            if (preAmt > postAmt) {
              const d = postSum.get(mint)?.decimals ?? preSum.get(mint)?.decimals ?? null;
              spentCandidates.push({ mint, spentBase: preAmt - postAmt, decimals: Number.isFinite(d as any) ? Number(d) : 6 });
            }
          }
          // Include native SOL spent as a candidate (fee payer index 0)
          if (nativeSol.spent > 0n) {
            spentCandidates.push({ mint: SOL_MINT, spentBase: nativeSol.spent, decimals: 9 });
          }

          const receivedCandidates: Array<{ mint: string; receivedBase: bigint }> = [];
          for (const mint of allMints) {
            const preAmt = preSum.get(mint)?.amount ?? 0n;
            const postAmt = postSum.get(mint)?.amount ?? 0n;
            if (postAmt > preAmt) {
              receivedCandidates.push({ mint, receivedBase: postAmt - preAmt });
            }
          }
          // Also treat native SOL received as a "received asset" for token->SOL swaps
          if (nativeSol.received > 0n) {
            receivedCandidates.push({ mint: SOL_MINT, receivedBase: nativeSol.received });
          }

          // Must look like a swap: some asset spent and some (different) asset received.
          const swapLike = spentCandidates.some((s) => s.spentBase > 0n) &&
            receivedCandidates.some((r) => r.receivedBase > 0n && !spentCandidates.some((s) => s.mint === r.mint));
          if (!swapLike) {
            return res.status(403).json({ error: "Transaction does not look like a swap" });
          }

          let usdValue = 0;
          
          // Debug logging for swap USD calculation
          console.log(`[swap-rewards] Processing sig=${sig.slice(0, 16)}... recipient=${recipientStr.slice(0, 8)}...`);
          console.log(`[swap-rewards] Spent candidates: ${spentCandidates.length}`);
          
          for (const c of spentCandidates) {
            const isStablecoin = STABLECOIN_MINTS.has(String(c.mint));
            const isSol = String(c.mint) === SOL_MINT;
            const hr = Number(c.spentBase) / Math.pow(10, Number.isFinite(c.decimals) ? c.decimals : 6);
            let candidateUsd = 0;
            
            console.log(`[swap-rewards] Candidate: mint=${c.mint.slice(0, 8)}..., spent=${c.spentBase.toString()}, decimals=${c.decimals}, hr=${hr}, isStablecoin=${isStablecoin}, isSol=${isSol}`);
            
            if (isStablecoin) {
              candidateUsd = hr;
              console.log(`[swap-rewards] -> Stablecoin, USD=${candidateUsd}`);
            } else {
              try {
                const stats = await getTokenStats(String(c.mint));
                const priceUsd = stats.currentPriceUsd || 0;
                if (priceUsd > 0) {
                  candidateUsd = hr * (priceUsd > 10000 ? Math.min(priceUsd, 1000) : priceUsd);
                  console.log(`[swap-rewards] -> Token price $${priceUsd}, USD=${candidateUsd}`);
                } else if (isSol) {
                  const solStats = await getTokenStats(SOL_MINT).catch(() => null);
                  const solPrice = solStats?.currentPriceUsd || 150;
                  candidateUsd = hr * solPrice;
                  console.log(`[swap-rewards] -> SOL price $${solPrice}, USD=${candidateUsd}`);
                } else {
                  candidateUsd = Math.min(hr * 0.0001, 10);
                  console.log(`[swap-rewards] -> Unknown token, fallback USD=${candidateUsd}`);
                }
              } catch (priceErr) {
                candidateUsd = isSol ? hr * 150 : Math.min(hr * 0.0001, 10);
                console.log(`[swap-rewards] -> Price fetch error, fallback USD=${candidateUsd}`, priceErr);
              }
            }
            if (candidateUsd > usdValue) usdValue = candidateUsd;
          }
          const MAX_USD_VALUE = 10000;
          if (usdValue > MAX_USD_VALUE) usdValue = MAX_USD_VALUE;
          
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Final USD value: $${usdValue}`);

          // ---- Verified holder boost ----
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 2: Getting holder boost...`);
          const holderBoostStart = Date.now();
          const holderBoost = await getVerifiedHolderBoost({ connection, recipient: recipientStr, raceMintAddress });
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 2 done (${Date.now() - holderBoostStart}ms)`);

          // ---- Card pool (DB-backed, allowlist-only) ----
          const envAllowlist = String(process.env.POKEMON_CARD_MINT_ALLOWLIST || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const allowlistSet = new Set(envAllowlist);
          const hasAllowlist = envAllowlist.length > 0;
          const hasPg = Boolean(pgPool);

          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 3: Getting card pool...`);
          const cardPoolStart = Date.now();
          let { mints: poolMints, poolHash } = await getAvailableCardPool({
            pgPool: pgPool || null,
            fallbackAllowlist: envAllowlist,
          });
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 3 done (${Date.now() - cardPoolStart}ms)`);
          // Safety: never auto-discover all escrow NFTs (anyone can send junk NFTs to escrow).
          // If you want discovery, do it offline via the seed script with an allowlist constraint.
          if (hasAllowlist && poolMints.length > 0) {
            poolMints = poolMints.filter((m) => allowlistSet.has(m));
            poolHash = poolMints.length ? createHash("sha256").update(`pool|${poolMints.join(",")}`).digest("hex") : null;
          }

          const poolSize = poolMints.length;

          // ---- Probabilities (RACE higher than cards) ----
          // RACE bonus: base 1.25% + scales with size up to 4% (before boost caps)
          const raceBase = 0.0125;
          const raceScaled = Math.min((usdValue / 500) * 0.002, 0.04);
          // Apply holder boost partially to RACE (to keep economics sane)
          const raceBoostMultiplier = 1 + (holderBoost.multiplier - 1) * 0.5;
          const raceWinProbability = eligibleForDrops ? Math.min((raceBase + raceScaled) * raceBoostMultiplier, 0.08) : 0;

          // Card drop: 1-in-N per 1 SOL swap (scales linearly with swap size in SOL-equivalent),
          // and is disabled if pool empty.
          // Best practice: require both allowlist + Postgres so we have strict eligibility + "sent" tracking.
          const cardEnabled = eligibleForDrops && (ENABLE_NFT_DROPS || isTestHeader) && hasAllowlist && hasPg && poolSize > 0;
          const cardDisabledReason = cardEnabled
            ? null
            : !eligibleForDrops
              ? "below_minimum_swap"
              : !(ENABLE_NFT_DROPS || isTestHeader)
              ? "disabled_via_env"
              : !hasAllowlist
                ? "missing_allowlist"
                : !hasPg
                  ? "missing_database"
                  : poolSize <= 0
                    ? "inventory_empty"
                    : "disabled";
          // Default: 1 in 80 per 1 SOL swap (optimized for 2.5% Gacha Treasury Fee).
          // Old system was 1 in 400, with 5x revenue increase we give 5x better odds.
          const DEFAULT_SOL_PRICE_USD = 122.67;
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 4: Getting SOL price...`);
          const solPriceStart = Date.now();
          const solStats = await getTokenStats(SOL_MINT).catch(() => null);
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 4 done (${Date.now() - solPriceStart}ms)`);
          const solPriceUsdRaw = Number(solStats?.currentPriceUsd || DEFAULT_SOL_PRICE_USD);
          const solPriceUsd =
            Number.isFinite(solPriceUsdRaw) && solPriceUsdRaw > 0 ? solPriceUsdRaw : DEFAULT_SOL_PRICE_USD;

          const oneInPerSolRaw = Number(process.env.CARD_DROP_ONE_IN_PER_SOL || "80");
          const oneInPerSol =
            Number.isFinite(oneInPerSolRaw) && oneInPerSolRaw > 0 ? oneInPerSolRaw : 80;

          const capRaw = Number(process.env.CARD_DROP_PROBABILITY_CAP || "0.25");
          const cardProbabilityCap =
            Number.isFinite(capRaw) && capRaw > 0 ? Math.min(capRaw, 1) : 0.25;

          const solEquivalent = solPriceUsd > 0 ? usdValue / solPriceUsd : 0;
          const baseProbability = solEquivalent > 0 ? solEquivalent / oneInPerSol : 0;
          
          // Get FUEL boost multiplier (stacks with holder boost)
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 5: Getting FUEL boost...`);
          const fuelBoostStart = Date.now();
          let fuelMultiplier = 1.0;
          try {
            const { getFuelBoostMultiplier } = await import('./quests');
            fuelMultiplier = await getFuelBoostMultiplier(recipientStr);
          } catch {
            // Quest system not available, use default multiplier
          }
          console.log(`[swap-rewards] [${sig.slice(0,8)}] Step 5 done (${Date.now() - fuelBoostStart}ms)`);
          
          // Combined multiplier = holder boost * FUEL boost (conservative stacking)
          // Cap combined multiplier at 2.5x to prevent excessive boosting
          const combinedMultiplier = Math.min(holderBoost.multiplier * fuelMultiplier, 2.5);
          
          let cardWinProbability = cardEnabled
            ? Math.min(baseProbability * combinedMultiplier, cardProbabilityCap)
            : 0;

          // TEST-ONLY: promo wallet override for validating NFT drops end-to-end.
          // This is deliberately server-side (cannot be spoofed by the client) and still requires fee-payer verification.
          const NFT_PROMO_WALLET = "khKdxhk28vVVKEsTtDWtL19gNcFY9C1gsPsbN5XvajU";
          if (cardEnabled && recipientStr === NFT_PROMO_WALLET) {
            const promoMult = Number(process.env.NFT_PROMO_MULTIPLIER || "50"); // default 50x for testing
            const cap = Number(process.env.NFT_PROMO_CAP || "0.25"); // cap at 25% for safety
            if (Number.isFinite(promoMult) && promoMult > 1) {
              cardWinProbability = Math.min(cardWinProbability * promoMult, cap);
            }
          }

          const raceRoll = shaRoll("race");
          const cardRoll = shaRoll("card");

          // Mutually exclusive rewards (with deterministic fallback):
          // - We *roll* for both card + $RACE for transparency.
          // - Cards are rarer and are attempted first.
          // - If card delivery fails, we can still award $RACE if its roll also won (no double rewards).
          const cardRolledWin = cardRoll < cardWinProbability;
          const raceRolledWin = raceRoll < raceWinProbability;

          // Card selection + transfer (attempt first)
          let cardPickRoll: number | null = null;
          let cardPickIndex: number | null = null;
          let cardMint: string | null = null;
          let cardRewardSig: string | null = null;
          let cardError: string | null = null;
          let cardDelivered = false;

          if (cardRolledWin && cardEnabled) {
            try {
              cardPickRoll = shaRoll("card-pick");
              cardPickIndex = Math.min(Math.floor(cardPickRoll * poolSize), Math.max(0, poolSize - 1));
              // If a picked mint is unexpectedly unavailable (inventory changed), retry a small number of times
              // by walking forward through the sorted pool (wraparound). This avoids "you won but delivery failed"
              // when the escrow inventory is mid-update.
              const to = new PublicKey(recipientStr);
              const maxAttempts = Math.min(3, poolSize);
              let deliveredIndex: number | null = null;

              for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const idx = (cardPickIndex + attempt) % poolSize;
                const candidate = poolMints[idx];
                if (!candidate) continue;
                try {
                  const mintPk = new PublicKey(candidate);
                  const sigTx = await transferFromEscrow({
                    mint: mintPk,
                    to,
                    amount: 1n,
                    memo: `Raceswap Reward (NFT) - ${sig.slice(0, 8)}`,
                  });
                  cardMint = candidate;
                  cardRewardSig = sigTx;
                  deliveredIndex = idx;
                  cardDelivered = true;

                  if (pgPool) {
                    await pgPool
                      .query(
                        `UPDATE raceswap_nft_pool
                         SET sent = TRUE, sent_to = $2, sent_sig = $3, sent_at = $4
                         WHERE mint = $1`,
                        [candidate, recipientStr, sigTx, Date.now()]
                      )
                      .catch(() => {});
                  }
                  break;
                } catch (inner: any) {
                  const msg = String(inner?.message || inner || "");
                  // Only retry on likely "inventory already moved" scenarios.
                  const retryable =
                    /insufficient|not found|could not find|does not exist|owner does not match|0 balance/i.test(msg);
                  if (!retryable || attempt === maxAttempts - 1) {
                    throw inner;
                  }
                }
              }

              if (deliveredIndex !== null) {
                cardPickIndex = deliveredIndex;
              }
              
              // Send Telegram notification for card win (fire-and-forget)
              if (cardDelivered && cardMint && cardRewardSig) {
                (async () => {
                  try {
                    const { notifyTelegramWithAsset } = await import('./telegram');
                    const { fetchCardMetadataForNotification } = await import('./card-notifications');
                    
                    const shortRecipient = `${recipientStr.slice(0, 4)}...${recipientStr.slice(-4)}`;
                    const solscanTxUrl = `https://solscan.io/tx/${cardRewardSig}`;
                    const solscanNftUrl = `https://solscan.io/token/${cardMint}`;
                    
                    // Fetch card metadata (name, image, value)
                    const cardMeta = await fetchCardMetadataForNotification(cardMint!);
                    const cardName = cardMeta?.name || `Card ${cardMint!.slice(0, 6)}...`;
                    const cardValue = cardMeta?.insuredValueUsd;
                    const cardImage = cardMeta?.image;
                    
                    // Format boost tier nicely
                    const boostTierLabel = holderBoost.tier === 'none' ? 'None' : holderBoost.tier.toUpperCase();
                    const boostMultiplierLabel = `x${holderBoost.multiplier.toFixed(2)}`;
                    
                    const message = [
                      `🃏 CARD DROP! 🎉`,
                      ``,
                      `A Pokémon card was just won via RaceSwap!`,
                      ``,
                      `🎴 ${cardName}`,
                      cardValue ? `💎 Card Value: $${cardValue.toLocaleString()}` : null,
                      ``,
                      `🏆 Winner: ${shortRecipient}`,
                      `💰 Swap Value: $${usdValue.toFixed(2)}`,
                      `⚡ Holder Boost: ${boostTierLabel} (${boostMultiplierLabel})`,
                      `🎲 Roll: ${cardRoll.toFixed(6)} < ${cardWinProbability.toFixed(6)}`,
                      ``,
                      `🔗 TX: ${solscanTxUrl}`,
                      `🖼️ View Card: ${solscanNftUrl}`,
                    ].filter(Boolean).join('\n');
                    
                    await notifyTelegramWithAsset(message, cardImage || null);
                    console.log(`[raceswap] ✅ Card win notification sent for ${cardMint} (${cardName})`);
                  } catch (tgErr: any) {
                    console.error(`[raceswap] Failed to send card win notification:`, tgErr?.message || tgErr);
                  }
                })();
              }
            } catch (e: any) {
              cardError = e?.message || "Failed to send card";
            }
          }

          // RACE reward is attempted only if we did NOT successfully deliver a card.
          const raceWon = !cardDelivered && raceRolledWin;
          let raceRewardAmountBase: string | null = null;
          let raceRewardSig: string | null = null;
          let raceError: string | null = null;

          // RACE reward size (keep original structure but slightly higher baseline)
          if (raceWon) {
            try {
              const baseReward = 50000; // was 25,000
              const scaledReward = Math.min(usdValue * 600, 650000); // was 500 per $1 capped at 475k
              const totalReward = baseReward + scaledReward;
              const amountBase = BigInt(Math.floor(totalReward * 1e6));
              raceRewardAmountBase = amountBase.toString();

              if (!raceMintAddress) throw new Error("RACE mint not configured");
              const raceMint = new PublicKey(raceMintAddress);
              const to = new PublicKey(recipientStr);
              raceRewardSig = await transferFromEscrow({
                mint: raceMint,
                to,
                amount: amountBase,
                memo: `Raceswap Reward (RACE) - ${sig.slice(0, 8)}`,
              });
            } catch (e: any) {
              raceError = e?.message || "Failed to send RACE reward";
            }
          }

          const payload = {
            recipient: recipientStr,
            transactionSignature: sig,
            slot,
            blockhash,
            seed,
            usdValue,
            holderBoost,
            raceReward: {
              won: raceWon && !raceError,
              roll: raceRoll,
              winProbability: raceWinProbability,
              rewardAmountBase: raceWon ? raceRewardAmountBase : null,
              rewardSignature: raceRewardSig,
              error: raceError,
            },
            cardReward: {
              enabled: cardEnabled,
              disabledReason: cardEnabled ? null : cardDisabledReason,
              inventory: { poolSize, poolHash },
              won: cardDelivered && !cardError && Boolean(cardMint) && Boolean(cardRewardSig),
              roll: cardRoll,
              winProbability: cardWinProbability,
              pickRoll: cardPickRoll,
              pickIndex: cardPickIndex,
              mint: cardMint,
              rewardSignature: cardRewardSig,
              error: cardError,
            },
            error: null,
          };

          // Extract primary input/output mints for quest tracking
          // Prefer non-SOL/non-stablecoin mints (the "interesting" tokens being swapped)
          const pickPrimaryMint = (candidates: Array<{ mint: string }>, exclude: Set<string>): string | undefined => {
            const interesting = candidates.find(c => !exclude.has(c.mint));
            return interesting?.mint || candidates[0]?.mint;
          };
          const skipMints = new Set([SOL_MINT, ...STABLECOIN_MINTS]);
          const primaryInputMint = pickPrimaryMint(spentCandidates, skipMints);
          const primaryOutputMint = pickPrimaryMint(receivedCandidates, skipMints);

          // Persist final result for idempotency/auditing (best-effort)
          await persistSwapRewardResult({ pgPool: pgPool || null, result: payload, inputMint: primaryInputMint, outputMint: primaryOutputMint }).catch(() => {});

          // Update quest progress/streak after successful swap (best-effort, non-blocking)
          try {
            const { handleSwapComplete } = await import('./quests');
            handleSwapComplete(recipientStr, usdValue).catch(() => {});
          } catch {
            // Quest system not available, skip
          }

          // Process swap referral rewards (best-effort, non-blocking)
          // SECURITY: usdValue is calculated from ON-CHAIN token balance changes (validated above)
          // SECURITY: Platform fee is calculated server-side, not from client data
          // SECURITY: Minimum $5 swap required to prevent dust attacks (checked in swap-referrals.ts)
          // SECURITY: Swap signature is unique key for idempotency
          if (usdValue >= 5.0) {
            try {
              const { computeSwapReferralRewards } = await import('./swap-referrals');
              // Calculate platform fee: 2.5% total fee, Jupiter takes 20%, we keep 80% = 2%
              // Fee is collected in the output token (usually SOL when SOL is involved)
              const solStats = await getTokenStats(SOL_MINT).catch(() => null);
              const solPriceUsd = solStats?.currentPriceUsd || 150;
              // Platform fee = 2% of swap volume (after Jupiter's 20% cut of 2.5% total)
              const platformFeeUsd = usdValue * 0.02;
              const platformFeeSol = platformFeeUsd / solPriceUsd;
              
              // Fire and forget - don't block swap completion
              computeSwapReferralRewards({
                swapSignature: sig,  // UNIQUE - ensures idempotency
                swapperWallet: recipientStr,  // From on-chain fee payer validation
                swapVolumeUsd: usdValue,  // From on-chain balance changes
                platformFeeSol,  // Calculated server-side
              }).catch((err: any) => {
                console.warn('[swap-rewards] Referral reward computation failed:', err?.message);
              });
            } catch (err) {
              // Swap referral system not available, skip
            }
          }

          console.log(`[swap-rewards] SUCCESS sig=${sig.slice(0, 16)}... usd=$${payload.usdValue.toFixed(2)} race=${payload.raceReward.won} card=${payload.cardReward.won} (${Date.now() - startTime}ms)`);
          return res.json(payload);
        } catch (error: any) {
          const elapsed = Date.now() - (typeof startTime !== 'undefined' ? startTime : Date.now());
          console.error(`[swap-rewards] ERROR after ${elapsed}ms:`, error?.message || error);
          console.error(`[swap-rewards] Stack:`, error?.stack?.split('\n').slice(0, 3).join('\n'));
          return res.status(500).json({ error: error?.message || "Failed to process swap rewards" });
        }
      });

      // Fast, cached holder boost endpoint (verified on-chain)
      app.get("/api/raceswap/holder-boost", async (req, res) => {
        try {
          const wallet = String((req.query as any)?.wallet || "").trim();
          if (!wallet) return res.status(400).json({ error: "wallet is required" });
          const { connection, raceMintAddress } = await import("./solana");
          const { getVerifiedHolderBoost } = await import("./raceswap-swap-rewards");
          const holderBoost = await getVerifiedHolderBoost({ connection, recipient: wallet, raceMintAddress });
          res.json(holderBoost);
        } catch (error: any) {
          res.status(500).json({ error: error?.message || "Failed to fetch holder boost" });
        }
      });

      // Server-provided allowlist hook (so the client doesn't hardcode high-value mints).
      // If DB pool exists, returns all mints still enabled (including already-sent ones can be added later).
      app.get("/api/raceswap/pokemon-card-allowlist", async (_req, res) => {
        try {
          const { pgPool } = await import("./db/clients");
          const envAllowlist = String(process.env.POKEMON_CARD_MINT_ALLOWLIST || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const allowSet = new Set(envAllowlist);

          // Display list should be curated (env allowlist). If empty, return empty by default.
          const mints = envAllowlist;

          // Droppable list comes from DB (enabled & unsent), intersected with curated allowlist.
          let droppableMints: string[] = [];
          if (pgPool && envAllowlist.length > 0) {
            try {
              const r = await pgPool.query(
                `SELECT mint FROM raceswap_nft_pool WHERE enabled = TRUE AND sent = FALSE ORDER BY mint ASC`
              );
              droppableMints = (r.rows || [])
                .map((row: any) => String(row.mint || "").trim())
                .filter((mint: string) => Boolean(mint) && allowSet.has(mint));
            } catch {
              droppableMints = [];
            }
          }

          res.json({ mints, droppableMints });
        } catch (error: any) {
          res.status(500).json({ error: error?.message || "Failed to fetch allowlist" });
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

  // -------- Swap Referrals API --------
  // Separate referral system for swap&rip feature
  
  // Get swap referral settings
  app.get('/api/swap-referrals/settings', async (req, res) => {
    try {
      const { getSwapReferralSettings } = await import('./swap-referrals');
      const settings = await getSwapReferralSettings();
      res.json(settings);
    } catch (e: any) {
      console.error('[swap-referrals/settings] Error:', e);
      res.status(500).json({ error: 'Failed to get settings' });
    }
  });

  // Record swap referral attribution (called when user visits with ?ref= and connects wallet)
  app.post('/api/swap-referrals/track', async (req, res) => {
    try {
      const code = String((req.body?.code || '').toString().trim());
      const wallet = String((req.body?.wallet || '').toString().trim());
      
      if (!code || !wallet) {
        return res.status(400).json({ error: 'code and wallet required' });
      }
      
      const { recordSwapAttribution, normalizeCode } = await import('./swap-referrals');
      const normalizedCode = normalizeCode(code);
      
      if (!normalizedCode) {
        return res.status(400).json({ error: 'Invalid referral code' });
      }
      
      const attribution = await recordSwapAttribution({
        swapperWallet: wallet,
        referrerCode: normalizedCode,
      });
      
      res.json({ 
        success: !!attribution,
        attribution: attribution || null,
      });
    } catch (e: any) {
      console.error('[swap-referrals/track] Error:', e);
      res.status(500).json({ error: 'Failed to track attribution' });
    }
  });

  // Get swap referral summary for a wallet
  app.get('/api/swap-referrals/summary/:wallet', async (req, res) => {
    try {
      const wallet = String(req.params.wallet).trim();
      if (!wallet) {
        return res.status(400).json({ error: 'wallet required' });
      }
      
      const { getSwapReferralSummary } = await import('./swap-referrals');
      const summary = await getSwapReferralSummary(wallet);
      res.json(summary);
    } catch (e: any) {
      console.error('[swap-referrals/summary] Error:', e);
      res.status(500).json({ error: 'Failed to get summary' });
    }
  });

  // Get swap attribution for a specific swapper wallet
  app.get('/api/swap-referrals/attribution/:wallet', async (req, res) => {
    try {
      const wallet = String(req.params.wallet).trim();
      if (!wallet) {
        return res.status(400).json({ error: 'wallet required' });
      }
      
      const { getSwapAttribution } = await import('./swap-referrals');
      const attribution = await getSwapAttribution(wallet);
      res.json({ 
        isReferred: !!attribution,
        attribution: attribution || null,
      });
    } catch (e: any) {
      console.error('[swap-referrals/attribution] Error:', e);
      res.status(500).json({ error: 'Failed to get attribution' });
    }
  });

  // Get count of users referred by this wallet (for display)
  app.get('/api/swap-referrals/referred-count/:wallet', async (req, res) => {
    try {
      const wallet = String(req.params.wallet).trim();
      if (!wallet) {
        return res.status(400).json({ error: 'wallet required' });
      }
      
      const { getReferredSwappersCount } = await import('./swap-referrals');
      const count = await getReferredSwappersCount(wallet);
      res.json({ count });
    } catch (e: any) {
      console.error('[swap-referrals/referred-count] Error:', e);
      res.status(500).json({ error: 'Failed to get count' });
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

  // Token stats endpoint — DexScreener primary, Jupiter V3 fallback
  // NO GeckoTerminal. Server-side cached 30s, client-side cached 30s.
  app.get('/api/token-stats', async (req, res) => {
    try {
      const mint = String((req.query.mint || '') as string).trim();
      if (!mint) {
        return res.status(400).json({ error: 'mint required' });
      }
      const poolParam = String((req.query.pool || req.query.poolAddress || '') as string).trim();
      const pool = poolParam || undefined;
      const { getTokenStatsWithFallbacks } = await import('./dexscreener-ohlcv');
      const stats = await getTokenStatsWithFallbacks(mint, pool);
      res.set('Cache-Control', 'public, max-age=30');
      res.json(stats);
    } catch (e: any) {
      console.error('token-stats error:', e?.message || e);
      res.status(500).json({ error: 'Failed to fetch token stats' });
    }
  });

  // Price history endpoint for swap page charts
  // FAST PATH: DexScreener only (no GeckoTerminal in this path at all)
  // Server-side: 5 min NodeCache | Client-side: 15 min Cache-Control
  app.get('/api/token-price-history', async (req, res) => {
    try {
      const mint = req.query.mint as string;
      const hours = Math.min(parseInt(req.query.hours as string || '24', 10), 168);
      const poolParam = typeof req.query.pool === 'string' ? req.query.pool.trim() : '';
      const explicitPool = poolParam.length > 0 ? poolParam : undefined;
      
      if (!mint) {
        return res.status(400).json({ error: 'Missing mint parameter' });
      }

      const { getSwapChartData } = await import('./dexscreener-ohlcv');
      const candles = await getSwapChartData(mint, hours, explicitPool);
      
      const prices = candles.map(c => ({ timestamp: c.timestamp, price: c.close }));

      // Aggressive browser caching — chart data is approximate anyway
      res.set('Cache-Control', 'public, max-age=900, s-maxage=600');
      res.json({ prices });
    } catch (error: any) {
      console.error('Price history error:', error?.message || error);
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ prices: [] });
    }
  });

  // Batch token prices for swap token list (Jupiter Price API V3 primary).
  // IMPORTANT: Does not affect Jupiter Ultra quotes/swaps and does not touch /api/token-stats*
  // (those remain GeckoTerminal-backed for race UI + charts).
  app.post('/api/token-prices/batch', async (req, res) => {
    try {
      const { mints } = req.body;
      if (!Array.isArray(mints) || mints.length === 0) {
        return res.status(400).json({ error: 'mints array required' });
      }
      // Prevent abuse; Jupiter supports 50 ids/request, but our server chunks internally.
      if (mints.length > 200) {
        return res.status(400).json({ error: 'Maximum 200 mints per batch' });
      }

      const unique = Array.from(new Set(mints.map((m: any) => String(m || '').trim()).filter(Boolean)));
      const { getJupiterPricesV3 } = await import('./jupiter');
      const jup = await getJupiterPricesV3(unique);

      // Fill gaps with the existing fast provider (DexScreener) instead of the slow GeckoTerminal batch path.
      const missing = unique.filter(m => !jup.has(m));
      const fallback = new Map<string, number>();
      if (missing.length > 0) {
        const { getFastPriceForMint } = await import('./fast-prices');
        await Promise.allSettled(
          missing.map(async (mint: string) => {
            const p = await getFastPriceForMint(mint);
            if (typeof p === 'number' && p > 0) fallback.set(mint, p);
          })
        );
      }

      const prices = unique.map((mint) => {
        const entry = jup.get(mint);
        if (entry) {
          return {
            mint,
            priceUsd: entry.usdPrice,
            blockId: entry.blockId,
            decimals: entry.decimals,
            priceChange24h: entry.priceChange24h ?? null,
            source: 'jupiter_v3',
          };
        }
        const fp = fallback.get(mint);
        return {
          mint,
          priceUsd: typeof fp === 'number' ? fp : 0,
          blockId: null,
          decimals: null,
          priceChange24h: null,
          source: typeof fp === 'number' ? 'dexscreener' : 'none',
        };
      });

      res.set('Cache-Control', 'public, max-age=30');
      res.json({ prices });
    } catch (e: any) {
      console.error('token-prices batch error:', e);
      res.status(500).json({ error: 'Failed to fetch token prices batch' });
    }
  });

  app.post('/api/token-stats/batch', async (req, res) => {
    try {
      const { mints } = req.body;
      if (!Array.isArray(mints) || mints.length === 0) {
        return res.status(400).json({ error: 'mints array required' });
      }
      if (mints.length > 200) {
        return res.status(400).json({ error: 'Maximum 200 mints per batch' });
      }
      const { getTokenStatsBatch } = await import('./dexscreener-ohlcv');
      const stats = await getTokenStatsBatch(mints);
      res.set('Cache-Control', 'public, max-age=30');
      res.json({ stats });
    } catch (e: any) {
      console.error('token-stats batch error:', e?.message || e);
      res.status(500).json({ error: 'Failed to fetch token stats batch' });
    }
  });

  // Race routes
  // PERFORMANCE: This endpoint is optimized to only fetch active races by default.
  // The database query now only returns OPEN, LOCKED, IN_PROGRESS races (not thousands of settled ones).
  // Server-side caching (3s TTL) further reduces database load for concurrent requests.
    app.get("/api/races", async (req, res) => {
      try {
        const { status } = req.query;
        const cacheKey = `races:${status || 'active'}`;
        
        // Check cache first (3 second TTL)
        const cached = racesCache.get<any[]>(cacheKey);
        if (cached) {
          return res.json(cached);
        }
        
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

        // Cache the result for 3 seconds
        racesCache.set(cacheKey, racesWithTotals);
        res.json(racesWithTotals);
      } catch (error) {
        console.error("Get races error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

  // OHLCV verification for race fairness (GeckoTerminal primary, DexScreener fallback)
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

      // Import functions - try GeckoTerminal first, DexScreener as fallback
      const { getTokenOHLCV, calculateOHLCVPriceChange, getGeckoTerminalChartUrl } = 
        await import('./geckoterminal');

      // Derive verification window from actual race timing
      // Prefer precise block timestamps captured during LOCK and SETTLE
      const startMs = race.lockedBlockTimeMs || race.lockedTs || race.startTs;
      const endMs = race.settledBlockTimeMs || (race.lockedTs ? (race.lockedBlockTimeMs || race.lockedTs) + 20 * 60 * 1000 : race.startTs + 20 * 60 * 1000);
      const durationMs = Math.max(10 * 1000, (endMs - startMs));
      const raceDurationMinutes = Math.max(1, Math.ceil(durationMs / 60000));
      
      // Get OHLCV data for all runners (try GeckoTerminal, fallback to DexScreener live prices)
      const ohlcvResults = await Promise.allSettled(
        race.runners.map(async (runner) => {
          try {
            const candles = await getTokenOHLCV(runner.mint, startMs, raceDurationMinutes, runner.poolAddress);
            if (candles.length > 0) {
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
            }
          } catch (e) {
            // GeckoTerminal failed (likely 429), continue to fallback
            console.warn(`[OHLCV verify] GeckoTerminal failed for ${runner.symbol}, using DexScreener fallback`);
          }
          
          // Fallback: use DexScreener live price to compute change from baseline
          const { getFastPriceForMint } = await import('./fast-prices');
          const livePrice = await getFastPriceForMint(runner.mint);
          const baseline = runner.initialPriceUsd || runner.initialPrice || 0;
          const finalPrice = (typeof livePrice === 'number' && livePrice > 0) ? livePrice : baseline;
          const priceChange = baseline > 0 ? ((finalPrice - baseline) / baseline) * 100 : 0;
          
          return {
            mint: runner.mint,
            symbol: runner.symbol,
            name: runner.name,
            candles: 0,
            startPrice: baseline,
            endPrice: finalPrice,
            priceChange,
            verified: false,
            chartUrl: `https://dexscreener.com/solana/${runner.mint}`,
            source: 'dexscreener-fallback'
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
            chartUrl: `https://dexscreener.com/solana/${race.runners[index].mint}`,
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
      // Try GeckoTerminal first; if it fails (429), use DexScreener live price as a single-point fallback
      const { getTokenOHLCV } = await import('./geckoterminal');

      let dataSource = 'GeckoTerminal OHLCV';
      const runnerHistories = await Promise.all(
        race.runners.map(async (runner: any, runnerIndex: number) => {
          try {
            let candles: any[] = [];
            try {
              candles = await getTokenOHLCV(runner.mint, startMs, durationMinutes, runner.poolAddress);
            } catch (e) {
              console.warn(`history: GeckoTerminal OHLCV failed for ${runner.mint}, using DexScreener fallback`);
              dataSource = 'DexScreener fallback';
            }

            // Establish baseline from lock (prefer stored baseline if present)
            const baseline =
              runner.initialPriceUsd || runner.initialPrice || (candles[0]?.open ?? 0);
            
            if (candles.length === 0 || !baseline || baseline <= 0) {
              // Try DexScreener for current price to build minimal 2-point series
              try {
                const { getFastPriceForMint } = await import('./fast-prices');
                const livePrice = await getFastPriceForMint(runner.mint);
                const bl = baseline || runner.initialPrice || 0;
                if (bl > 0 && typeof livePrice === 'number' && livePrice > 0) {
                  const v = livePrice / bl;
                  dataSource = 'DexScreener fallback';
                  return {
                    runnerIndex,
                    mint: runner.mint,
                    points: [{ t: 0, v: 1 }, { t: durationSec, v }],
                  };
                }
              } catch {}
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
        source: dataSource
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

  // Trigger card winners roll post (for celebration/marketing)
  app.post("/api/admin/post-card-winners-roll", requireAdminAuth, async (req, res) => {
    console.log('[api/admin/post-card-winners-roll] Endpoint called');
    try {
      console.log('[api/admin/post-card-winners-roll] Importing telegram-scheduler...');
      const scheduler = await import('./telegram-scheduler');
      const postCardWinnersRoll = (scheduler as any).postCardWinnersRoll;
      if (!postCardWinnersRoll) {
        console.error('[api/admin/post-card-winners-roll] postCardWinnersRoll function not found in scheduler');
        return res.status(500).json({ error: 'postCardWinnersRoll function not found' });
      }
      console.log('[api/admin/post-card-winners-roll] Calling postCardWinnersRoll(false)...');
      const posted = await postCardWinnersRoll(false); // false = not scheduled, bypass cooldowns
      console.log('[api/admin/post-card-winners-roll] Result:', posted);
      res.json({ 
        success: posted, 
        message: posted ? 'Card winners roll posted successfully' : 'No recent card winners to post'
      });
    } catch (error) {
      console.error('[api/admin/post-card-winners-roll] Error:', error);
      res.status(500).json({ error: 'Failed to post card winners roll', details: (error as Error).message });
    }
  });

  // Debug endpoint to diagnose card winners query without posting to Telegram
  app.get("/api/admin/debug-card-winners", requireAdminAuth, async (req, res) => {
    const diagnostics: any = {
      timestamp: new Date().toISOString(),
      steps: []
    };
    
    try {
      diagnostics.steps.push({ step: 'start', ok: true });
      
      // Import pgPool
      const { pgPool } = await import('./db/clients');
      diagnostics.steps.push({ step: 'import_pgPool', ok: !!pgPool });
      
      if (!pgPool) {
        diagnostics.error = 'pgPool is null or undefined';
        return res.json(diagnostics);
      }
      
      // Test connectivity
      try {
        const testResult = await pgPool.query('SELECT 1 as test');
        diagnostics.steps.push({ step: 'db_connectivity', ok: testResult.rows?.[0]?.test === 1 });
      } catch (connErr: any) {
        diagnostics.steps.push({ step: 'db_connectivity', ok: false, error: connErr?.message });
        diagnostics.error = 'Database connectivity failed';
        return res.json(diagnostics);
      }
      
      // Check the cutoff timestamp
      const cutoffTimestamp = Date.now() - 7 * 24 * 60 * 60 * 1000;
      diagnostics.cutoffTimestamp = cutoffTimestamp;
      diagnostics.cutoffDate = new Date(cutoffTimestamp).toISOString();
      diagnostics.currentTimestamp = Date.now();
      diagnostics.currentDate = new Date().toISOString();
      
      // Run the main query
      const mainResult = await pgPool.query(`
        SELECT 
          recipient, 
          card_mint, 
          card_reward_sig,
          usd_value,
          boost_tier,
          boost_multiplier,
          card_roll,
          card_win_probability,
          created_at
        FROM raceswap_swap_rewards 
        WHERE card_won = TRUE 
        AND created_at > $1
        ORDER BY created_at DESC 
        LIMIT 10
      `, [cutoffTimestamp]);
      
      diagnostics.steps.push({ step: 'main_query', ok: true, rowCount: mainResult.rows?.length ?? 0 });
      diagnostics.winners = (mainResult.rows || []).map((r: any) => ({
        recipient: r.recipient?.slice(0, 8) + '...' + r.recipient?.slice(-4),
        card_mint: r.card_mint?.slice(0, 8) + '...',
        created_at: r.created_at,
        created_at_date: new Date(Number(r.created_at)).toISOString(),
        usd_value: r.usd_value,
        boost_tier: r.boost_tier
      }));
      
      // If no winners, check ALL card winners
      if ((mainResult.rows?.length ?? 0) === 0) {
        const allResult = await pgPool.query(`
          SELECT recipient, card_mint, created_at, card_won
          FROM raceswap_swap_rewards 
          WHERE card_won = TRUE 
          ORDER BY created_at DESC 
          LIMIT 10
        `);
        
        diagnostics.steps.push({ step: 'all_winners_query', ok: true, rowCount: allResult.rows?.length ?? 0 });
        diagnostics.allWinners = (allResult.rows || []).map((r: any) => ({
          recipient: r.recipient?.slice(0, 8) + '...' + r.recipient?.slice(-4),
          card_mint: r.card_mint?.slice(0, 8) + '...',
          created_at: r.created_at,
          created_at_date: new Date(Number(r.created_at)).toISOString()
        }));
        
        // Check if created_at might be in different format
        if (allResult.rows?.length > 0) {
          const sample = allResult.rows[0];
          diagnostics.debug = {
            sample_created_at_raw: sample.created_at,
            sample_created_at_type: typeof sample.created_at,
            sample_is_valid_timestamp: sample.created_at > 1000000000000, // After year 2001 in ms
            comparison: {
              sample_created_at: Number(sample.created_at),
              cutoff: cutoffTimestamp,
              difference_days: (cutoffTimestamp - Number(sample.created_at)) / (24 * 60 * 60 * 1000),
              sample_is_after_cutoff: Number(sample.created_at) > cutoffTimestamp
            }
          };
        }
      }
      
      diagnostics.success = true;
      res.json(diagnostics);
      
    } catch (error: any) {
      diagnostics.steps.push({ step: 'exception', ok: false, error: error?.message });
      diagnostics.error = error?.message;
      res.json(diagnostics);
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
  // PERFORMANCE: This endpoint is cached for 10 seconds to reduce expensive settlement calculations
  app.get('/api/user/:wallet/receipts', async (req, res) => {
    try {
      const wallet = req.params.wallet;
      const limit = Math.max(1, Math.min(50, parseInt((req.query.limit as string) || '20')));
      
      // Check cache first (10 second TTL per wallet)
      const cacheKey = `receipts:${wallet}:${limit}`;
      const cached = receiptsCache.get<any[]>(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      
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
      
      // Cache the result for 10 seconds
      receiptsCache.set(cacheKey, sorted);
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

  // Jupiter Ultra API proxy endpoints for V2 raceswap
  // Ultra API: Dynamic rate limits (starts at 5 RPS = 300 req/min, scales automatically)
  // Requires JUPITER_API_KEY in Replit secrets
  // We use caching (8s) + per-IP rate limiting to handle scale
  // Check referral account status
  app.get("/api/jupiter/referral-status", async (req, res) => {
    try {
      const { outputMint } = req.query;
      if (!outputMint) {
        return res.status(400).json({ error: 'Missing outputMint parameter' });
      }

      const referralAccount = JUPITER_REFERRAL_ACCOUNT;
      const referralFee = JUPITER_REFERRAL_FEE;

      if (!referralAccount || referralFee === undefined) {
        return res.json({
          configured: false,
          message: 'Referral account not configured in environment',
        });
      }

      // Check if referral token account (Ultra referral PDA) exists for requested mint
      try {
        const { connection } = await import('./solana');
        const { PublicKey } = await import('@solana/web3.js');
        const { ReferralProvider } = await import('@jup-ag/referral-sdk');

        const referralPubkey = new PublicKey(referralAccount);
        const outputMintPubkey = new PublicKey(outputMint as string);
        const provider = new ReferralProvider(connection);

        const referralTokenAccount = provider.getReferralTokenAccountPubKey({
          referralAccountPubKey: referralPubkey,
          mint: outputMintPubkey,
        });

        const accountInfo = await connection.getAccountInfo(referralTokenAccount, 'confirmed');
        const accountExists = accountInfo !== null;

        return res.json({
          configured: true,
          referralAccount,
          referralFee,
          outputMint: outputMint as string,
          referralTokenAccount: referralTokenAccount.toBase58(),
          accountExists,
          message: accountExists
            ? 'Referral token account exists for this mint'
            : `Referral token account is missing. Create it with: tsx scripts/setup-jupiter-referral.ts`,
        });
      } catch (error) {
        console.error('[api/jupiter/referral-status] Error:', error);
        return res.status(500).json({ 
          error: 'Failed to check referral status',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    } catch (error: any) {
      console.error('[api/jupiter/referral-status] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to check referral status' });
    }
  });

  app.get("/api/jupiter/quote", async (req, res) => {
    try {
      const {
        inputMint,
        outputMint,
        amount,
        slippageBps = '50',
        platformFeeBps,
        maxAccounts,
        onlyDirectRoutes,
        restrictIntermediateTokens,
        referralAccount,
        referralFee,
      } = req.query;
      
      if (!inputMint || !outputMint || !amount) {
        return res.status(400).json({ error: 'Missing required parameters: inputMint, outputMint, amount' });
      }

      // Create cache key from request parameters (include referral params)
      const cacheKey = `jupiter-quote-${inputMint}-${outputMint}-${amount}-${slippageBps}-${platformFeeBps || ''}-${maxAccounts || ''}-${onlyDirectRoutes || ''}-${restrictIntermediateTokens || ''}-${referralAccount || ''}-${referralFee || ''}`;
      
      // Check cache first (30 second TTL to balance freshness vs rate limits)
      const cached = jupiterQuoteCache.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }

      // Log API key status on first request
      logApiKeyStatusOnce();
      
      // Build query parameters for Ultra API (inputMint, outputMint, amount, referralAccount, referralFee)
      // Ultra API /ultra/v1/order endpoint for quotes (without taker parameter)
      // According to Jupiter docs: https://dev.jup.ag/docs/ultra/get-order
      const ultraParams = new URLSearchParams({
        inputMint: inputMint as string,
        outputMint: outputMint as string,
        amount: amount as string,
        // Note: Don't include taker - this gives us quote info without transaction
        // slippageBps is not used in Ultra API order endpoint (applied at swap time)
      });
      
      // Use referral accounts for treasury fee collection when platformFeeBps is set (main swap only)
      const finalReferralAccount = (referralAccount as string) || JUPITER_REFERRAL_ACCOUNT;
      const finalReferralFee = referralFee ? parseInt(referralFee as string, 10) : JUPITER_REFERRAL_FEE;
      const shouldRequestReferral =
        Boolean(platformFeeBps) && Boolean(finalReferralAccount) && finalReferralFee !== undefined;

      if (shouldRequestReferral && finalReferralAccount && finalReferralFee !== undefined) {
        ultraParams.set('referralAccount', finalReferralAccount);
        ultraParams.set('referralFee', finalReferralFee.toString());
        console.log(
          `   ✅ Requesting referral fees: ${finalReferralFee}bps to ${finalReferralAccount.slice(0, 8)}...`
        );
      } else if (!platformFeeBps) {
        console.log(`   ℹ️  Skipping referral fees: platformFeeBps not provided (reflection swap or simple swap)`);
      } else if (!finalReferralAccount || finalReferralFee === undefined) {
        console.warn(`   ⚠️  Referral env vars missing - cannot request fees`);
      }
      
      // Try Ultra API first (requires API key), with lite Ultra fallback
      // Ultra API uses /ultra/v1/order (without taker to get quote info only)
      const ultraUrl = ultraParams.toString();
      // Note: Pro Ultra endpoint requires API key; lite fallback is unauthenticated but rate-limited
      const endpoints = [
        {
          url: `https://api.jup.ag/ultra/v1/order?${ultraUrl}`,
          requiresAuth: true,
          label: 'Ultra API (Pro)',
          isUltra: true
        },
        {
          url: `https://lite-api.jup.ag/ultra/v1/order?${ultraUrl}`,
          requiresAuth: false,
          label: 'Ultra API (Lite fallback)',
          isUltra: true
        },
      ];
      
      let response, data;
      let lastError: any;
      for (const endpoint of endpoints) {
        if (endpoint.requiresAuth && !JUPITER_API_KEY) {
          logMissingApiKeyOnce();
          continue;
        }

        try {
          console.log(`🔄 Attempting Jupiter quote from ${endpoint.label}: ${endpoint.url}`);
          
          // Build headers - Ultra API prefers x-api-key header (even for lite fallback)
          const headers: Record<string, string> = {
            'Accept': 'application/json',
          };
          
          // Always include API key for Ultra API endpoints if available (even for lite fallback)
          // This ensures we get the best rate limits possible
          if (JUPITER_API_KEY && endpoint.isUltra) {
            // Jupiter Ultra API uses x-api-key header (not Authorization Bearer)
            headers['x-api-key'] = JUPITER_API_KEY;
            console.log(`   Using x-api-key header: ${JUPITER_API_KEY.substring(0, 8)}...`);
          } else if (JUPITER_API_KEY && endpoint.requiresAuth) {
            headers['x-api-key'] = JUPITER_API_KEY;
            console.log(`   Using x-api-key header: ${JUPITER_API_KEY.substring(0, 8)}...`);
          }
          
          response = await fetch(endpoint.url, {
            method: 'GET',
            headers,
          });
          
          const responseText = await response.text();
          try {
            data = JSON.parse(responseText);
          } catch (parseError) {
            console.error(`❌ Failed to parse JSON from ${endpoint.label}:`, responseText.substring(0, 500));
            lastError = new Error(`Invalid JSON response from ${endpoint.label}: ${responseText.substring(0, 200)}`);
            continue;
          }
          
          if (response.ok && data && !data.error) {
            // Ultra API returns different format - convert if needed
            if (endpoint.isUltra) {
              // Ultra API response should have outAmount or we convert from response
              if (!data.outAmount && data.outAmount === undefined) {
                // Try to extract from Ultra API response format
                // Ultra API may return different field names
                console.warn(`⚠️ ${endpoint.label} response format may differ:`, Object.keys(data));
              }
            }
            
            // Log whether referral fees were applied so operators can verify collection
            if (shouldRequestReferral) {
              if (data.feeBps === finalReferralFee && data.feeMint) {
                console.log(
                  `   ✅ Referral fees applied: ${data.feeBps}bps in ${data.feeMint.slice(0, 8)}... (matches expected ${finalReferralFee}bps)`
                );
              } else {
                console.warn(
                  `   ⚠️ Referral fees missing or mismatched (expected ${finalReferralFee}bps, got ${
                    data.feeBps ?? 'none'
                  })`
                );
                console.warn(`      This usually means the referral token account for feeMint is not initialized yet.`);
              }
            }
            
            // Validate that we have the required fields
            if (!data.outAmount) {
              console.error(`❌ ${endpoint.label} response missing outAmount:`, JSON.stringify(data).substring(0, 500));
              lastError = new Error(`Response from ${endpoint.label} missing outAmount field`);
              continue;
            }
            console.log(`✅ Jupiter quote from ${endpoint.label}: outAmount=${data.outAmount}, inAmount=${data.inAmount || amount}`);
            break; // Success!
          } else {
            // Log the error response
            const isRateLimit = response.status === 429;
            console.error(`❌ ${endpoint.label} returned error:`, {
              status: response.status,
              statusText: response.statusText,
              error: data?.error,
              message: data?.message,
              isRateLimit,
              hasApiKey: Boolean(JUPITER_API_KEY),
              data: JSON.stringify(data).substring(0, 500)
            });
            
            // If we get a 429 and we have an API key, this suggests a configuration issue
            if (isRateLimit && JUPITER_API_KEY) {
              console.warn(`   ⚠️  Rate limit error with API key - check Jupiter Ultra API configuration`);
            }
            
            lastError = data?.error || new Error(`HTTP ${response.status}: ${data?.message || response.statusText}`);
          }
        } catch (err) {
          console.error(`❌ Network error from ${endpoint.label}:`, err instanceof Error ? err.message : err);
          lastError = err;
          continue; // Try next endpoint
        }
      }
      
      if (!response || !data || !data.outAmount) {
        const errorMsg = lastError?.message || 'Failed to reach Jupiter quote API';
        console.error(`❌ All Jupiter quote endpoints failed. Last error:`, errorMsg);
        return res.status(503).json({ 
          error: errorMsg,
          details: 'Ensure JUPITER_API_KEY is set in Replit secrets for Ultra API.'
        });
      }
      
      if (!response.ok) {
        // Don't cache errors
        console.error(`❌ Jupiter quote failed with status ${response.status}:`, data);
        return res.status(response.status).json(data);
      }
      
      // Cache successful responses
      // Attach local metadata so downstream swap-instructions can reliably know whether referral fees were requested.
      // (Ultra quote responses may omit fee fields even when referral params were supplied.)
      try {
        (data as any).__raceswap = {
          requestedReferral: Boolean(shouldRequestReferral),
          platformFeeBps: platformFeeBps ? Number(platformFeeBps) : 0,
          referralAccount: shouldRequestReferral ? finalReferralAccount : null,
          referralFee: shouldRequestReferral ? finalReferralFee : null,
        };
      } catch {
        // ignore
      }
      jupiterQuoteCache.set(cacheKey, data);
      res.setHeader('X-Cache', 'MISS');
      
      res.json(data);
    } catch (error: any) {
      console.error('[api/jupiter/quote] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to get Jupiter quote' });
    }
  });

  app.post("/api/jupiter/swap-instructions", async (req, res) => {
    try {
      const { quoteResponse, userPublicKey, wrapAndUnwrapSol = true, useSharedAccounts = false, feeAccount, referralAccount, referralFee } = req.body;
      
      if (!quoteResponse || !userPublicKey) {
        return res.status(400).json({ error: 'Missing required parameters: quoteResponse, userPublicKey' });
      }

      // Sanitize quoteResponse: Fix platformFee field to avoid deserialization errors
      // Jupiter Ultra API may return platformFee without 'amount' field, which causes deserialization errors.
      // When feeAccount is set, Jupiter requires platformFee.amount > 0, so we need to ensure it's valid.
      const sanitizedQuoteResponse = { ...quoteResponse };
      
      // Log presence of referral fees for observability (Ultra API gracefully handles missing accounts)
      if (sanitizedQuoteResponse.feeMint && sanitizedQuoteResponse.feeBps) {
        console.log(
          `🔍 Swap instructions include referral fees: ${sanitizedQuoteResponse.feeBps}bps in ${sanitizedQuoteResponse.feeMint.slice(
            0,
            8
          )}...`
        );
      }
      
      if (feeAccount) {
        // When feeAccount is present, Jupiter requires platformFee with amount > 0
        // If platformFee is missing or malformed, reconstruct it from the quote
        const platformFeeBps = JUPITER_REFERRAL_FEE ?? 0; // Match configured referral fee
        
        // Calculate platform fee amount: 0.2% of output amount
        const outAmount = BigInt(sanitizedQuoteResponse.outAmount || '0');
        const feeAmount = (outAmount * BigInt(platformFeeBps)) / BigInt(10000);
        
        if (!sanitizedQuoteResponse.platformFee || !sanitizedQuoteResponse.platformFee.amount) {
          // Ensure platformFee exists with valid structure
          sanitizedQuoteResponse.platformFee = {
            amount: feeAmount.toString(),
            ...(sanitizedQuoteResponse.outputMint && { mint: sanitizedQuoteResponse.outputMint }),
            feeBps: platformFeeBps
          };
          
          console.log(`✅ Reconstructed platformFee: ${feeAmount.toString()} (${platformFeeBps} bps)`);
        } else {
          // Fix malformed platformFee that has structure but invalid/zero amount
          const currentAmount = BigInt(sanitizedQuoteResponse.platformFee.amount || '0');
          if (currentAmount === BigInt(0)) {
            // Only fix if amount is zero (Jupiter requires amount > 0 when feeAccount is set)
            const oldAmount = sanitizedQuoteResponse.platformFee.amount;
            sanitizedQuoteResponse.platformFee.amount = feeAmount.toString();
            console.log(`✅ Fixed platformFee amount: ${feeAmount.toString()} (was ${oldAmount})`);
          } else {
            // Amount is valid (> 0), keep it as-is
            console.log(`✅ platformFee amount is valid: ${sanitizedQuoteResponse.platformFee.amount}`);
          }
          // Ensure feeBps is set
          if (!sanitizedQuoteResponse.platformFee.feeBps) {
            sanitizedQuoteResponse.platformFee.feeBps = platformFeeBps;
          }
        }
      } else {
        // When feeAccount is NOT present, we can safely remove platformFee
        if (sanitizedQuoteResponse.platformFee) {
          console.log('⚠️ Removing platformFee from quoteResponse (no feeAccount)');
          delete sanitizedQuoteResponse.platformFee;
        }
      }

      // CRITICAL: Use ONLY Ultra API for swap instructions to support Ultra referral accounts
      // Ultra API /ultra/v1/order with taker parameter returns a fully serialized transaction
      // The client will deserialize it, extract instructions, and merge with treasury/reflection legs
      const endpoints = [
        {
          url: 'https://api.jup.ag/ultra/v1/order',
          requiresAuth: true,
          label: 'Ultra API (Pro)',
          isUltra: true
        },
        {
          url: 'https://lite-api.jup.ag/ultra/v1/order',
          requiresAuth: false,
          label: 'Ultra API (Lite fallback)',
          isUltra: true
        }
      ];
      
      let response, data;
      for (const endpoint of endpoints) {
        if (endpoint.requiresAuth && !JUPITER_API_KEY) {
          logMissingApiKeyOnce();
          continue;
        }

        try {
          let requestBody: any;
          let requestUrl: string;
          let requestMethod: string;
          let requestHeaders: Record<string, string>;
          
          if (endpoint.isUltra) {
            // Ultra API: GET /ultra/v1/order with taker parameter
            // This returns a fully serialized transaction that the client will deserialize
            const url = new URL(endpoint.url);
            url.searchParams.set('inputMint', sanitizedQuoteResponse.inputMint || sanitizedQuoteResponse.inMint);
            url.searchParams.set('outputMint', sanitizedQuoteResponse.outputMint || sanitizedQuoteResponse.outMint);
            url.searchParams.set('amount', sanitizedQuoteResponse.inAmount || sanitizedQuoteResponse.amount);
            url.searchParams.set('taker', userPublicKey);
            
            // Include referral fees if our quote indicated they were requested.
            // (Ultra quote responses may not always surface fee fields consistently.)
            const quoteMeta = (sanitizedQuoteResponse as any)?.__raceswap;
            const quoteRequestedReferral =
              Boolean(quoteMeta?.requestedReferral) || Boolean(sanitizedQuoteResponse.feeMint && sanitizedQuoteResponse.feeBps);
            if (quoteRequestedReferral) {
              const finalReferralAccount =
                (referralAccount as string) || quoteMeta?.referralAccount || process.env.JUPITER_REFERRAL_ACCOUNT;
              const finalReferralFee =
                referralFee ? parseInt(referralFee as string, 10) : (quoteMeta?.referralFee ?? JUPITER_REFERRAL_FEE);
              if (finalReferralAccount && finalReferralFee !== undefined && finalReferralFee !== null) {
                url.searchParams.set('referralAccount', String(finalReferralAccount));
                url.searchParams.set('referralFee', String(finalReferralFee));
                console.log(
                  `   📋 Including referral fees in Ultra API request: ${String(finalReferralFee)}bps to ${String(finalReferralAccount).slice(0, 8)}...`
                );
              }
            }
            
            requestUrl = url.toString();
            requestMethod = 'GET';
            requestBody = undefined; // Ultra API uses GET with query params
            
            requestHeaders = {
              'Accept': 'application/json',
            };
            if (endpoint.requiresAuth && JUPITER_API_KEY) {
              requestHeaders['x-api-key'] = JUPITER_API_KEY;
            }
          } else {
            // Legacy API: POST /swap/v1/swap-instructions with quoteResponse
            // DEPRECATED: Should not be used with Ultra referral accounts
            requestUrl = endpoint.url;
            requestMethod = 'POST';
            requestBody = {
              quoteResponse: sanitizedQuoteResponse, // Use sanitized quote response
              userPublicKey,
              wrapAndUnwrapSol,
              useSharedAccounts: false, // Disabled: Simple AMMs are not supported with shared accounts
              dynamicComputeUnitLimit: true,
              prioritizationFeeLamports: 'auto',
            };
            
            requestHeaders = {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            };
            if (endpoint.requiresAuth && JUPITER_API_KEY) {
              requestHeaders['x-api-key'] = JUPITER_API_KEY;
            }
          }
          
          console.log(`🔄 Attempting Jupiter swap-instructions from ${endpoint.label}: ${requestUrl}`);
          const fetchOptions: RequestInit = {
            method: requestMethod,
            headers: requestHeaders,
          };
          
          if (requestBody && requestMethod === 'POST') {
            fetchOptions.body = JSON.stringify(requestBody);
          }
          
          response = await fetch(requestUrl, fetchOptions);
          
          const responseText = await response.text();
          try {
            data = JSON.parse(responseText);
          } catch (parseError) {
            console.error(`❌ Failed to parse JSON from ${endpoint.label}:`, responseText.substring(0, 500));
            continue;
          }
          
          if (response.ok && data && !data.error) {
            // Convert Ultra API response format
            if (endpoint.isUltra) {
              // Ultra API returns: { transaction: base64, requestId: string, lastValidBlockHeight, ... }
              // Convert to format expected by client: { swapTransaction: base64, lastValidBlockHeight, ... }
              // The client will deserialize the transaction and extract instructions
              if (data.transaction) {
                data.swapTransaction = data.transaction;
                // Also include other fields the client might need
                if (data.lastValidBlockHeight) {
                  data.lastValidBlockHeight = data.lastValidBlockHeight;
                }
                // Mark as Ultra API response so client knows to deserialize it
                data.isUltraTransaction = true;
              }
              console.log(`✅ Jupiter Ultra transaction from ${endpoint.label}`);
              if (data.requestId) {
                console.log(`   Request ID: ${data.requestId}`);
              }
              console.log(`   Transaction size: ${data.transaction?.length || 0} base64 chars`);
            } else {
              // Legacy API response (should not be used with Ultra referral accounts)
              console.log(`✅ Jupiter swap-instructions from ${endpoint.label} (Legacy API - not recommended with Ultra referral accounts)`);
            }
            break; // Success!
          } else {
            console.error(`❌ ${endpoint.label} returned error:`, {
              status: response.status,
              error: data?.error,
              message: data?.message,
            });
          }
        } catch (err) {
          console.error(`❌ Network error from ${endpoint.label}:`, err instanceof Error ? err.message : err);
          continue; // Try next endpoint
        }
      }
      
      if (!response || !response.ok) {
        const errorMsg = data?.error || data?.message || 'Failed to reach Jupiter swap API';
        console.error(`❌ All Jupiter swap-instructions endpoints failed. Last status: ${response?.status}`);
        return res.status(response?.status || 503).json({ 
          error: errorMsg,
          details: 'Ensure JUPITER_API_KEY is set in Replit secrets for Ultra API.'
        });
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

    // ─── RACES RETIRED ───────────────────────────────────────────────
    // Races are disabled for now. Focus is on swap, charts, and token lists.
    // The race timer, race creation, phase improvements, and bet reconciler
    // are all skipped to reduce GeckoTerminal API load and simplify the app.
    const racesEnabled = (process.env.ENABLE_RACES || '').toLowerCase() === 'true' || (process.env.ENABLE_RACES || '') === '1';
    if (racesEnabled) {
      console.log("⏱️ Step C: Starting countdown updater...");
      const { startCountdownUpdater, initializeRaces } = await import('./sse');
      startCountdownUpdater();
      console.log("⏰ Automatic race timing system started");
      
      console.log("🏁 Step D: Initializing races...");
      await initializeRaces();
      console.log("✅ Step D complete: Races initialized");

      console.log("🔧 Step E: Improving race phase system...");
      const { improveRacePhaseSystem } = await import('./race-phase-improvements');
      await improveRacePhaseSystem();
      console.log("✅ Step E complete: Race phase system improved");

      try {
        const { startBetReconciler, oneOffBootRescanBets } = await import('./reconcile');
        oneOffBootRescanBets(300).catch(() => {});
        startBetReconciler(30000);
        console.log('🔄 Bet reconciler started');
      } catch (e) {
        console.warn('⚠️ Failed to start bet reconciler:', e);
      }
    } else {
      console.log("⏸️ Races RETIRED — skipping race timer, creation, and phase system");
      console.log("   Set ENABLE_RACES=true to re-enable races");
    }
    // ─────────────────────────────────────────────────────────────────

    console.log("Application initialization complete");
    console.log("Server ready to accept connections");
    
  } catch (error) {
    console.error("Failed to initialize application:", error);
    throw error;
  }
}
