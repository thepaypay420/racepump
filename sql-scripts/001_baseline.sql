-- Baseline migration: Create all tables if they don't exist
-- This migration is idempotent and safe to run multiple times

-- Races table
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS races (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    start_ts BIGINT,
    end_ts BIGINT,
    winner_index INTEGER,
    drand_round INTEGER,
    drand_randomness TEXT,
    drand_signature TEXT,
    runners TEXT NOT NULL,
    settled_slot BIGINT,
    settled_block_time_ms BIGINT,
    created_at BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Predictions table (legacy, may not be actively used)
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS predictions (
    id TEXT PRIMARY KEY,
    race_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    runner_idx INTEGER NOT NULL,
    amount NUMERIC NOT NULL,
    sig TEXT NOT NULL,
    ts BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Claims table
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    race_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    sig TEXT NOT NULL,
    ts BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Seen transactions table for deduplication
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS seen_tx (
    sig TEXT PRIMARY KEY,
    seen_at BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Bets table for both RACE and SOL currency bets
-- Use DO block to handle pg_type constraint errors from concurrent/failed migrations
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    race_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    runner_idx INTEGER NOT NULL,
    amount NUMERIC NOT NULL,
    sig TEXT NOT NULL,
    ts BIGINT NOT NULL,
    block_time_ms BIGINT,
    slot BIGINT,
    client_id TEXT,
    memo TEXT,
    currency TEXT DEFAULT 'RACE'
  );
EXCEPTION
  WHEN duplicate_object THEN
    -- Table already exists (from concurrent migration or previous partial run)
    NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_bet_sig ON bets(sig);

-- User race results for leaderboard
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS user_race_results (
    wallet TEXT NOT NULL,
    race_id TEXT NOT NULL,
    bet_amount NUMERIC NOT NULL,
    payout_amount NUMERIC NOT NULL,
    win BOOLEAN NOT NULL,
    edge_points NUMERIC NOT NULL,
    ts BIGINT NOT NULL,
    PRIMARY KEY (wallet, race_id)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- User stats aggregated for fast leaderboard queries
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS user_stats (
    wallet TEXT PRIMARY KEY,
    total_races INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    total_wagered NUMERIC NOT NULL DEFAULT 0,
    total_awarded NUMERIC NOT NULL DEFAULT 0,
    edge_points NUMERIC NOT NULL DEFAULT 0,
    last_updated BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Recent winners for UI display
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS recent_winners (
    id SERIAL PRIMARY KEY,
    race_id TEXT UNIQUE NOT NULL,
    race_data JSONB NOT NULL,
    settled_at BIGINT NOT NULL,
    total_pot NUMERIC,
    bet_count INTEGER
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_recent_winners_settled_pg ON recent_winners (settled_at DESC);

-- Settlement transfers (receipts)
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS settlement_transfers (
    id TEXT PRIMARY KEY,
    race_id TEXT NOT NULL,
    transfer_type TEXT NOT NULL,
    to_wallet TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    tx_sig TEXT NOT NULL,
    currency TEXT DEFAULT 'RACE',
    ts BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_settlement_transfers_wallet_ts ON settlement_transfers(to_wallet, ts DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_transfers_race ON settlement_transfers(race_id);

-- Settlement errors for observability
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS settlement_errors (
    id TEXT PRIMARY KEY,
    race_id TEXT NOT NULL,
    to_wallet TEXT,
    amount NUMERIC,
    currency TEXT DEFAULT 'RACE',
    error TEXT NOT NULL,
    ts BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Referral users
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS referral_users (
    wallet TEXT PRIMARY KEY,
    code TEXT UNIQUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Referral attributions
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS referral_attributions (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    code TEXT NOT NULL,
    source TEXT,
    first_seen BIGINT NOT NULL,
    last_seen BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Referral rewards
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS referral_rewards (
    id TEXT PRIMARY KEY,
    race_id TEXT NOT NULL,
    from_wallet TEXT NOT NULL,
    to_wallet TEXT NOT NULL,
    level INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RACE',
    amount NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    tx_sig TEXT,
    ts BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Treasury table for app state
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS treasury (
    state TEXT PRIMARY KEY DEFAULT 'main',
    jackpot_balance NUMERIC NOT NULL DEFAULT 0,
    jackpot_balance_sol NUMERIC NOT NULL DEFAULT 0,
    race_mint TEXT,
    maintenance_mode INTEGER NOT NULL DEFAULT 0,
    maintenance_message TEXT,
    maintenance_anchor_race_id TEXT
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO treasury(state)
VALUES ('main')
ON CONFLICT (state) DO NOTHING;

-- Referral settings
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS referral_settings (
    id TEXT PRIMARY KEY DEFAULT 'main',
    enabled INTEGER NOT NULL DEFAULT 1,
    discount_bps INTEGER NOT NULL DEFAULT 500,
    level1_bps INTEGER NOT NULL DEFAULT 3000,
    level2_bps INTEGER NOT NULL DEFAULT 600,
    level3_bps INTEGER NOT NULL DEFAULT 200,
    pool_bps INTEGER NOT NULL DEFAULT 5000,
    min_payout NUMERIC NOT NULL DEFAULT 0.01,
    payout_cron TEXT NOT NULL DEFAULT 'daily'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO referral_settings(id)
VALUES ('main')
ON CONFLICT (id) DO NOTHING;

-- Referral aggregates
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS referral_aggregates (
    wallet TEXT PRIMARY KEY,
    direct_count INTEGER NOT NULL DEFAULT 0,
    indirect_count INTEGER NOT NULL DEFAULT 0,
    total_rewards NUMERIC NOT NULL DEFAULT 0,
    total_paid NUMERIC NOT NULL DEFAULT 0,
    last_updated BIGINT NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Migration tracking table is created automatically by the migration runner
-- (see scripts/sql-migrations.ts - uses app_migrations table, NOT drizzle_migrations)
-- No need to create it here.
