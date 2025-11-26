import { Pool } from "pg";
import Decimal from "decimal.js";
import { Race, Prediction, Claim, Treasury } from "@shared/schema";

type RaceBetAggregateMap = Record<string, {
  totalPotSol: string;
  betCountSol: number;
  totalPotRace: string;
  betCountRace: number;
}>;

/**
 * PostgresStorage - Production database storage using Postgres
 * Implements async versions of the SQLiteStorage interface
 * NOTE: All methods return Promises (async), unlike SQLiteStorage which is sync
 */
export class PostgresStorage {
  constructor(private pool: Pool) {
    if (!pool) {
      throw new Error("PostgresStorage requires a valid Pool instance");
    }
  }

  // ===== RACE OPERATIONS =====

  async createRace(race: Race): Promise<Race> {
    const query = `
      INSERT INTO races (
        id, start_ts, start_slot, start_block_time_ms, locked_ts, locked_slot, locked_block_time_ms,
        in_progress_ts, in_progress_slot, in_progress_block_time_ms, status, rake_bps, jackpot_flag,
        jackpot_added, winner_index, drand_round, drand_randomness, drand_signature, runners,
        settled_slot, settled_block_time_ms, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING *
    `;
    
    const values = [
      race.id,
      race.startTs,
      (race as any).startSlot ?? null,
      (race as any).startBlockTimeMs ?? null,
      race.lockedTs,
      (race as any).lockedSlot ?? null,
      (race as any).lockedBlockTimeMs ?? null,
      race.inProgressTs,
      (race as any).inProgressSlot ?? null,
      (race as any).inProgressBlockTimeMs ?? null,
      race.status,
      race.rakeBps,
      race.jackpotFlag ? 1 : 0,
      race.jackpotAdded,
      race.winnerIndex,
      race.drandRound,
      race.drandRandomness,
      race.drandSignature,
      JSON.stringify(race.runners),
      (race as any).settledSlot ?? null,
      (race as any).settledBlockTimeMs ?? null,
      race.createdAt
    ];

    await this.pool.query(query, values);
    return race;
  }

  async getRace(id: string): Promise<Race | undefined> {
    const query = 'SELECT * FROM races WHERE id = $1';
    const res = await this.pool.query(query, [id]);
    
    if (!res.rows || !res.rows[0]) {
      return undefined;
    }

    const row = res.rows[0];
    return {
      id: row.id,
      startTs: Number(row.start_ts),
      startSlot: row.start_slot ? Number(row.start_slot) : undefined,
      startBlockTimeMs: row.start_block_time_ms ? Number(row.start_block_time_ms) : undefined,
      lockedTs: row.locked_ts ? Number(row.locked_ts) : undefined,
      lockedSlot: row.locked_slot ? Number(row.locked_slot) : undefined,
      lockedBlockTimeMs: row.locked_block_time_ms ? Number(row.locked_block_time_ms) : undefined,
      inProgressTs: row.in_progress_ts ? Number(row.in_progress_ts) : undefined,
      inProgressSlot: row.in_progress_slot ? Number(row.in_progress_slot) : undefined,
      inProgressBlockTimeMs: row.in_progress_block_time_ms ? Number(row.in_progress_block_time_ms) : undefined,
      status: row.status,
      rakeBps: Number(row.rake_bps),
      jackpotFlag: Boolean(row.jackpot_flag),
      jackpotAdded: row.jackpot_added ? Number(row.jackpot_added) : undefined,
      winnerIndex: row.winner_index !== null ? Number(row.winner_index) : undefined,
      drandRound: row.drand_round ? Number(row.drand_round) : undefined,
      drandRandomness: row.drand_randomness,
      drandSignature: row.drand_signature,
      runners: JSON.parse(row.runners),
      settledSlot: row.settled_slot ? Number(row.settled_slot) : undefined,
      settledBlockTimeMs: row.settled_block_time_ms ? Number(row.settled_block_time_ms) : undefined,
      createdAt: Number(row.created_at),
      memeRewardEnabled: row.meme_reward_enabled ? Boolean(row.meme_reward_enabled) : undefined,
      memeRewardRecipient: row.meme_reward_recipient || undefined,
      memeRewardTokenAmount: row.meme_reward_token_amount || undefined,
      memeRewardSolSpent: row.meme_reward_sol_spent || undefined,
      memeRewardTxSig: row.meme_reward_tx_sig || undefined
    };
  }

