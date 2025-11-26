import { Request, Response } from "express";
import { EventEmitter } from "events";
import { RaceTimer } from "./race-timer";
import type { Race } from "@shared/schema";

// Race timing constants
// Keep OPEN window 30s longer than IN_PROGRESS to avoid overlap
const PROGRESS_MS = 20 * 60 * 1000; // 20 minutes
const OPEN_MS = PROGRESS_MS + 30 * 1000; // 20m + 30s

// Track started races to prevent duplicates
const startedRaces = new Set<string>();

// Settle race function wrapper
async function settleRace(raceId: string, lockedTs: number) {
  try {
    const { RaceStateMachine } = await import("./race-state-machine");
    await RaceStateMachine.transitionRace(raceId, "SETTLED", "Timer settlement");
  } catch (error) {
    console.error(`❌ Failed to settle race ${raceId}:`, error);
  }
}

// Global event emitter for race events
export const raceEvents = new EventEmitter();

interface SSEClient {
  id: string;
  response: Response;
  lastPing: number;
}

const sseClients = new Map<string, SSEClient>();

// ---------- SSE ----------
export function handleSSEConnection(req: Request, res: Response) {
  const clientId = `client_${Date.now()}_${sseClients.size}`; // Use client count instead of random

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control"
  });

  res.write(`data: ${JSON.stringify({ type: "connected", clientId })}\n\n`);

  const client: SSEClient = { id: clientId, response: res, lastPing: Date.now() };
  sseClients.set(clientId, client);
  console.log(`SSE client connected: ${clientId}, total clients: ${sseClients.size}`);

  const pingInterval = setInterval(() => {
    if (!sseClients.has(clientId)) return clearInterval(pingInterval);
    try {
      res.write(`data: ${JSON.stringify({ type: "ping", timestamp: Date.now() })}\n\n`);
      client.lastPing = Date.now();
    } catch {
      cleanup();
    }
  }, 30000);

  const cleanup = () => {
    sseClients.delete(clientId);
    clearInterval(pingInterval);
    console.log(`SSE client disconnected: ${clientId}, remaining: ${sseClients.size}`);
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
}

export function broadcastEvent(type: string, data: any) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  const dead: string[] = [];
  console.log(`Broadcasting event: ${type} to ${sseClients.size} clients`);
  sseClients.forEach((client, id) => {
    try {
      client.response.write(`data: ${message}\n\n`);
    } catch {
      dead.push(id);
    }
  });
  dead.forEach(id => sseClients.delete(id));
}

// ---------- Event fanout ----------
raceEvents.on("race_created", (r: Race) => broadcastEvent("race_created", r));
raceEvents.on("race_locked", (r: Race) => broadcastEvent("race_locked", r));
raceEvents.on("race_live",   (r: Race) => broadcastEvent("race_live", r));
raceEvents.on("race_settled", (r: Race) => broadcastEvent("race_settled", r));
raceEvents.on("race_cancelled", (r: Race) => broadcastEvent("race_cancelled", r));
// Live price tick fanout
raceEvents.on("race_updated", (d: any) => broadcastEvent("race_updated", d));
raceEvents.on("bet_placed", (d: any) => broadcastEvent("bet_placed", d));
raceEvents.on("countdown_update", (d: any) => broadcastEvent("countdown_update", d));
// Per-user results
raceEvents.on("payout_executed", (d: any) => broadcastEvent("payout_executed", d));
raceEvents.on("user_loss", (d: any) => broadcastEvent("user_loss", d));

// ---------- Helpers ----------
export async function clearStuckRace(raceId: string) {
  if (startedRaces.delete(raceId)) {
    console.log(`🔧 Cleared stuck race ${raceId} from startedRaces tracking`);
  }
}

async function forceSettleStuckRaces() {
  try {
    const { getDb } = await import("./db");
    const stuck = getDb().getRaces("IN_PROGRESS");
    if (stuck.length) {
      console.log(`🚨 Found ${stuck.length} stuck IN_PROGRESS races - force settling...`);
      for (const r of stuck) {
        await settleRace(r.id, Number(r.lockedTs));
      }
    }
  } catch (e) {
    console.error("❌ Failed to force settle stuck races:", e);
  }
}

// Force a stuck race to LOCKED
export async function forceRaceToLocked(raceId: string) {
  try {
    const { getDb } = await import("./db");
    const { RaceStateMachine } = await import("./race-state-machine");
    const race = getDb().getRace(raceId);
    if (!race || race.status !== "OPEN") {
      throw new Error(`Race ${raceId} not found or not in OPEN status`);
    }

    // Centralized transition handles baseline capture and event emission
    await RaceStateMachine.transitionRace(raceId, "LOCKED", "force");
    startedRaces.delete(raceId);
    await createNewRaceIfNeeded();
    console.log(`🔒 [FORCE] Race ${raceId} moved to LOCKED via state machine`);
  } catch (e) {
    console.error(`❌ Failed to force race ${raceId} to LOCKED:`, e);
    throw e;
  }
}

