import Decimal from "decimal.js";
import { getDb } from "./db";
import { pgPool } from "./db/clients";
import { computeEdgePoints } from "./edge-points";
import { calculateSettlement } from "./settlement";
import type { Race } from "@shared/schema";

/**
 * Backfill per-user race results for the global leaderboard using historical data.
 *
 * Strategy per settled race:
 * - Load all bets for the race
 * - Prefer actual recorded payout transfers if present; otherwise compute payouts
 * - Upsert one user_race_results row per wallet with computed edge points
 * - Recompute user_stats for each affected wallet
 * 
 * NEW: Also attempts to backfill from Postgres bets when races table is empty (post-restart)
 */
export async function backfillUserResultsFromHistory(options?: { logger?: (msg: string) => void }): Promise<{
  racesProcessed: number;
  walletsUpdated: number;
}> {
  const log = options?.logger || ((msg: string) => console.log(msg));

  // First try SQLite races (normal path)
  const settledRaces: Race[] = getDb().getRaces("SETTLED" as any) as any;
  
  // If no settled races in SQLite but Postgres is available, try backfilling from Postgres bets
  if (!settledRaces?.length && pgPool) {
    log("backfill: no settled races in SQLite, attempting Postgres backfill from bets/settlements...");
    return await backfillFromPostgresBets(log);
  }
  
  if (!settledRaces?.length) {
    log("backfill: no settled races found; nothing to do");
    return { racesProcessed: 0, walletsUpdated: 0 };
  }

  let racesProcessed = 0;
  let walletsUpdated = 0;

  for (const race of settledRaces) {
    try {
      const bets = await getDb().getBetsForRace(race.id) as any[];
      if (!bets?.length) {
        continue;
      }

      // Prefer actual recorded payout transfers where available
      const transfers = await getDb().getSettlementTransfers(race.id) || [];
      const payoutByWallet = new Map<string, Decimal>();
      for (const t of transfers) {
        if (t.transferType === "PAYOUT" && t.toWallet && t.amount) {
          const prev = payoutByWallet.get(t.toWallet) || new Decimal(0);
          payoutByWallet.set(t.toWallet, prev.add(new Decimal(t.amount)));
        }
      }

      // Compute settlement if we do not have recorded payouts
      let totalPotStr = bets.reduce((sum: Decimal, b: any) => sum.add(new Decimal(b.amount || "0")), new Decimal(0)).toString();
      if (payoutByWallet.size === 0) {
        const settlement = await calculateSettlement(bets as any, race as any);
        totalPotStr = settlement.totalPot.toString();
        settlement.winnerPayouts.forEach((amt: Decimal, wallet: string) => payoutByWallet.set(wallet, amt));
      }

      // Aggregate bets per wallet
      const betByWallet = new Map<string, Decimal>();
      for (const b of bets) {
        const prev = betByWallet.get(b.wallet) || new Decimal(0);
        betByWallet.set(b.wallet, prev.add(new Decimal(b.amount || "0")));
      }

      // Upsert per-wallet results
      const wallets = new Set<string>([...betByWallet.keys(), ...payoutByWallet.keys()]);
      for (const wallet of wallets) {
        const betAmt = betByWallet.get(wallet) || new Decimal(0);
        const payoutAmt = payoutByWallet.get(wallet) || new Decimal(0);
        const win = payoutAmt.gt(0);
        const edge = computeEdgePoints({
          betAmount: betAmt.toString(),
          payoutAmount: payoutAmt.toString(),
          totalPot: totalPotStr,
          win
        });

        await getDb().upsertUserRaceResult({
          wallet,
          raceId: race.id,
          betAmount: betAmt.toString(),
          payoutAmount: payoutAmt.toString(),
          win,
          edgePoints: edge,
          ts: Number(race.settledBlockTimeMs || race.inProgressBlockTimeMs || race.lockedBlockTimeMs || race.createdAt || Date.now())
        });
        await getDb().recalcUserStats(wallet);
        walletsUpdated++;
      }

      racesProcessed++;
    } catch (e) {
      log(`backfill: failed for race ${race.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log(`backfill: completed for ${racesProcessed} races; updated ${walletsUpdated} wallet entries`);
  return { racesProcessed, walletsUpdated };
}

/**
 * Backfill user_race_results from Postgres bets and settlement_transfers.
 * Used when SQLite races table is empty (e.g., after server restart).
 */
async function backfillFromPostgresBets(log: (msg: string) => void): Promise<{
  racesProcessed: number;
  walletsUpdated: number;
}> {
  if (!pgPool) {
    log("backfill: Postgres not available");
    return { racesProcessed: 0, walletsUpdated: 0 };
  }

  try {
    // Get all distinct race_ids that have bets (only RACE currency to avoid double counting)
    const raceIdsResult = await pgPool.query(`
      SELECT DISTINCT race_id 
      FROM bets 
      WHERE COALESCE(currency, 'RACE') = 'RACE'
      ORDER BY race_id
    `);
    
    if (!raceIdsResult.rows || raceIdsResult.rows.length === 0) {
      log("backfill: no races found in Postgres bets table");
      return { racesProcessed: 0, walletsUpdated: 0 };
    }

    log(`backfill: found ${raceIdsResult.rows.length} races with RACE bets in Postgres`);

    let racesProcessed = 0;
    let walletsUpdated = 0;

    for (const { race_id } of raceIdsResult.rows) {
      try {
        // Get all bets for this race
        const betsResult = await pgPool.query(
          `SELECT wallet, runner_idx, amount, ts 
           FROM bets 
           WHERE race_id = $1 AND COALESCE(currency, 'RACE') = 'RACE'`,
          [race_id]
        );

        if (!betsResult.rows || betsResult.rows.length === 0) continue;

        // Get settlement transfers for this race (payouts)
        const transfersResult = await pgPool.query(
          `SELECT to_wallet, amount 
           FROM settlement_transfers 
           WHERE race_id = $1 AND transfer_type = 'PAYOUT' AND COALESCE(currency, 'RACE') = 'RACE'`,
          [race_id]
        );

        // Build payout map
        const payoutByWallet = new Map<string, Decimal>();
        for (const t of transfersResult.rows || []) {
          if (t.to_wallet && t.amount) {
            const prev = payoutByWallet.get(t.to_wallet) || new Decimal(0);
            payoutByWallet.set(t.to_wallet, prev.add(new Decimal(t.amount)));
          }
        }

        // Aggregate bets per wallet
        const betByWallet = new Map<string, Decimal>();
        for (const b of betsResult.rows) {
          const prev = betByWallet.get(b.wallet) || new Decimal(0);
          betByWallet.set(b.wallet, prev.add(new Decimal(b.amount || "0")));
        }

        // Calculate total pot
        const totalPot = Array.from(betByWallet.values()).reduce(
          (sum, amt) => sum.add(amt),
          new Decimal(0)
        ).toString();

        // Upsert per-wallet results
        const wallets = new Set<string>([...betByWallet.keys(), ...payoutByWallet.keys()]);
        for (const wallet of wallets) {
          const betAmt = betByWallet.get(wallet) || new Decimal(0);
          const payoutAmt = payoutByWallet.get(wallet) || new Decimal(0);
          const win = payoutAmt.gt(0);
          const edge = computeEdgePoints({
            betAmount: betAmt.toString(),
            payoutAmount: payoutAmt.toString(),
            totalPot,
            win
          });

          await getDb().upsertUserRaceResult({
            wallet,
            raceId: race_id,
            betAmount: betAmt.toString(),
            payoutAmount: payoutAmt.toString(),
            win,
            edgePoints: edge,
            ts: Date.now()
          });
          await getDb().recalcUserStats(wallet);
          walletsUpdated++;
        }

        racesProcessed++;
      } catch (e) {
        log(`backfill: failed for race ${race_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    log(`backfill: Postgres backfill completed - ${racesProcessed} races, ${walletsUpdated} wallet entries`);
    return { racesProcessed, walletsUpdated };
  } catch (e) {
    log(`backfill: Postgres backfill error: ${e instanceof Error ? e.message : String(e)}`);
    return { racesProcessed: 0, walletsUpdated: 0 };
  }
}