  async getRaces(status?: string): Promise<Race[]> {
    const query = status
      ? 'SELECT * FROM races WHERE status = $1 ORDER BY created_at ASC'
      : 'SELECT * FROM races ORDER BY created_at ASC';
    
    const res = status 
      ? await this.pool.query(query, [status])
      : await this.pool.query(query);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      startTs: Number(row.start_ts),
      startSlot: row.start_slot ? Number(row.start_slot) : undefined,
      startBlockTimeMs: row.start_block_time_ms ? Number(row.start_block_time_ms) : undefined,
      lockedTs: row.locked_ts ? Number(row.locked_ts) : undefined,
      lockedSlot: row.locked_slot ? Number(row.locked_slot) : undefined,
      lockedBlockTimeMs: row.locked_block_time_ms ? Number(row.locked_block_time_ms) : undefined,
      inProgressTs: row.in_progress_ts ? Number(row.in_progress_ts) : undefined,
      inProgressSlot: row.in_progress_slot ? Number(row.in_progress_slot) : undefined,
      inProgressBlockTimeMs: row.in_progress_block_time_ms ? Number(row.in_progress_block_time_ms) : undefined,
      status: row.status,
      rakeBps: Number(row.rake_bps),
      jackpotFlag: Boolean(row.jackpot_flag),
      jackpotAdded: row.jackpot_added ? Number(row.jackpot_added) : undefined,
      winnerIndex: row.winner_index !== null ? Number(row.winner_index) : undefined,
      drandRound: row.drand_round ? Number(row.drand_round) : undefined,
      drandRandomness: row.drand_randomness,
      drandSignature: row.drand_signature,
      runners: JSON.parse(row.runners),
      settledSlot: row.settled_slot ? Number(row.settled_slot) : undefined,
      settledBlockTimeMs: row.settled_block_time_ms ? Number(row.settled_block_time_ms) : undefined,
      createdAt: Number(row.created_at),
      memeRewardEnabled: row.meme_reward_enabled ? Boolean(row.meme_reward_enabled) : undefined,
      memeRewardRecipient: row.meme_reward_recipient || undefined,
      memeRewardTokenAmount: row.meme_reward_token_amount || undefined,
      memeRewardSolSpent: row.meme_reward_sol_spent || undefined,
      memeRewardTxSig: row.meme_reward_tx_sig || undefined
    })).sort((a, b) => a.startTs - b.startTs);
  }

  async updateRace(race: Race): Promise<void> {
    const query = `
      UPDATE races SET 
        start_ts = $1, start_slot = $2, start_block_time_ms = $3,
        locked_ts = $4, locked_slot = $5, locked_block_time_ms = $6,
        in_progress_ts = $7, in_progress_slot = $8, in_progress_block_time_ms = $9,
        status = $10, rake_bps = $11, jackpot_flag = $12, jackpot_added = $13,
        winner_index = $14, drand_round = $15, drand_randomness = $16, drand_signature = $17,
        runners = $18, settled_slot = $19, settled_block_time_ms = $20,
        meme_reward_enabled = $21, meme_reward_recipient = $22, meme_reward_token_amount = $23,
        meme_reward_sol_spent = $24, meme_reward_tx_sig = $25
      WHERE id = $26
    `;

    const values = [
      race.startTs,
      (race as any).startSlot ?? null,
      (race as any).startBlockTimeMs ?? null,
      race.lockedTs,
      (race as any).lockedSlot ?? null,
      (race as any).lockedBlockTimeMs ?? null,
      race.inProgressTs,
      (race as any).inProgressSlot ?? null,
      (race as any).inProgressBlockTimeMs ?? null,
      race.status,
      race.rakeBps,
      race.jackpotFlag ? 1 : 0,
      race.jackpotAdded,
      race.winnerIndex,
      race.drandRound,
      race.drandRandomness,
      race.drandSignature,
      JSON.stringify(race.runners),
      (race as any).settledSlot ?? null,
      (race as any).settledBlockTimeMs ?? null,
      (race as any).memeRewardEnabled ?? null,
      (race as any).memeRewardRecipient ?? null,
      (race as any).memeRewardTokenAmount ?? null,
      (race as any).memeRewardSolSpent ?? null,
      (race as any).memeRewardTxSig ?? null,
      race.id
    ];

    await this.pool.query(query, values);
  }

  // ===== BET OPERATIONS =====

  async createBet(bet: any): Promise<void> {
    const runnerIdx = bet.runnerIdx !== undefined ? bet.runnerIdx : bet.tokenIdx;
    const raceId = bet.raceId || bet.marketId;

    if (runnerIdx === undefined || runnerIdx === null) {
      throw new Error(`runnerIdx is required but got: ${runnerIdx}`);
    }

    const query = `
      INSERT INTO bets (id, race_id, wallet, runner_idx, amount, sig, ts, block_time_ms, slot, client_id, memo, currency)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (sig) DO NOTHING
    `;

    const values = [
      bet.id,
      raceId,
      bet.wallet,
      runnerIdx,
      bet.amount,
      bet.sig,
      bet.ts,
      bet.blockTimeMs ?? null,
      bet.slot ?? null,
      bet.clientId ?? null,
      bet.memo ?? null,
      bet.currency || 'RACE'
    ];

    try {
      await this.pool.query(query, values);
    } catch (err) {
      const msg = String(err?.message || err);
      if (!msg.includes('duplicate') && !msg.includes('conflict')) {
        console.error('Error creating bet:', err);
        throw err;
      }
    }
  }

  async hydrateBet(row: { id: string; raceId: string; wallet: string; runnerIdx: number; amount: string; sig: string; ts: number; blockTimeMs?: number | null; slot?: number | null; clientId?: string | null; memo?: string | null; currency?: string }): Promise<void> {
    await this.createBet(row);
  }

  async getBetsForRace(raceId: string): Promise<Prediction[]> {
    const query = 'SELECT * FROM bets WHERE race_id = $1 ORDER BY ts ASC';
    const res = await this.pool.query(query, [raceId]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      raceId: row.race_id,
      wallet: row.wallet,
      runnerIdx: Number(row.runner_idx),
      amount: row.amount,
      sig: row.sig,
      ts: Number(row.ts),
      blockTimeMs: row.block_time_ms ? Number(row.block_time_ms) : undefined,
      slot: row.slot ? Number(row.slot) : undefined,
      clientId: row.client_id,
      memo: row.memo,
      currency: row.currency || 'RACE'
    }));
  }

  async getRaceBetAggregates(raceIds: string[]): Promise<RaceBetAggregateMap> {
    if (!Array.isArray(raceIds) || raceIds.length === 0) {
      return {};
    }
    const uniqueIds = Array.from(new Set(raceIds.map(id => String(id))));
    if (uniqueIds.length === 0) {
      return {};
    }
    const res = await this.pool.query(
      `
        SELECT 
          race_id,
          UPPER(COALESCE(currency, 'RACE')) AS currency,
          COUNT(*)::int AS bet_count,
          COALESCE(SUM(amount)::text, '0') AS total_amount
        FROM bets
        WHERE race_id = ANY($1::text[])
        GROUP BY race_id, currency
      `,
      [uniqueIds]
    );
    const aggregates: RaceBetAggregateMap = {};
    for (const row of res.rows || []) {
      const key = String(row.race_id);
      if (!aggregates[key]) {
        aggregates[key] = { totalPotSol: '0', betCountSol: 0, totalPotRace: '0', betCountRace: 0 };
      }
      const normalizedCurrency = String(row.currency || 'RACE').toUpperCase() === 'SOL' ? 'SOL' : 'RACE';
      const amountStr = row.total_amount ?? '0';
      if (normalizedCurrency === 'SOL') {
        aggregates[key].totalPotSol = new Decimal(amountStr || '0').toString();
        aggregates[key].betCountSol = Number(row.bet_count) || 0;
      } else {
        aggregates[key].totalPotRace = new Decimal(amountStr || '0').toString();
        aggregates[key].betCountRace = Number(row.bet_count) || 0;
      }
    }
    return aggregates;
  }

  async getBetsForWallet(wallet: string, raceId?: string): Promise<Prediction[]> {
    const query = raceId
      ? 'SELECT * FROM bets WHERE wallet = $1 AND race_id = $2 ORDER BY ts DESC'
      : 'SELECT * FROM bets WHERE wallet = $1 ORDER BY ts DESC';

    const res = raceId
      ? await this.pool.query(query, [wallet, raceId])
      : await this.pool.query(query, [wallet]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      raceId: row.race_id,
      wallet: row.wallet,
      runnerIdx: Number(row.runner_idx),
      amount: row.amount,
      sig: row.sig,
      ts: Number(row.ts),
      blockTimeMs: row.block_time_ms ? Number(row.block_time_ms) : undefined,
      slot: row.slot ? Number(row.slot) : undefined,
      clientId: row.client_id,
      memo: row.memo,
      currency: row.currency || 'RACE'
    }));
  }

  // ===== CLAIM OPERATIONS =====

  async createClaim(claim: Claim): Promise<void> {
    const query = `
      INSERT INTO claims (id, race_id, wallet, amount, sig, ts)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;

    const values = [
      claim.id,
      (claim as any).marketId,
      claim.wallet,
      claim.amount,
      claim.sig,
      claim.ts
    ];

    await this.pool.query(query, values);
  }

  async getClaimsForRace(raceId: string): Promise<Claim[]> {
    const query = 'SELECT * FROM claims WHERE race_id = $1';
    const res = await this.pool.query(query, [raceId]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      marketId: row.race_id,
      wallet: row.wallet,
      amount: row.amount,
      sig: row.sig,
      ts: Number(row.ts)
    }));
  }

  async getClaimsForWallet(wallet: string): Promise<Claim[]> {
    const query = 'SELECT * FROM claims WHERE wallet = $1 ORDER BY ts DESC';
    const res = await this.pool.query(query, [wallet]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      marketId: row.race_id,
      wallet: row.wallet,
      amount: row.amount,
      sig: row.sig,
      ts: Number(row.ts)
    }));
  }

  // ===== SETTLEMENT OPERATIONS (CONTINUED) =====

  async recordSettlementTransfer(transfer: any): Promise<void> {
    const query = `
      INSERT INTO settlement_transfers (
        id, race_id, transfer_type, to_wallet, amount, tx_sig, currency, ts,
        status, attempts, last_error, batch_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        transfer_type = EXCLUDED.transfer_type,
        to_wallet = EXCLUDED.to_wallet,
        amount = EXCLUDED.amount,
        tx_sig = EXCLUDED.tx_sig,
        currency = EXCLUDED.currency,
        ts = EXCLUDED.ts,
        status = EXCLUDED.status,
        attempts = EXCLUDED.attempts,
        last_error = EXCLUDED.last_error,
        batch_id = EXCLUDED.batch_id
    `;

    const values = [
      transfer.id,
      transfer.raceId,
      transfer.transferType,
      transfer.toWallet,
      transfer.amount,
      transfer.txSig,
      transfer.currency || 'RACE',
      transfer.ts,
      transfer.status || 'SUCCESS',
      transfer.attempts || 1,
      transfer.lastError || null,
      transfer.batchId || null
    ];

    await this.pool.query(query, values);
  }

  async recordSettlementError(entry: { id: string; raceId: string; toWallet?: string; amount?: string; currency?: 'SOL' | 'RACE'; error: string; ts?: number }): Promise<void> {
    const query = `
      INSERT INTO settlement_errors (id, race_id, to_wallet, amount, currency, error, ts)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        to_wallet = EXCLUDED.to_wallet,
        amount = EXCLUDED.amount,
        currency = EXCLUDED.currency,
        error = EXCLUDED.error,
        ts = EXCLUDED.ts
    `;

    const values = [
      entry.id,
      entry.raceId,
      entry.toWallet ?? null,
      entry.amount ?? null,
      entry.currency || 'RACE',
      entry.error,
      entry.ts ?? Date.now()
    ];

    await this.pool.query(query, values);
  }

  async getSettlementTransfers(raceId: string): Promise<any[]> {
    const query = 'SELECT * FROM settlement_transfers WHERE race_id = $1 ORDER BY ts ASC';
    const res = await this.pool.query(query, [raceId]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      raceId: row.race_id,
      transferType: row.transfer_type,
      toWallet: row.to_wallet,
      amount: row.amount,
      txSig: row.tx_sig,
      currency: row.currency,
      ts: row.ts,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      batchId: row.batch_id
    }));
  }

  async getSettlementTransfersForWallet(wallet: string, limit: number = 20): Promise<any[]> {
    const query = 'SELECT * FROM settlement_transfers WHERE to_wallet = $1 ORDER BY ts DESC LIMIT $2';
    const res = await this.pool.query(query, [wallet, limit]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      raceId: row.race_id,
      transferType: row.transfer_type,
      toWallet: row.to_wallet,
      amount: row.amount,
      txSig: row.tx_sig,
      currency: row.currency,
      ts: row.ts,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      batchId: row.batch_id
    }));
  }

  async getSettlementTransferForRaceAndWallet(raceId: string, wallet: string): Promise<any | undefined> {
    const query = 'SELECT * FROM settlement_transfers WHERE race_id = $1 AND to_wallet = $2 ORDER BY ts DESC LIMIT 1';
    const res = await this.pool.query(query, [raceId, wallet]);
    const row = res.rows?.[0];
    
    if (!row) return undefined;

    return {
      id: row.id,
      raceId: row.race_id,
      transferType: row.transfer_type,
      toWallet: row.to_wallet,
      amount: row.amount,
      txSig: row.tx_sig,
      currency: row.currency,
      ts: row.ts,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      batchId: row.batch_id
    };
  }

  // Get failed or pending settlement transfers for retry
  async getFailedSettlementTransfers(limit: number = 100): Promise<any[]> {
    const query = `
      SELECT * FROM settlement_transfers 
      WHERE status IN ('PENDING', 'FAILED') 
      ORDER BY ts ASC 
      LIMIT $1
    `;
    const res = await this.pool.query(query, [limit]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      raceId: row.race_id,
      transferType: row.transfer_type,
      toWallet: row.to_wallet,
      amount: row.amount,
      txSig: row.tx_sig,
      currency: row.currency,
      ts: row.ts,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      batchId: row.batch_id
    }));
  }

  // Update settlement transfer status
  async updateSettlementTransferStatus(
    id: string, 
    status: 'PENDING' | 'SUCCESS' | 'FAILED', 
    opts?: { txSig?: string; error?: string; incrementAttempts?: boolean }
  ): Promise<void> {
    let query = `
      UPDATE settlement_transfers 
      SET status = $1
    `;
    const values: any[] = [status];
    let paramCount = 1;

    if (opts?.txSig) {
      paramCount++;
      query += `, tx_sig = $${paramCount}`;
      values.push(opts.txSig);
    }

    if (opts?.error !== undefined) {
      paramCount++;
      query += `, last_error = $${paramCount}`;
      values.push(opts.error);
    }

    if (opts?.incrementAttempts) {
      query += `, attempts = attempts + 1`;
    }

    paramCount++;
    query += ` WHERE id = $${paramCount}`;
    values.push(id);

    await this.pool.query(query, values);
  }

  async getSettlementErrors(raceId: string, limit: number = 100): Promise<any[]> {
    const query = 'SELECT * FROM settlement_errors WHERE race_id = $1 ORDER BY ts DESC LIMIT $2';
    const res = await this.pool.query(query, [raceId, limit]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      raceId: row.race_id,
      toWallet: row.to_wallet,
      amount: row.amount,
      currency: row.currency,
      error: row.error,
      ts: row.ts
    }));
  }

  async getRecentSettlementErrors(limit: number = 100): Promise<any[]> {
    const query = 'SELECT * FROM settlement_errors ORDER BY ts DESC LIMIT $1';
    const res = await this.pool.query(query, [limit]);

    return (res.rows || []).map((row: any) => ({
      id: row.id,
      raceId: row.race_id,
      toWallet: row.to_wallet,
      amount: row.amount,
      currency: row.currency,
      error: row.error,
      ts: row.ts
    }));
  }

  // ===== LEADERBOARD & USER STATS OPERATIONS =====

  async upsertUserRaceResult(result: { wallet: string; raceId: string; betAmount: string; payoutAmount: string; win: boolean; edgePoints: string; ts?: number; }): Promise<void> {
    const query = `
      INSERT INTO user_race_results (wallet, race_id, bet_amount, payout_amount, win, edge_points, ts)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (wallet, race_id) DO UPDATE SET
        bet_amount = EXCLUDED.bet_amount,
        payout_amount = EXCLUDED.payout_amount,
        win = EXCLUDED.win,
        edge_points = EXCLUDED.edge_points,
        ts = EXCLUDED.ts
    `;

    await this.pool.query(query, [
      result.wallet,
      result.raceId,
      result.betAmount,
      result.payoutAmount,
      result.win,
      result.edgePoints,
      result.ts ?? Date.now()
    ]);
  }

  async recalcUserStats(wallet: string): Promise<void> {
    const query = `SELECT bet_amount, payout_amount, win, edge_points FROM user_race_results WHERE wallet = $1`;
    const res = await this.pool.query(query, [wallet]);
    const rows = res.rows || [];

    const totalRaces = rows.length;
    let wins = 0;
    let totalWagered = new Decimal('0');
    let totalAwarded = new Decimal('0');
    let edgePoints = new Decimal('0');

    for (const r of rows) {
      if (r.win) wins++;
      totalWagered = totalWagered.add(new Decimal(r.bet_amount || '0'));
      totalAwarded = totalAwarded.add(new Decimal(r.payout_amount || '0'));
      edgePoints = edgePoints.add(new Decimal(r.edge_points || '0'));
    }

    const losses = Math.max(0, totalRaces - wins);
    const lastUpdated = Date.now();

    const upsertQuery = `
      INSERT INTO user_stats (wallet, total_races, wins, losses, total_wagered, total_awarded, edge_points, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (wallet) DO UPDATE SET
        total_races = EXCLUDED.total_races,
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        total_wagered = EXCLUDED.total_wagered,
        total_awarded = EXCLUDED.total_awarded,
        edge_points = EXCLUDED.edge_points,
        last_updated = EXCLUDED.last_updated
    `;

    await this.pool.query(upsertQuery, [
      wallet,
      totalRaces,
      wins,
      losses,
      totalWagered.toString(),
      totalAwarded.toString(),
      edgePoints.toString(),
      lastUpdated
    ]);
  }

  async getLeaderboard(limit: number = 10): Promise<Array<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number }>> {
    const query = `
      SELECT wallet, total_races, wins, losses, total_wagered, total_awarded, edge_points, last_updated
      FROM user_stats
      ORDER BY CAST(edge_points AS NUMERIC) DESC, wins DESC
      LIMIT $1
    `;
    const res = await this.pool.query(query, [limit]);

    return (res.rows || []).map((r: any) => ({
      wallet: String(r.wallet),
      totalRaces: Number(r.total_races) || 0,
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
      totalWagered: String(r.total_wagered ?? '0'),
      totalAwarded: String(r.total_awarded ?? '0'),
      edgePoints: String(r.edge_points ?? '0'),
      lastUpdated: Number(r.last_updated) || 0
    }));
  }

  async getUserStats(wallet: string): Promise<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number } | undefined> {
    const query = 'SELECT wallet, total_races, wins, losses, total_wagered, total_awarded, edge_points, last_updated FROM user_stats WHERE wallet = $1';
    const res = await this.pool.query(query, [wallet]);
    const r = res.rows?.[0];

    if (!r) return undefined;

    return {
      wallet: String(r.wallet),
      totalRaces: Number(r.total_races) || 0,
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
      totalWagered: String(r.total_wagered ?? '0'),
      totalAwarded: String(r.total_awarded ?? '0'),
      edgePoints: String(r.edge_points ?? '0'),
      lastUpdated: Number(r.last_updated) || 0
    };
  }

  async getUserRank(wallet: string): Promise<number | null> {
    const query = `
      WITH target AS (
        SELECT CAST(edge_points AS NUMERIC) AS ep FROM user_stats WHERE wallet = $1
      )
      SELECT CASE WHEN (SELECT ep FROM target) IS NULL THEN NULL ELSE 1 + (
        SELECT COUNT(1) FROM user_stats WHERE CAST(edge_points AS NUMERIC) > (SELECT ep FROM target)
      ) END AS rank
    `;
    const res = await this.pool.query(query, [wallet]);
    const rank = res.rows?.[0]?.rank;
    return rank === null || rank === undefined ? null : Number(rank);
  }

  async getUserStatsRowCount(): Promise<number> {
    const query = 'SELECT COUNT(1) AS count FROM user_stats';
    const res = await this.pool.query(query);
    return Number(res.rows?.[0]?.count || 0);
  }

  async getUserStatsSummary(): Promise<{ walletCount: number; lastUpdated: number }> {
    const query = 'SELECT COUNT(1) AS wallet_count, COALESCE(MAX(last_updated), 0) AS last_updated FROM user_stats';
    const res = await this.pool.query(query);
    const row = res.rows?.[0];
    return {
      walletCount: Number(row?.wallet_count || 0),
      lastUpdated: Number(row?.last_updated || 0)
    };
  }

  async getDistinctWalletsWithResults(): Promise<string[]> {
    const query = 'SELECT DISTINCT wallet FROM user_race_results';
    const res = await this.pool.query(query);
    return (res.rows || []).map(r => r.wallet);
  }

  async getUserRaceResultsSummary(): Promise<{ walletCount: number; lastUpdated: number }> {
    const query = 'SELECT COUNT(DISTINCT wallet) AS wallet_count, COALESCE(MAX(ts), 0) AS last_updated FROM user_race_results';
    const res = await this.pool.query(query);
    const row = res.rows?.[0];
    return {
      walletCount: Number(row?.wallet_count || 0),
      lastUpdated: Number(row?.last_updated || 0)
    };
  }

  async getLeaderboardFromResults(limit: number = 10): Promise<Array<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number }>> {
    const query = `
      SELECT wallet,
             COUNT(1) AS total_races,
             SUM(CASE WHEN win THEN 1 ELSE 0 END) AS wins,
             (COUNT(1) - SUM(CASE WHEN win THEN 1 ELSE 0 END)) AS losses,
             COALESCE(SUM(CAST(bet_amount AS NUMERIC)), 0)::TEXT AS total_wagered,
             COALESCE(SUM(CAST(payout_amount AS NUMERIC)), 0)::TEXT AS total_awarded,
             COALESCE(SUM(CAST(edge_points AS NUMERIC)), 0)::TEXT AS edge_points,
             COALESCE(MAX(ts), 0) AS last_updated
      FROM user_race_results
      GROUP BY wallet
      ORDER BY CAST(edge_points AS NUMERIC) DESC, wins DESC
      LIMIT $1
    `;
    const res = await this.pool.query(query, [limit]);

    return (res.rows || []).map((r: any) => ({
      wallet: String(r.wallet),
      totalRaces: Number(r.total_races) || 0,
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
      totalWagered: String(r.total_wagered ?? '0'),
      totalAwarded: String(r.total_awarded ?? '0'),
      edgePoints: String(r.edge_points ?? '0'),
      lastUpdated: Number(r.last_updated) || 0
    }));
  }

  async getRacePotSnapshot(raceId: string): Promise<{ totalPot: string; betCount: number }> {
    const query = `
      SELECT 
        COALESCE(SUM(CAST(bet_amount AS NUMERIC)), 0)::TEXT AS total_pot,
        COUNT(1) AS bet_count
      FROM user_race_results
      WHERE race_id = $1
    `;
    const res = await this.pool.query(query, [raceId]);
    const row = res.rows?.[0];
    return {
      totalPot: String(row?.total_pot ?? '0'),
      betCount: Number(row?.bet_count ?? 0)
    };
  }

  async getUserStatsFromResults(wallet: string): Promise<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number } | undefined> {
    const query = `
      SELECT wallet,
             COUNT(1) AS total_races,
             SUM(CASE WHEN win THEN 1 ELSE 0 END) AS wins,
             (COUNT(1) - SUM(CASE WHEN win THEN 1 ELSE 0 END)) AS losses,
             COALESCE(SUM(CAST(bet_amount AS NUMERIC)), 0)::TEXT AS total_wagered,
             COALESCE(SUM(CAST(payout_amount AS NUMERIC)), 0)::TEXT AS total_awarded,
             COALESCE(SUM(CAST(edge_points AS NUMERIC)), 0)::TEXT AS edge_points,
             COALESCE(MAX(ts), 0) AS last_updated
      FROM user_race_results
      WHERE wallet = $1
      GROUP BY wallet
    `;
    const res = await this.pool.query(query, [wallet]);
    const r = res.rows?.[0];

    if (!r) return undefined;

    return {
      wallet: String(r.wallet),
      totalRaces: Number(r.total_races) || 0,
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
      totalWagered: String(r.total_wagered ?? '0'),
      totalAwarded: String(r.total_awarded ?? '0'),
      edgePoints: String(r.edge_points ?? '0'),
      lastUpdated: Number(r.last_updated) || 0
    };
  }

  async getUserRankFromResults(wallet: string): Promise<number | null> {
    const query = `
      WITH aggregated AS (
        SELECT wallet, SUM(CAST(edge_points AS NUMERIC)) AS ep FROM user_race_results GROUP BY wallet
      )
      SELECT CASE WHEN (SELECT ep FROM aggregated WHERE wallet = $1) IS NULL THEN NULL ELSE 1 + (
        SELECT COUNT(1) FROM aggregated WHERE ep > (SELECT ep FROM aggregated WHERE wallet = $1)
      ) END AS rank
    `;
    const res = await this.pool.query(query, [wallet, wallet]);
    const rank = res.rows?.[0]?.rank;
    return rank === null || rank === undefined ? null : Number(rank);
  }

  async rebuildUserStatsFromResults(): Promise<void> {
    const query = `
      SELECT wallet,
             COUNT(1) AS total_races,
             SUM(CASE WHEN win THEN 1 ELSE 0 END) AS wins,
             (COUNT(1) - SUM(CASE WHEN win THEN 1 ELSE 0 END)) AS losses,
             COALESCE(SUM(CAST(bet_amount AS NUMERIC)), 0)::TEXT AS total_wagered,
             COALESCE(SUM(CAST(payout_amount AS NUMERIC)), 0)::TEXT AS total_awarded,
             COALESCE(SUM(CAST(edge_points AS NUMERIC)), 0)::TEXT AS edge_points,
             COALESCE(MAX(ts), 0) AS last_updated
      FROM user_race_results
      GROUP BY wallet
    `;
    const res = await this.pool.query(query);
    const now = Date.now();

    for (const r of res.rows || []) {
      const upsertQuery = `
        INSERT INTO user_stats (wallet, total_races, wins, losses, total_wagered, total_awarded, edge_points, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (wallet) DO UPDATE SET
          total_races = EXCLUDED.total_races,
          wins = EXCLUDED.wins,
          losses = EXCLUDED.losses,
          total_wagered = EXCLUDED.total_wagered,
          total_awarded = EXCLUDED.total_awarded,
          edge_points = EXCLUDED.edge_points,
          last_updated = EXCLUDED.last_updated
      `;

      await this.pool.query(upsertQuery, [
        r.wallet,
        Number(r.total_races) || 0,
        Number(r.wins) || 0,
        Number(r.losses) || 0,
        String(r.total_wagered ?? '0'),
        String(r.total_awarded ?? '0'),
        String(r.edge_points ?? '0'),
        now
      ]);
    }
  }

  async getLeaderboardFromPostgres(limit: number = 10): Promise<Array<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number }>> {
    // Same as getLeaderboard
    return this.getLeaderboard(limit);
  }

  async getUserStatsFromPostgres(wallet: string): Promise<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number } | undefined> {
    // Same as getUserStats
    return this.getUserStats(wallet);
  }

  async getUserRankFromPostgres(wallet: string): Promise<number | null> {
    // Same as getUserRank
    return this.getUserRank(wallet);
  }

  async getUserRecentResults(wallet: string, limit: number = 20): Promise<Array<{ raceId: string; betAmount: string; payoutAmount: string; win: number; edgePoints: string; ts: number }>> {
    const query = 'SELECT race_id, bet_amount, payout_amount, win, edge_points, ts FROM user_race_results WHERE wallet = $1 ORDER BY ts DESC LIMIT $2';
    const res = await this.pool.query(query, [wallet, limit]);

    return (res.rows || []).map((row: any) => ({
      raceId: row.race_id,
      betAmount: row.bet_amount,
      payoutAmount: row.payout_amount,
      win: row.win ? 1 : 0,
      edgePoints: row.edge_points,
      ts: row.ts
    }));
  }

  async getLedgerAggregates(): Promise<{ totalBets: string; totalPayouts: string; totalRake: string }> {
    const betsQuery = "SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0)::TEXT AS total FROM bets";
    const payoutsQuery = "SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0)::TEXT AS total FROM settlement_transfers WHERE transfer_type = 'PAYOUT'";
    const rakeQuery = "SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0)::TEXT AS total FROM settlement_transfers WHERE transfer_type = 'RAKE'";

    const [bRes, pRes, rRes] = await Promise.all([
      this.pool.query(betsQuery),
      this.pool.query(payoutsQuery),
      this.pool.query(rakeQuery)
    ]);

    return {
      totalBets: String(bRes.rows?.[0]?.total || '0'),
      totalPayouts: String(pRes.rows?.[0]?.total || '0'),
      totalRake: String(rRes.rows?.[0]?.total || '0')
    };
  }

  // ===== RECENT WINNERS OPERATIONS =====

  async upsertRecentWinnerRaw(raceId: string, raceData: string, settledAt: number): Promise<void> {
    const query = `
      INSERT INTO recent_winners (race_id, race_data, settled_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(race_id) DO UPDATE SET
        race_data = EXCLUDED.race_data,
        settled_at = EXCLUDED.settled_at
    `;
    await this.pool.query(query, [raceId, raceData, settledAt]);
  }

  async cleanupRecentWinners(limit: number = 6): Promise<void> {
    const query = `
      DELETE FROM recent_winners 
      WHERE id NOT IN (
        SELECT id FROM recent_winners 
        ORDER BY settled_at DESC 
        LIMIT $1
      )
    `;
    await this.pool.query(query, [limit]);
  }

  async addRecentWinner(race: Race): Promise<void> {
    // Only add if race is settled with a winner
    if (race.status !== 'SETTLED' || race.winnerIndex === undefined) {
      return;
    }

    // Compute pot snapshot
    const bets = await this.getBetsForRace(race.id);
    const betsSol = bets.filter(b => (b?.currency || 'RACE') === 'SOL');
    const betsRace = bets.filter(b => (b?.currency || 'RACE') !== 'SOL');
    const totalPotSol = betsSol.reduce((sum: number, b: any) => sum + parseFloat(b.amount || '0'), 0);
    const totalPotRace = betsRace.reduce((sum: number, b: any) => sum + parseFloat(b.amount || '0'), 0);
    const totalPotNum = totalPotSol + totalPotRace;
    const betCount = bets.length;
    const betCountSol = betsSol.length;
    const betCountRace = betsRace.length;

    const enrichedRace: any = { 
      ...race, 
      totalPot: String(totalPotNum), 
      betCount,
      totalPotSol: totalPotSol.toString(),
      totalPotRace: totalPotRace.toString(),
      betCountSol,
      betCountRace
    };
    const raceData = JSON.stringify(enrichedRace);
    const settledAt = Date.now();

    await this.upsertRecentWinnerRaw(race.id, raceData, settledAt);
    await this.cleanupRecentWinners(6);
  }

  async getRecentWinners(limit: number = 6): Promise<Race[]> {
    const query = 'SELECT race_data FROM recent_winners ORDER BY settled_at DESC LIMIT $1';
    const res = await this.pool.query(query, [limit]);
    
    return (res.rows || []).map(row => {
      try {
        return JSON.parse(row.race_data);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  // ===== REFERRAL OPERATIONS =====

  async upsertReferralUser({ wallet, code }: { wallet: string; code: string }): Promise<{ wallet: string; code: string }> {
    const now = Date.now();
    const query = `
      INSERT INTO referral_users (wallet, code, created_at, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(wallet) DO UPDATE SET code=EXCLUDED.code, updated_at=EXCLUDED.updated_at
    `;
    await this.pool.query(query, [wallet, code, now, now]);
    return { wallet, code };
  }

  async getReferralUserByWallet(wallet: string): Promise<{ wallet: string; code: string; verified: boolean; verifiedAt?: number; createdAt: number; updatedAt: number } | undefined> {
    const query = 'SELECT wallet, code, verified, verified_at, created_at, updated_at FROM referral_users WHERE wallet = $1';
    const res = await this.pool.query(query, [wallet]);
    const row = res.rows?.[0];
    
    if (!row) return undefined;

    return {
      wallet: row.wallet,
      code: row.code,
      verified: Boolean(row.verified),
      verifiedAt: row.verified_at ? Number(row.verified_at) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async getReferralUserByCode(code: string): Promise<{ wallet: string; code: string; verified: boolean; verifiedAt?: number; createdAt: number; updatedAt: number } | undefined> {
    const query = 'SELECT wallet, code, verified, verified_at, created_at, updated_at FROM referral_users WHERE code = $1';
    const res = await this.pool.query(query, [code]);
    const row = res.rows?.[0];
    
    if (!row) return undefined;

    return {
      wallet: row.wallet,
      code: row.code,
      verified: Boolean(row.verified),
      verifiedAt: row.verified_at ? Number(row.verified_at) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async markReferralUserVerified(wallet: string): Promise<void> {
    const now = Date.now();
    const query = `
      UPDATE referral_users 
      SET verified = TRUE, verified_at = $1, updated_at = $2
      WHERE wallet = $3
    `;
    await this.pool.query(query, [now, now, wallet]);
  }

  async upsertReferralAttribution({ id, wallet, code, source }: { id: string; wallet: string; code: string; source?: string }): Promise<void> {
    const now = Date.now();
    const query = `
      INSERT INTO referral_attributions (id, wallet, code, source, first_seen, last_seen)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code, source=EXCLUDED.source, last_seen=EXCLUDED.last_seen
    `;
    await this.pool.query(query, [id, wallet, code, source ?? null, now, now]);
  }

  async getReferralAttributionForWallet(wallet: string): Promise<{ id: string; wallet: string; code: string } | undefined> {
    const query = 'SELECT * FROM referral_attributions WHERE wallet = $1 ORDER BY last_seen DESC LIMIT 1';
    const res = await this.pool.query(query, [wallet]);
    const row = res.rows?.[0];
    
    if (!row) return undefined;

    return {
      id: row.id,
      wallet: row.wallet,
      code: row.code
    };
  }

  async getReferralSettings(): Promise<any> {
    const query = "SELECT * FROM referral_settings WHERE id='main'";
    const res = await this.pool.query(query);
    return res.rows?.[0];
  }

  async updateReferralSettings(settings: Partial<{ enabled: boolean; discountBps: number; level1Bps: number; level2Bps: number; level3Bps: number; poolBps: number; minPayout: string; payoutCron: string }>): Promise<void> {
    const current = await this.getReferralSettings();
    const merged = {
      enabled: (settings.enabled ?? (current?.enabled ?? 1)) ? 1 : 0,
      discountBps: settings.discountBps ?? current?.discount_bps ?? 500,
      level1Bps: settings.level1Bps ?? current?.level1_bps ?? 3000,
      level2Bps: settings.level2Bps ?? current?.level2_bps ?? 600,
      level3Bps: settings.level3Bps ?? current?.level3_bps ?? 200,
      poolBps: settings.poolBps ?? current?.pool_bps ?? 5000,
      minPayout: settings.minPayout ?? current?.min_payout ?? '0.01',
      payoutCron: settings.payoutCron ?? current?.payout_cron ?? 'daily'
    };

    const query = `
      UPDATE referral_settings 
      SET enabled=$1, discount_bps=$2, level1_bps=$3, level2_bps=$4, level3_bps=$5, pool_bps=$6, min_payout=$7, payout_cron=$8
      WHERE id='main'
    `;
    await this.pool.query(query, [
      merged.enabled,
      merged.discountBps,
      merged.level1Bps,
      merged.level2Bps,
      merged.level3Bps,
      merged.poolBps,
      merged.minPayout,
      merged.payoutCron
    ]);
  }

  async insertReferralReward(row: { id: string; raceId: string; fromWallet: string; toWallet: string; level: number; currency: 'RACE' | 'SOL'; amount: string; ts?: number }): Promise<void> {
    const ts = row.ts ?? Date.now();
    const query = `
      INSERT INTO referral_rewards (id, race_id, from_wallet, to_wallet, level, currency, amount, status, ts)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
      ON CONFLICT(id) DO NOTHING
    `;
    await this.pool.query(query, [row.id, row.raceId, row.fromWallet, row.toWallet, row.level, row.currency, row.amount, ts]);
  }

  async markReferralRewardPaid(id: string, txSig: string): Promise<void> {
    const query = "UPDATE referral_rewards SET status='PAID', tx_sig=$1 WHERE id=$2";
    await this.pool.query(query, [txSig, id]);
  }

  async getUnpaidReferralRewards(limit: number = 500): Promise<any[]> {
    const query = `
      SELECT 
        id,
        race_id as "raceId",
        from_wallet as "fromWallet",
        to_wallet as "toWallet",
        level,
        currency,
        amount,
        status,
        tx_sig as "txSig",
        ts
      FROM referral_rewards 
      WHERE status='PENDING' AND CAST(amount AS NUMERIC) != 0 
      ORDER BY ts ASC 
      LIMIT $1
    `;
    const res = await this.pool.query(query, [limit]);
    return res.rows || [];
  }

  async upsertReferralAggregate(row: { wallet: string; directCount: number; indirectCount: number; totalRewards: string; totalPaid: string; ts?: number }): Promise<void> {
    const query = `
      INSERT INTO referral_aggregates (wallet, direct_count, indirect_count, total_rewards, total_paid, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(wallet) DO UPDATE SET 
        direct_count=EXCLUDED.direct_count, 
        indirect_count=EXCLUDED.indirect_count, 
        total_rewards=EXCLUDED.total_rewards, 
        total_paid=EXCLUDED.total_paid, 
        last_updated=EXCLUDED.last_updated
    `;
    await this.pool.query(query, [
      row.wallet,
      row.directCount,
      row.indirectCount,
      row.totalRewards,
      row.totalPaid,
      row.ts ?? Date.now()
    ]);
  }

  async getReferralAggregate(wallet: string): Promise<any | undefined> {
    const query = 'SELECT * FROM referral_aggregates WHERE wallet = $1';
    const res = await this.pool.query(query, [wallet]);
    return res.rows?.[0];
  }

  async getReferralRewardSumsForRace(raceId: string): Promise<{ RACE: { paid: string; pending: string }; SOL: { paid: string; pending: string } }> {
    const query = `
      SELECT currency, status, COALESCE(SUM(CAST(amount AS NUMERIC)), 0)::TEXT AS total
      FROM referral_rewards
      WHERE race_id = $1
      GROUP BY currency, status
    `;
    const res = await this.pool.query(query, [raceId]);
    const result: any = { RACE: { paid: '0', pending: '0' }, SOL: { paid: '0', pending: '0' } };
    
    for (const r of res.rows || []) {
      const cur = (String(r.currency || 'RACE').toUpperCase() === 'SOL') ? 'SOL' : 'RACE';
      const st = (String(r.status || 'PENDING').toUpperCase() === 'PAID') ? 'paid' : 'pending';
      result[cur][st] = String(r.total || '0');
    }
    
    return result;
  }

  async getDirectReferrals(code: string): Promise<string[]> {
    const query = 'SELECT wallet FROM referral_attributions WHERE code = $1';
    const res = await this.pool.query(query, [code]);
    return (res.rows || []).map(r => r.wallet);
  }

  async getCodesForWallets(wallets: string[]): Promise<string[]> {
    if (wallets.length === 0) return [];
    
    const query = 'SELECT code FROM referral_users WHERE wallet = ANY($1)';
    const res = await this.pool.query(query, [wallets]);
    return (res.rows || []).map(r => r.code).filter(Boolean);
  }

  async getReferralTotalsForWallet(wallet: string, currency: 'SOL' | 'RACE'): Promise<{ pending: string; paid: string }> {
    const query = `
      SELECT 
        COALESCE(SUM(CASE WHEN status='PENDING' THEN CAST(amount AS NUMERIC) ELSE 0 END), 0)::TEXT AS pending,
        COALESCE(SUM(CASE WHEN status='PAID' THEN CAST(amount AS NUMERIC) ELSE 0 END), 0)::TEXT AS paid
      FROM referral_rewards
      WHERE to_wallet = $1 AND currency = $2
    `;
    const res = await this.pool.query(query, [wallet, currency]);
    const r = res.rows?.[0];
    return {
      pending: String(r?.pending || '0'),
      paid: String(r?.paid || '0')
    };
  }

  // ===== TREASURY OPERATIONS =====

  async getTreasury(): Promise<Treasury> {
    const query = 'SELECT * FROM treasury WHERE state = $1';
    const res = await this.pool.query(query, ['main']);
    const row = res.rows?.[0];
    
    if (!row) {
      // Initialize default treasury if not exists
      const defaultTreasury: Treasury = {
        jackpotBalance: '0',
        jackpotBalanceSol: '0',
        raceMint: undefined,
        maintenanceMode: false,
        maintenanceMessage: undefined,
        maintenanceAnchorRaceId: undefined
      };
      // Insert directly to avoid infinite recursion (updateTreasury calls getTreasury)
      const insertQuery = `
        INSERT INTO treasury (state, jackpot_balance, jackpot_balance_sol, race_mint, maintenance_mode, maintenance_message, maintenance_anchor_race_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (state) DO NOTHING
      `;
      await this.pool.query(insertQuery, [
        'main',
        defaultTreasury.jackpotBalance,
        defaultTreasury.jackpotBalanceSol,
        null,
        0, // maintenance_mode: 0 = false (INTEGER type)
        null,
        null
      ]);
      return defaultTreasury;
    }

    // Clamp negative balances to zero
    const safeJackpotRace = new Decimal(row.jackpot_balance || '0');
    const safeJackpotSol = new Decimal(row.jackpot_balance_sol || '0');
    
    return {
      jackpotBalance: (safeJackpotRace.isNegative() ? new Decimal(0) : safeJackpotRace).toString(),
      jackpotBalanceSol: (safeJackpotSol.isNegative() ? new Decimal(0) : safeJackpotSol).toString(),
      raceMint: row.race_mint || undefined,
      maintenanceMode: Boolean(row.maintenance_mode),
      maintenanceMessage: row.maintenance_message || undefined,
      maintenanceAnchorRaceId: row.maintenance_anchor_race_id || undefined
    } as Treasury;
  }

  async updateTreasury(updates: Partial<Treasury>): Promise<void> {
    const current = await this.getTreasury();
    const merged = { ...current, ...updates } as any;
    
    const query = `
      INSERT INTO treasury (state, jackpot_balance, jackpot_balance_sol, race_mint, maintenance_mode, maintenance_message, maintenance_anchor_race_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (state) DO UPDATE SET
        jackpot_balance = EXCLUDED.jackpot_balance,
        jackpot_balance_sol = EXCLUDED.jackpot_balance_sol,
        race_mint = EXCLUDED.race_mint,
        maintenance_mode = EXCLUDED.maintenance_mode,
        maintenance_message = EXCLUDED.maintenance_message,
        maintenance_anchor_race_id = EXCLUDED.maintenance_anchor_race_id
    `;
    
    await this.pool.query(query, [
      'main',
      merged.jackpotBalance ?? current.jackpotBalance,
      merged.jackpotBalanceSol ?? current.jackpotBalanceSol,
      merged.raceMint ?? null,
      merged.maintenanceMode ? 1 : 0,
      merged.maintenanceMessage ?? null,
      merged.maintenanceAnchorRaceId ?? null
    ]);
  }

  async adjustJackpotBalances(deltas: { deltaRace?: string | Decimal; deltaSol?: string | Decimal }): Promise<{ jackpotBalance: string; jackpotBalanceSol: string }> {
    const deltaRaceStr = deltas?.deltaRace !== undefined ? String(deltas.deltaRace) : '0';
    const deltaSolStr = deltas?.deltaSol !== undefined ? String(deltas.deltaSol) : '0';
    
    // Use a transaction for atomic update
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      const selectQuery = 'SELECT jackpot_balance, jackpot_balance_sol FROM treasury WHERE state = $1 FOR UPDATE';
      const res = await client.query(selectQuery, ['main']);
      const row = res.rows?.[0];
      
      const currentRace = new Decimal(row?.jackpot_balance || '0');
      const currentSol = new Decimal(row?.jackpot_balance_sol || '0');
      const nextRace = currentRace.add(new Decimal(deltaRaceStr || '0'));
      const nextSol = currentSol.add(new Decimal(deltaSolStr || '0'));
      const clampedRace = nextRace.isNegative() ? new Decimal(0) : nextRace;
      const clampedSol = nextSol.isNegative() ? new Decimal(0) : nextSol;
      
      const updateQuery = 'UPDATE treasury SET jackpot_balance = $1, jackpot_balance_sol = $2 WHERE state = $3';
      await client.query(updateQuery, [clampedRace.toString(), clampedSol.toString(), 'main']);
      
      await client.query('COMMIT');
      
      return { jackpotBalance: clampedRace.toString(), jackpotBalanceSol: clampedSol.toString() };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ===== TRANSACTION DEDUPLICATION =====

  async hasSeenTransaction(sig: string): Promise<boolean> {
    const query = 'SELECT 1 FROM seen_tx WHERE sig = $1';
    const res = await this.pool.query(query, [sig]);
    return res.rows && res.rows.length > 0;
  }

  async recordTransaction(sig: string): Promise<void> {
    const query = `
      INSERT INTO seen_tx (sig, seen_at)
      VALUES ($1, $2)
      ON CONFLICT (sig) DO UPDATE SET seen_at = EXCLUDED.seen_at
    `;
    await this.pool.query(query, [sig, Date.now()]);
  }

  async cleanupOldTransactions(maxAge: number = 48 * 60 * 60 * 1000): Promise<void> {
    const cutoff = Date.now() - maxAge;
    const query = 'DELETE FROM seen_tx WHERE seen_at < $1';
    await this.pool.query(query, [cutoff]);
  }

  async reserveTransaction(sig: string): Promise<boolean> {
    try {
      const query = 'INSERT INTO seen_tx (sig, seen_at) VALUES ($1, $2)';
      await this.pool.query(query, [sig, Date.now()]);
      return true;
    } catch {
      return false;
    }
  }

  async releaseTransaction(sig: string): Promise<void> {
    try {
      const query = 'DELETE FROM seen_tx WHERE sig = $1';
      await this.pool.query(query, [sig]);
    } catch {}
  }

  // ===== ADMIN OPERATIONS =====

  async clearRaces(): Promise<void> {
    // PRODUCTION SAFETY: Block destructive operations in production
    const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
    const isReplit = Boolean(process.env.REPLIT_DEPLOYMENT);
    
    if (isProd && isReplit && process.env.ALLOW_RESET !== '1') {
      console.error('⛔ clearRaces() is BLOCKED in production');
      console.error('⛔ This would delete all race/bet data');
      console.error('⛔ Set ALLOW_RESET=1 to override (NOT RECOMMENDED)');
      throw new Error('clearRaces blocked in production - would cause data loss');
    }
    
    await this.pool.query('DELETE FROM bets');
    await this.pool.query('DELETE FROM races');
    console.log("🗑️ Cleared all races and bets");
  }

  // Placeholder/No-op methods
  close(): void {
    // Postgres pool closing is handled externally
  }

  checkpoint(): void {
    // No-op for Postgres (no WAL checkpointing needed)
  }
}