// ---------- Main loop ----------
export function startCountdownUpdater() {
  console.log("🔌 Arming race timer system...");
  
  // Always start the race timer system so existing races continue to progress
  RaceTimer.start();
  // Feature flag: optionally block creation of new races (does NOT stop timers)
  const blockNewRaces = ((process.env.BLOCK_NEW_RACES || '').toLowerCase() === '1' || (process.env.BLOCK_NEW_RACES || '').toLowerCase() === 'true');
  if (blockNewRaces) {
    console.warn('⏸️ BLOCK_NEW_RACES is enabled: auto-creation disabled, timers still running');
  }
  
  // Keep 2 OPEN races topped up (staggered by OPEN window)
  if (!blockNewRaces) {
    setInterval(() => createNewRaceIfNeeded().catch(e => console.error("ensure2 failed", e)), 20000);
  }
}

// ---------- Lifecycle ----------
async function startRaceProgression(race: any) {
  console.log(`💰 Race ${race.id} OPEN - managed by new timer system`);
  raceEvents.emit("race_started", race);

  const { clearTokenCache } = await import("./runners");
  clearTokenCache();
  // Proactively ensure we top back up to 3 OPEN races after a new one starts
  await createNewRaceIfNeeded();
}

// Settlement is now handled by RaceStateMachine

// Payouts are now handled by RaceStateMachine

// ---------- Race creation ----------
export async function createNewRaceIfNeeded() {
  try {
    const { getDb } = await import("./db");
    // Feature flag gate
    const blockNewRaces = ((process.env.BLOCK_NEW_RACES || '').toLowerCase() === '1' || (process.env.BLOCK_NEW_RACES || '').toLowerCase() === 'true');
    if (blockNewRaces) {
      const open = await getDb().getRaces("OPEN");
      console.log(`🧰 BLOCK_NEW_RACES active: not creating new races. Current OPEN=${open.length}`);
      return;
    }
    const { getNewPumpfunTokens, clearTokenCache, getLastValidRunners } = await import("./runners");
    const treasury = await getDb().getTreasury();
    if ((treasury as any).maintenanceMode) {
      const open = await getDb().getRaces("OPEN");
      console.log(`🧰 Maintenance mode active: not creating new races. Current OPEN=${open.length}`);
      return;
    }

    const open = await getDb().getRaces("OPEN");
    const need = 3 - open.length;
    if (need <= 0) {
      console.log(`📊 Current OPEN races: ${open.length}, target: 3 (no new races needed)`);
      return;
    }

    const { nowMs } = await import('./chain-time');
    const now = await nowMs();
    const latestFutureStart = open.filter(r => r.startTs > now).reduce((m, r) => Math.max(m, r.startTs), now);

    for (let i = 0; i < need; i++) {
      try {
        // Re-check maintenance each iteration to avoid races if mode is toggled while fetching runners
        const treasNow = await getDb().getTreasury();
        if ((treasNow as any).maintenanceMode) {
          const openNow = await getDb().getRaces("OPEN");
          console.log(`🧰 Maintenance toggled ON mid-run: aborting creation. Current OPEN=${openNow.length}`);
          return;
        }
        const startTs = Math.max(latestFutureStart + OPEN_MS + i * OPEN_MS, now + 3 * 60 * 1000);
        clearTokenCache();

        // fetch up to 6, allow minimum 3
        let runners: any[] | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            console.log(`🎯 Attempt ${attempt}: fetching runners...`);
            const got = await getNewPumpfunTokens(6);
            // Strict vetting: require valid GeckoTerminal pool address to ensure real tokens
            const vetted = (got || []).filter((t: any) => typeof t.poolAddress === 'string' && t.poolAddress.length > 0);
            if (vetted.length >= 3) { runners = vetted; break; }
            console.warn(`⚠️  Vetted runners insufficient (have=${vetted.length}). Retrying...`);
          } catch (e) {
            if (attempt === 3) throw e;
            await new Promise(r => setTimeout(r, 1500));
          }
        }
        if (!runners) {
          // Fallback policy: randomly choose 3 from the last 20 vetted runners
          const recent = getLastValidRunners();
          const uniqueByMint = new Map<string, any>();
          for (const t of recent) {
            if (!uniqueByMint.has(t.mint)) uniqueByMint.set(t.mint, t);
          }
          const pool: any[] = Array.from(uniqueByMint.values());
          if (pool.length >= 3) {
            // Shuffle and take 3
            for (let i = pool.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            runners = pool.slice(0, 3);
            console.warn(`⚠️  Using fallback of ${runners.length} from last ${pool.length} vetted runners`);
          }
        }
        if (!runners) throw new Error("Could not fetch runners");

        const rakeBps = 250; // Fixed rake rate
        // Random jackpot: each race has X% chance (default 5%). Disable via JACKPOT_ENABLED=false
        const JACKPOT_ENABLED = String(process.env.JACKPOT_ENABLED || 'true').toLowerCase() !== 'false';
        const JACKPOT_PROB_PCT = Math.max(0, Math.min(100, Number(process.env.JACKPOT_PROB_PCT || '5')));
        const jackpotFlag = JACKPOT_ENABLED && (Math.random() * 100 < JACKPOT_PROB_PCT);

        const race = {
          id: `race_${Date.now()}_${i}`, // Use iteration index instead of random
          startTs,
          status: "OPEN" as const,
          rakeBps,
          jackpotFlag,
          jackpotAdded: 0,
          // Final vetting on insert: filter again and require 3+ valid runners
          runners: runners
            .filter((t: any) => typeof t.poolAddress === 'string' && t.poolAddress.length > 0)
            .slice(0, 8)
            .map(r => ({ ...r, marketCap: r.marketCap || 0 })),
          createdAt: Date.now()
        };

        if (!race.runners || race.runners.length < 3) {
          throw new Error("Insufficient vetted runners for race creation");
        }

        // Final maintenance guard immediately before insert
        const finalTreasure = await getDb().getTreasury();
        if ((finalTreasure as any).maintenanceMode) {
          const openNow2 = await getDb().getRaces("OPEN");
          console.log(`🧰 Maintenance toggled ON before insert: skipping. Current OPEN=${openNow2.length}`);
          return;
        }
        const created = await getDb().createRace(race);
        raceEvents.emit("race_created", race);

        // House micro-seed bets so coverage appears in UI during OPEN
        try {
          const { seedHouseBetsForRace } = await import('./house-seed');
          // Seed SOL; gate RACE seeds behind ENABLE_RACE_BETS
          const seededSol = await seedHouseBetsForRace(created as any, undefined, 'SOL');
          const ENABLE_RACE = String(process.env.ENABLE_RACE_BETS || '').toLowerCase();
          const allowRace = ENABLE_RACE === '1' || ENABLE_RACE === 'true';
          const seededRace = allowRace ? await seedHouseBetsForRace(created as any, undefined, 'RACE') : { created: 0 } as any;
          console.log(`🏦 [HOUSE_SEED][auto] Created SOL ${seededSol.created}/${created.runners.length}${allowRace ? `, RACE ${seededRace.created}/${created.runners.length}` : ''} seed bets`);
        } catch (e) {
          console.warn(`⚠️ [HOUSE_SEED][auto] Failed to seed house bets for race ${race.id}`, e);
        }

        const mins = Math.ceil((startTs - now) / 60000);
        console.log(`🏁 Auto-created ${race.id} starting in ${mins}m ${jackpotFlag ? "(JACKPOT!)" : ""}`);
      } catch (e) {
        console.error("❌ Failed to auto-create race:", e);
      }
    }
  } catch (e) {
    console.error("Error in createNewRaceIfNeeded:", e);
  }
}

export async function initializeRaces() {
  console.log("🚀 Initializing races...");
  await forceSettleStuckRaces();
  await createNewRaceIfNeeded();
  console.log("✅ Race initialization complete");
}

// Price updates are now handled by RaceTimer

// ---------- Admin ----------
export function getSSEStats() {
  return {
    connectedClients: sseClients.size,
    clients: Array.from(sseClients.values()).map(c => ({
      id: c.id,
      lastPing: c.lastPing,
      connectedFor: Date.now() - c.lastPing
    }))
  };
}

// ---------- Cleanup for graceful shutdown ----------
export async function cleanup() {
  console.log('🧹 Cleaning up SSE module...');
  
  // Close all SSE client connections
  for (const [clientId, client] of sseClients.entries()) {
    try {
      client.response.end();
      sseClients.delete(clientId);
    } catch (e) {
      console.log(`⚠️ Error closing SSE client ${clientId}:`, e);
    }
  }
  
  // Stop the race timer system
  try {
    RaceTimer.stop();
    console.log('✅ Race timer system stopped');
  } catch (e) {
    console.log('⚠️ Error stopping race timer:', e);
  }
  
  console.log(`✅ SSE cleanup complete (closed ${sseClients.size} clients)`);
}
