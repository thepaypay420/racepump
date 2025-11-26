import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { Race, Prediction, Claim, Treasury } from "@shared/schema";
import { Pool } from "pg";
import { PostgresStorage } from "./postgres-storage";

type RaceBetAggregateMap = Record<string, {
  totalPotSol: string;
  betCountSol: number;
  totalPotRace: string;
  betCountRace: number;
}>;

if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
  console.log("🔍 Environment debug:");
  console.log("- NODE_ENV:", process.env.NODE_ENV);
  console.log("- REPLIT_DEPLOYMENT:", process.env.REPLIT_DEPLOYMENT);
  console.log("- DATABASE_URL present:", !!process.env.DATABASE_URL);
  console.log("- PGHOST present:", !!process.env.PGHOST);
}

// Runtime driver selection based on environment
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const forcePg = process.env.FORCE_PG === 'true' || process.env.FORCE_PG === '1';
const usePostgres = isProd || forcePg;

console.log(`\n${"═".repeat(80)}`);
console.log(`[DB DRIVER SELECTION]`);
console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`  FORCE_PG: ${process.env.FORCE_PG || 'false'}`);
console.log(`  Selected driver: ${usePostgres ? 'POSTGRES' : 'SQLITE'}`);
console.log(`${"═".repeat(80)}\n`);

let db: any;
let pgPool: Pool | null = null;
let pgReady = false;
let sqlitePath: string = '';
let lastPgConfigInfo: { usedKey: string | null; connectionStringRedacted: string | null } = { usedKey: null, connectionStringRedacted: null };

function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^@]*@/, '//***@');
  }
}

// Helper to add timeout to promises
function withMigrationTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`Migration timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

async function checkTablesExist(pool: Pool): Promise<boolean> {
  try {
    // Check if essential tables exist
    const essentialTables = ['races', 'bets', 'user_stats', 'claims'];
    
    for (const table of essentialTables) {
      const result = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        )`,
        [table]
      );
      
      if (!result.rows[0].exists) {
        console.log(`❌ Table ${table} does not exist`);
        return false;
      }
    }
    
    console.log(`✅ All essential tables exist`);
    return true;
  } catch (error) {
    console.error('❌ Error checking tables:', error);
    return false;
  }
}

async function runProductionMigrations(pool: Pool): Promise<void> {
  try {
    console.log('🔄 Running SQL migrations (checking for new migrations)...');
    
    // Always run migration system - it tracks which migrations have been applied
    // and only runs new ones. This ensures incremental migrations work correctly.
    const { runSqlMigrations } = await import('../scripts/sql-migrations.ts');
    await runSqlMigrations(pool);
    
    console.log('✅ Migrations complete');
  } catch (error: any) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

async function initPostgres(maxRetries: number = 3, delayMs: number = 1000): Promise<void> {
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  const isReplit = !!(process.env.REPLIT_DEPLOYMENT || process.env.REPL_ID);
  
  // Build pool configuration from either DATABASE_URL or PG* envs
  const readEnvOrFile = (name: string): string => {
    const direct = (process.env[name] || '').trim();
    if (direct) return direct;
    const filePath = (process.env[`${name}_FILE`] || '').trim();
    if (filePath) {
      try {
        return String(fs.readFileSync(filePath)).trim();
      } catch {}
    }
    const b64 = (process.env[`${name}_B64`] || '').trim();
    if (b64) {
      try { return Buffer.from(b64, 'base64').toString('utf8').trim(); } catch {}
    }
    return '';
  };

  const getPoolConfig = () => {
    // Common connection string env names across providers
    const urlCandidates = [
      'DATABASE_URL',
      'NEON_DATABASE_URL',
      'POSTGRES_URL',
      'SUPABASE_DB_URL',
      'PG_CONNECTION_STRING',
      'PGURL',
    ];
    let usedKey: string | null = null;
    let url = '';
    for (const key of urlCandidates) {
      const v = readEnvOrFile(key);
      if (v) { url = v; usedKey = key; break; }
    }
    if (url) {
      console.log(`📦 Using Postgres connection string from ${usedKey}`);
      // Ensure Neon/supabase style URLs enforce SSL
      if (!/sslmode=/.test(url)) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}sslmode=require`;
      }
      try {
        lastPgConfigInfo = {
          usedKey,
          connectionStringRedacted: redactConnectionString(url)
        };
      } catch {}
      return { connectionString: url, ssl: { rejectUnauthorized: false } } as any;
    }
    // Individual PG* pieces
    const host = readEnvOrFile('PGHOST');
    const user = readEnvOrFile('PGUSER');
    const database = readEnvOrFile('PGDATABASE');
    const password = readEnvOrFile('PGPASSWORD');
    const port = Number((readEnvOrFile('PGPORT') || '5432'));
    if (host && user && database && password) {
      console.log('📦 Using Postgres PG* environment variables');
      try {
        lastPgConfigInfo = {
          usedKey: 'PG*',
          connectionStringRedacted: `${host}:${port}/${database}`
        };
      } catch {}
      return { host, user, database, password, port, ssl: { rejectUnauthorized: false } } as any;
    }
    return null;
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const poolConfig = getPoolConfig();
      if (!poolConfig) {
        if (isProd && isReplit) {
          console.error('');
          console.error('═'.repeat(80));
          console.error('❌ CRITICAL: DATABASE_URL is REQUIRED for production persistence!');
          console.error('');
          console.error('Without Postgres, receipts/leaderboard/referrals will reset on redeploy.');
          console.error('');
          console.error('To fix:');
          console.error('1. Sign up for Neon Postgres (free): https://neon.tech');
          console.error('2. Create a database and copy the connection string');
          console.error('3. Set DATABASE_URL in Replit Secrets:');
          console.error('   DATABASE_URL=postgres://user:pass@host.neon.tech/dbname?sslmode=require');
          console.error('');
          console.error('Continuing with SQLite (data will be lost on redeploy)...');
          console.error('═'.repeat(80));
          console.error('');
        } else {
          console.log("🛑 No DATABASE_URL or PG* env provided; skipping Postgres init");
        }
        return;
      }

      // Initialize PG Pool (Neon requires SSL)
      pgPool = new Pool(poolConfig);
      try {
        console.log(`🔌 Postgres pool created (source=${lastPgConfigInfo.usedKey || 'unknown'}) -> ${lastPgConfigInfo.connectionStringRedacted || '(redacted)'}`);
      } catch {}

      // Test connection
      await pgPool.query('SELECT 1');
      console.log("✅ Postgres connection verified");
      
      // Run migrations to create tables
      // Migrations are the single source of truth for schema
      console.log('🔄 Running migrations to initialize schema...');
      try {
        await runProductionMigrations(pgPool);
        pgReady = true;
        console.log("✅ Postgres initialized and ready");
      } catch (error) {
        console.error('❌ Failed to run migrations:');
        console.error(error);
        
        // In production, attempt to continue with existing schema
        // The tables might already exist from a previous deployment
        console.warn('⚠️  WARNING: Migration failed, but attempting to continue...');
        console.warn('⚠️  The database might be using an older schema version');
        console.warn('⚠️  If tables are missing, the app will fail at runtime');
        
        // Try to verify that essential tables exist
        try {
          await pgPool.query('SELECT 1 FROM races LIMIT 1');
          console.log('✅ Essential tables appear to exist, continuing startup...');
          pgReady = true;
        } catch (tableCheckError) {
          console.error('❌ Cannot verify database tables exist');
          console.error('❌ The app will likely fail - database schema is incomplete');
          pgReady = false;
          // Don't throw - let the server start anyway so we can investigate via health check
        }
      }
      
      console.log("📊 Persistence enabled: Receipts, leaderboard, and referrals will survive redeploys");
      return;
    } catch (e) {
      console.error(`❌ Postgres initialization attempt ${attempt}/${maxRetries} failed:`, e);
      pgReady = false;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
    }
  }
}

function fireAndForget(fn: () => Promise<any>): void {
  try {
    fn().catch(() => {});
  } catch {}
}

// Database connection retry logic
function initializeDatabaseWithRetry(maxRetries = 3, retryDelay = 1000): any {
  // CRITICAL: In production, skip SQLite entirely and use only Postgres
  if (usePostgres) {
    console.log("⚠️  Production mode detected - SKIPPING SQLite");
    console.log("    Postgres will be the ONLY backend (no SQLite cache)");
    console.log("    All database operations will use Postgres directly");
    sqlitePath = '(none - production uses Postgres only)';
    return null; // No SQLite in production
  }

  // DEVELOPMENT MODE: Initialize SQLite
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🛠️ Database initialization attempt ${attempt}/${maxRetries}...`);
      
      console.log("🛠️ Initializing development SQLite database...");
      // Detect writable persistent mounts for visibility
      const isDirWritable = (dir: string): boolean => {
        try {
          fs.mkdirSync(dir, { recursive: true });
          const probe = path.join(dir, `.db-write-probe-${Date.now()}`);
          fs.writeFileSync(probe, "ok");
          fs.rmSync(probe);
          return true;
        } catch {
          return false;
        }
      };
      const dataWritable = isDirWritable('/data');
      const mntDataWritable = isDirWritable('/mnt/data');
      console.log(`📦 Persistent mounts: /data=${dataWritable ? 'writable' : 'unavailable'}, /mnt/data=${mntDataWritable ? 'writable' : 'unavailable'}`);
      // Resolve a persistent database file path with sensible fallbacks
      // If DB_PATH is explicitly set via env or env file, validate it; else resolve
      const explicitDbPath = (process.env.DB_PATH || '').trim() || (process.env.DB_PATH_FILE ? (() => { try { return String(fs.readFileSync(process.env.DB_PATH_FILE!)).trim(); } catch { return ''; } })() : '');

      const pickOpenablePath = (candidate: string): string | null => {
        try {
          const dir = path.dirname(candidate);
          try { fs.mkdirSync(dir, { recursive: true }); } catch {}
          const test = new Database(candidate);
          test.close();
          return candidate;
        } catch {
          return null;
        }
      };

      let resolved = '';
      if (explicitDbPath) {
        const ok = pickOpenablePath(explicitDbPath);
        if (ok) {
          resolved = ok;
        } else {
          console.warn(`⚠️ DB_PATH points to an unavailable location: ${explicitDbPath}. Falling back to auto-resolved path.`);
          resolved = resolvePersistentDbPath();
        }
      } else {
        resolved = resolvePersistentDbPath();
      }
      console.log(`📁 Database path: ${resolved}`);
      sqlitePath = resolved;
      // Enforce persistent storage in production on ephemeral hosts
      const isProduction = process.env.NODE_ENV === 'production';
      const isEphemeralHost = Boolean(
        process.env.REPLIT_DEPLOYMENT ||
        process.env.VERCEL ||
        process.env.FLY_APP_NAME ||
        process.env.RENDER ||
        process.env.RAILWAY_STATIC_URL ||
        process.env.GITHUB_ACTIONS
      );
      const isPersistent = resolved.startsWith('/data') || resolved.startsWith('/mnt/data');
      if (isProduction && isEphemeralHost && !isPersistent && !process.env.ALLOW_EPHEMERAL_DB) {
        console.warn(
          `⚠️ Persistent DB recommended on ephemeral host. Set DB_PATH to /data/<app>.db or /mnt/data/<app>.db (resolved=${resolved}). Proceeding with non-persistent path.`
        );
      }
      const sqliteDb = new Database(resolved);
      // Harden SQLite for durability and integrity
      try { sqliteDb.pragma('foreign_keys = ON'); } catch {}
      try { sqliteDb.pragma('journal_mode = WAL'); } catch {}
      try { sqliteDb.pragma('synchronous = NORMAL'); } catch {}
      try { sqliteDb.pragma('busy_timeout = 5000'); } catch {}

      // Best-effort file permission hardening (0600)
      try {
        fs.chmodSync(resolved, 0o600);
      } catch {}
      console.log("✅ SQLite database initialized successfully");
      return sqliteDb;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Database initialization attempt ${attempt} failed:`, errorMessage);
      
      if (attempt === maxRetries) {
        console.error("💥 All database initialization attempts failed. Aborting startup to protect data integrity.");
        throw new Error('Database initialization failed after retries');
      }
      
      // Wait before retry
      if (attempt < maxRetries) {
        console.log(`⏳ Waiting ${retryDelay}ms before retry...`);
        // Use blocking sleep for simplicity in server startup
        const start = Date.now();
        while (Date.now() - start < retryDelay) {
          // Blocking wait
        }
      }
    }
  }
}

/**
 * Resolve a persistent SQLite file path that survives restarts/redeploys.
 * Preference order:
 * 1) Explicit DB_PATH
 * 2) /mnt/data/pump-racers.db (Replit Deployments persistent mount)
 * 3) /data/pump-racers.db (alt persistent mount)
 * 4) /mnt/data/<slug>.db or /data/<slug>.db (slug-specific)
 * 5) ./data/pump-racers.db (project-local)
 * 6) /home/runner/<slug>.db (may not persist across deploys)
 * 7) ./pump-racers.db (cwd)
 */
function resolvePersistentDbPath(): string {
  const explicit = process.env.DB_PATH && process.env.DB_PATH.trim();
  const appSlug = process.env.REPL_SLUG || process.env.APP_NAME || "pump-racers";
  const isReplit = !!(process.env.REPLIT_DEPLOYMENT || process.env.REPL_ID || process.env.REPL_SLUG);

  // Prefer /mnt/data on Replit Deployments; /data can exist but be ephemeral
  const candidates = [
    explicit,
    // Prefer canonical filename first on persistent mounts
    '/mnt/data/pump-racers.db',
    '/data/pump-racers.db',
    // Then slug-specific names on persistent mounts
    `/mnt/data/${appSlug}.db`,
    `/data/${appSlug}.db`,
    // Legacy stable targets (fallbacks)
    '/mnt/data/workspace.db',
    '/data/workspace.db',
    // Project-local fallbacks
    path.join(process.cwd(), 'data', 'pump-racers.db'),
    `/home/runner/${appSlug}.db`,
    path.join(process.cwd(), 'pump-racers.db'),
  ].filter(Boolean) as string[];

  // Attempt to ensure directory exists and open the database. First success wins.
  for (const candidate of candidates) {
    try {
      const dir = path.dirname(candidate);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}

      // Migrate from legacy paths if present and target doesn't exist yet
      try {
        const legacyPaths = [
          // Prior production filenames (copy forward if target missing)
          '/mnt/data/workspace.db',
          '/data/workspace.db',
          '/mnt/data/pump-racers.db',
          '/data/pump-racers.db',
          "/tmp/pump-racers.db",
          path.join(process.cwd(), "data", "pump-racers.db"),
          path.join(process.cwd(), "pump-racers.db"),
          `/home/runner/${appSlug}.db`,
        ];
        for (const legacy of legacyPaths) {
          if (legacy !== candidate && fs.existsSync(legacy) && !fs.existsSync(candidate)) {
            fs.copyFileSync(legacy, candidate);
            console.log(`📦 Migrated legacy DB from ${legacy} → ${candidate}`);
            break;
          }
        }
      } catch {}

      // Quick writability check
      const testLock = path.join(dir, `.db-write-test-${Date.now()}`);
      try { fs.writeFileSync(testLock, "ok"); fs.rmSync(testLock); } catch {}

      // Try opening and closing immediately to validate
      const test = new Database(candidate);
      test.close();

      if (isReplit && !candidate.startsWith('/mnt/data') && !candidate.startsWith('/data')) {
        console.warn(`⚠️ Using non-persistent DB path on Replit: ${candidate}. Set DB_PATH=/data/${appSlug}.db to persist across deploys.`);
      }
      return candidate;
    } catch (e) {
      // Try next candidate
      continue;
    }
  }

  // As a last resort (should not happen), fall back to current working directory
  const fallback = path.join(process.cwd(), "pump-racers.db");
  try {
    const dir = path.dirname(fallback);
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return fallback;
}

// Initialize database with retry logic
db = initializeDatabaseWithRetry();

// In production, db will be null - use Postgres only
if (usePostgres) {
  console.log("✅ Production mode: Postgres-only (no SQLite)");
}

// Set up periodic WAL checkpointing to ensure data persistence (SQLite only)
if (db && !usePostgres && typeof db.pragma === 'function') {
  // Checkpoint the WAL every 30 seconds to ensure data is written to main DB file
  setInterval(() => {
    try {
      const result = db.pragma('wal_checkpoint(PASSIVE)');
      console.log('📝 WAL checkpoint:', result);
    } catch (e) {
      console.error('❌ WAL checkpoint failed:', e);
    }
  }, 30000); // 30 seconds
  
  // Also checkpoint on process exit
  process.on('SIGINT', () => {
    console.log('🛑 Gracefully shutting down, checkpointing database...');
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (e) {
      console.error('❌ Final checkpoint failed:', e);
    }
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('🛑 Gracefully shutting down, checkpointing database...');
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (e) {
      console.error('❌ Final checkpoint failed:', e);
    }
    process.exit(0);
  });
}

// Create tables in SQLite (development mode only - production uses Postgres)
if (db && !usePostgres) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS races (
    id TEXT PRIMARY KEY,
    startTs INTEGER NOT NULL,
    startSlot INTEGER,
    startBlockTimeMs INTEGER,
    lockedTs INTEGER,
    lockedSlot INTEGER,
    lockedBlockTimeMs INTEGER,
    inProgressTs INTEGER,
    inProgressSlot INTEGER,
    inProgressBlockTimeMs INTEGER,
    status TEXT NOT NULL,
    rakeBps INTEGER NOT NULL,
    jackpotFlag INTEGER NOT NULL,
    jackpotAdded INTEGER DEFAULT 0,
    winnerIndex INTEGER,
    drandRound INTEGER,
    drandRandomness TEXT,
    drandSignature TEXT,
    runners TEXT NOT NULL,
    settledSlot INTEGER,
    settledBlockTimeMs INTEGER,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    raceId TEXT NOT NULL,
    wallet TEXT NOT NULL,
    runnerIdx INTEGER NOT NULL,
    amount TEXT NOT NULL,
    sig TEXT NOT NULL,
    ts INTEGER NOT NULL,
    blockTimeMs INTEGER,
    slot INTEGER,
    clientId TEXT,
    memo TEXT,
    currency TEXT NOT NULL DEFAULT 'RACE',
    FOREIGN KEY(raceId) REFERENCES races(id)
  );
  
  -- Ensure one bet per on-chain signature
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_bet_sig ON bets(sig);

  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    raceId TEXT NOT NULL,
    wallet TEXT NOT NULL,
    amount TEXT NOT NULL,
    sig TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY(raceId) REFERENCES races(id)
  );

  CREATE TABLE IF NOT EXISTS treasury (
    state TEXT PRIMARY KEY DEFAULT 'main',
    jackpotBalance TEXT DEFAULT '0',
    jackpotBalanceSol TEXT DEFAULT '0',
    raceMint TEXT,
    maintenanceMode INTEGER DEFAULT 0,
    maintenanceMessage TEXT,
    maintenanceAnchorRaceId TEXT
  );

  ${usePostgres ? '-- Production: In-memory SQLite cache initialized' : ''}
  INSERT OR IGNORE INTO treasury (state) VALUES ('main');

  CREATE TABLE IF NOT EXISTS seen_tx (
    sig TEXT PRIMARY KEY,
    seenAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settlement_transfers (
    id TEXT PRIMARY KEY,
    raceId TEXT NOT NULL,
    transferType TEXT NOT NULL,
    toWallet TEXT NOT NULL,
    amount TEXT NOT NULL,
    txSig TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RACE',
    ts INTEGER NOT NULL,
    FOREIGN KEY(raceId) REFERENCES races(id)
  );

  -- Record of failed settlement attempts for observability
  CREATE TABLE IF NOT EXISTS settlement_errors (
    id TEXT PRIMARY KEY,
    raceId TEXT NOT NULL,
    toWallet TEXT,
    amount TEXT,
    currency TEXT NOT NULL DEFAULT 'RACE',
    error TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY(raceId) REFERENCES races(id)
  );
  
  -- Per-user, per-race results for auditability and leaderboard
  CREATE TABLE IF NOT EXISTS user_race_results (
    wallet TEXT NOT NULL,
    raceId TEXT NOT NULL,
    betAmount TEXT NOT NULL,
    payoutAmount TEXT NOT NULL,
    win INTEGER NOT NULL,
    edgePoints TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (wallet, raceId),
    FOREIGN KEY(raceId) REFERENCES races(id)
  );

  CREATE INDEX IF NOT EXISTS idx_user_race_results_wallet ON user_race_results(wallet);
  CREATE INDEX IF NOT EXISTS idx_user_race_results_race ON user_race_results(raceId);

  -- Aggregated user stats for fast leaderboard queries
  CREATE TABLE IF NOT EXISTS user_stats (
    wallet TEXT PRIMARY KEY,
    totalRaces INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    totalWagered TEXT NOT NULL DEFAULT '0',
    totalAwarded TEXT NOT NULL DEFAULT '0',
    edgePoints TEXT NOT NULL DEFAULT '0',
    lastUpdated INTEGER NOT NULL
  );

  -- Recent winners table to persist last 6 winning races
  CREATE TABLE IF NOT EXISTS recent_winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raceId TEXT NOT NULL,
    raceData TEXT NOT NULL,
    settledAt INTEGER NOT NULL,
    UNIQUE(raceId)
  );

  CREATE INDEX IF NOT EXISTS idx_recent_winners_settled ON recent_winners(settledAt DESC);

  -- Referrals core tables
  CREATE TABLE IF NOT EXISTS referral_users (
    wallet TEXT PRIMARY KEY,
    code TEXT UNIQUE,
    verified INTEGER NOT NULL DEFAULT 0,
    verifiedAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS referral_attributions (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    code TEXT NOT NULL,
    source TEXT,
    firstSeenTs INTEGER NOT NULL,
    lastSeenTs INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS referral_rewards (
    id TEXT PRIMARY KEY,
    raceId TEXT NOT NULL,
    fromWallet TEXT NOT NULL,
    toWallet TEXT NOT NULL,
    level INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RACE',
    amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|PAID|CANCELLED
    txSig TEXT,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS referral_settings (
    id TEXT PRIMARY KEY DEFAULT 'main',
    enabled INTEGER NOT NULL DEFAULT 1,
    discountBps INTEGER NOT NULL DEFAULT 500, -- 5% referral discount for referred user
    level1Bps INTEGER NOT NULL DEFAULT 3000,  -- 60% of rake (of referral pool) = 3000 of poolBps 5000
    level2Bps INTEGER NOT NULL DEFAULT 600,
    level3Bps INTEGER NOT NULL DEFAULT 200,
    poolBps INTEGER NOT NULL DEFAULT 5000,   -- 50% of protocol rake allocated to referrals by default
    minPayout TEXT NOT NULL DEFAULT '0.01',  -- minimum amount threshold to pay
    payoutCron TEXT NOT NULL DEFAULT 'daily'
  );
  INSERT OR IGNORE INTO referral_settings(id) VALUES ('main');

  CREATE TABLE IF NOT EXISTS referral_aggregates (
    wallet TEXT PRIMARY KEY,
    directCount INTEGER NOT NULL DEFAULT 0,
    indirectCount INTEGER NOT NULL DEFAULT 0,
    totalRewards TEXT NOT NULL DEFAULT '0',
    totalPaid TEXT NOT NULL DEFAULT '0',
    lastUpdated INTEGER NOT NULL
  );
  `);
  console.log("✅ SQLite development database tables created");
} else if (usePostgres) {
  console.log("⏭️  Skipping SQLite table creation - production uses Postgres only");
} else {
  console.error("❌ CRITICAL: No database configured - application cannot function");
}

// Migration: Add missing columns to existing races table (SQLite only)
if (db && !usePostgres) {
  try {
  const alters = [
    "ALTER TABLE races ADD COLUMN startSlot INTEGER",
    "ALTER TABLE races ADD COLUMN startBlockTimeMs INTEGER",
    "ALTER TABLE races ADD COLUMN lockedTs INTEGER",
    "ALTER TABLE races ADD COLUMN lockedSlot INTEGER",
    "ALTER TABLE races ADD COLUMN lockedBlockTimeMs INTEGER",
    "ALTER TABLE races ADD COLUMN inProgressTs INTEGER",
    "ALTER TABLE races ADD COLUMN inProgressSlot INTEGER",
    "ALTER TABLE races ADD COLUMN inProgressBlockTimeMs INTEGER",
    "ALTER TABLE races ADD COLUMN settledSlot INTEGER",
    "ALTER TABLE races ADD COLUMN settledBlockTimeMs INTEGER",
    "ALTER TABLE bets ADD COLUMN blockTimeMs INTEGER",
    "ALTER TABLE bets ADD COLUMN slot INTEGER",
    "ALTER TABLE bets ADD COLUMN clientId TEXT",
    "ALTER TABLE bets ADD COLUMN memo TEXT",
    // Multi-currency support
    "ALTER TABLE bets ADD COLUMN currency TEXT DEFAULT 'RACE'",
    "ALTER TABLE settlement_transfers ADD COLUMN currency TEXT DEFAULT 'RACE'",
    "ALTER TABLE treasury ADD COLUMN jackpotBalanceSol TEXT DEFAULT '0'",
    // Maintenance columns on treasury
    "ALTER TABLE treasury ADD COLUMN maintenanceMode INTEGER DEFAULT 0",
    "ALTER TABLE treasury ADD COLUMN maintenanceMessage TEXT",
    "ALTER TABLE treasury ADD COLUMN maintenanceAnchorRaceId TEXT",
    // Referral verification columns
    "ALTER TABLE referral_users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE referral_users ADD COLUMN verifiedAt INTEGER"
  ];
  for (const sql of alters) {
    try { db.exec(sql); } catch (e: any) {
      if (!String(e?.message || '').includes('duplicate column name')) {
        console.log("⚠️ Migration step failed:", sql, e?.message || e);
      }
    }
  }
  console.log("✅ Database migration completed: Added on-chain time columns where missing");
  
  // Grandfather existing referrals: mark all existing referral_users as verified
  try {
    const now = Date.now();
    db.exec(`UPDATE referral_users SET verified = 1, verifiedAt = ${now} WHERE verified = 0`);
    console.log("✅ Grandfathered existing referrals as verified");
  } catch (e: any) {
    console.log("⚠️ Failed to grandfather existing referrals:", e.message);
  }
  } catch (error: any) {
    console.log("⚠️ Database migration batch error (might be OK):", error.message);
  }
}

export class SQLiteStorage {
  private raceInsert = db.prepare(`
    INSERT INTO races (
      id, startTs, startSlot, startBlockTimeMs, lockedTs, lockedSlot, lockedBlockTimeMs,
      inProgressTs, inProgressSlot, inProgressBlockTimeMs, status, rakeBps, jackpotFlag,
      jackpotAdded, winnerIndex, drandRound, drandRandomness, drandSignature, runners,
      settledSlot, settledBlockTimeMs, createdAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  private raceSelect = db.prepare("SELECT * FROM races WHERE id = ?");
  private racesSelect = db.prepare("SELECT * FROM races WHERE status = ? ORDER BY createdAt DESC");
  private racesSelectAll = db.prepare("SELECT * FROM races ORDER BY createdAt DESC");
  private raceUpdate = db.prepare(`
    UPDATE races SET 
      startTs = ?, startSlot = ?, startBlockTimeMs = ?,
      lockedTs = ?, lockedSlot = ?, lockedBlockTimeMs = ?,
      inProgressTs = ?, inProgressSlot = ?, inProgressBlockTimeMs = ?,
      status = ?, rakeBps = ?, jackpotFlag = ?, jackpotAdded = ?, 
      winnerIndex = ?, drandRound = ?, drandRandomness = ?, drandSignature = ?,
      runners = ?, settledSlot = ?, settledBlockTimeMs = ?
    WHERE id = ?
  `);

  private betInsert = db.prepare(`
    INSERT INTO bets (id, raceId, wallet, runnerIdx, amount, sig, ts, blockTimeMs, slot, clientId, memo, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Upsert variant for safe hydration from Postgres without duplicate errors
  private betInsertIgnore = db.prepare(`
    INSERT OR IGNORE INTO bets (id, raceId, wallet, runnerIdx, amount, sig, ts, blockTimeMs, slot, clientId, memo, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Public helper to hydrate bets from external durable store without throwing on duplicates
  hydrateBet(row: { id: string; raceId: string; wallet: string; runnerIdx: number; amount: string; sig: string; ts: number; blockTimeMs?: number | null; slot?: number | null; clientId?: string | null; memo?: string | null; currency?: string }): void {
    this.betInsertIgnore.run(
      row.id,
      row.raceId,
      row.wallet,
      row.runnerIdx,
      row.amount,
      row.sig,
      row.ts,
      row.blockTimeMs ?? null,
      row.slot ?? null,
      row.clientId ?? null,
      row.memo ?? null,
      String(row.currency || 'RACE')
    );
  }

  private betsSelectByRace = db.prepare("SELECT * FROM bets WHERE raceId = ? ORDER BY ts ASC");
  private betsSelectByWallet = db.prepare("SELECT * FROM bets WHERE wallet = ? ORDER BY ts DESC");
  private betsSelectByWalletAndRace = db.prepare("SELECT * FROM bets WHERE wallet = ? AND raceId = ?");

  private claimInsert = db.prepare(`
    INSERT INTO claims (id, raceId, wallet, amount, sig, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  private claimsSelectByRace = db.prepare("SELECT * FROM claims WHERE raceId = ?");
  private claimsSelectByWallet = db.prepare("SELECT * FROM claims WHERE wallet = ? ORDER BY ts DESC");

  private treasurySelect = db.prepare("SELECT * FROM treasury WHERE state = 'main'");
  private treasuryUpdate = db.prepare("UPDATE treasury SET jackpotBalance = ?, jackpotBalanceSol = ?, raceMint = ?, maintenanceMode = ?, maintenanceMessage = ?, maintenanceAnchorRaceId = ? WHERE state = 'main'");
  // Narrow update for atomic jackpot balance adjustments without touching other fields
  private treasuryUpdateBalances = db.prepare("UPDATE treasury SET jackpotBalance = ?, jackpotBalanceSol = ? WHERE state = 'main'");
  private raceDeleteAll = db.prepare("DELETE FROM races");
  private betDeleteAll = db.prepare("DELETE FROM bets");

  // Transaction deduplication queries
  private seenTxInsert = db.prepare("INSERT INTO seen_tx (sig, seenAt) VALUES (?, ?)");
  private seenTxSelect = db.prepare("SELECT * FROM seen_tx WHERE sig = ?");
  private seenTxCleanup = db.prepare("DELETE FROM seen_tx WHERE seenAt < ?");
  private seenTxDelete = db.prepare("DELETE FROM seen_tx WHERE sig = ?");
  private seenTxUpsert = db.prepare(
    "INSERT INTO seen_tx (sig, seenAt) VALUES (?, ?) ON CONFLICT(sig) DO UPDATE SET seenAt = excluded.seenAt"
  );

  // Settlement transfer queries
  private settlementTransferInsert = db.prepare(`
    INSERT INTO settlement_transfers (id, raceId, transferType, toWallet, amount, txSig, currency, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Upsert variant to safely hydrate from Postgres without duplicate errors
  private settlementTransferUpsert = db.prepare(`
    INSERT INTO settlement_transfers (id, raceId, transferType, toWallet, amount, txSig, currency, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      transferType=excluded.transferType,
      toWallet=excluded.toWallet,
      amount=excluded.amount,
      txSig=excluded.txSig,
      currency=excluded.currency,
      ts=excluded.ts
  `);
  private settlementTransfersSelect = db.prepare("SELECT * FROM settlement_transfers WHERE raceId = ?");
  // Additional settlement transfer queries for receipts and reconciliation
  private settlementTransfersByWallet = db.prepare("SELECT * FROM settlement_transfers WHERE toWallet = ? ORDER BY ts DESC LIMIT ?");
  private settlementTransferByRaceAndWallet = db.prepare("SELECT * FROM settlement_transfers WHERE raceId = ? AND toWallet = ? ORDER BY ts DESC LIMIT 1");

  // Settlement error statements
  private settlementErrorInsert = db.prepare(`
    INSERT INTO settlement_errors (id, raceId, toWallet, amount, currency, error, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  private settlementErrorUpsert = db.prepare(`
    INSERT INTO settlement_errors (id, raceId, toWallet, amount, currency, error, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      toWallet=excluded.toWallet,
      amount=excluded.amount,
      currency=excluded.currency,
      error=excluded.error,
      ts=excluded.ts
  `);
  private settlementErrorsByRace = db.prepare("SELECT * FROM settlement_errors WHERE raceId = ? ORDER BY ts DESC LIMIT ?");
  private settlementErrorsRecent = db.prepare("SELECT * FROM settlement_errors ORDER BY ts DESC LIMIT ?");

  // Referral statements
  private refUserUpsert = db.prepare(`
    INSERT INTO referral_users (wallet, code, createdAt, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET code=excluded.code, updatedAt=excluded.updatedAt
  `);
  private refUserByWallet = db.prepare("SELECT wallet, code, createdAt, updatedAt FROM referral_users WHERE wallet = ?");
  private refUserByCode = db.prepare("SELECT wallet, code, createdAt, updatedAt FROM referral_users WHERE code = ?");
  private refAttrUpsert = db.prepare(`
    INSERT INTO referral_attributions (id, wallet, code, source, firstSeenTs, lastSeenTs)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code, source=excluded.source, lastSeenTs=excluded.lastSeenTs
  `);
  private refAttrByWallet = db.prepare("SELECT * FROM referral_attributions WHERE wallet = ? ORDER BY lastSeenTs DESC LIMIT 1");
  private refAttrsByCodeAll = db.prepare("SELECT wallet FROM referral_attributions WHERE code = ?");
  private refSettingsGet = db.prepare("SELECT * FROM referral_settings WHERE id='main'");
  private refSettingsUpdate = db.prepare("UPDATE referral_settings SET enabled=?, discountBps=?, level1Bps=?, level2Bps=?, level3Bps=?, poolBps=?, minPayout=?, payoutCron=? WHERE id='main'");
  private refRewardInsert = db.prepare(`
    INSERT INTO referral_rewards (id, raceId, fromWallet, toWallet, level, currency, amount, status, txSig, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  private refRewardUpdatePaid = db.prepare("UPDATE referral_rewards SET status='PAID', txSig=?, ts=? WHERE id=?");
  private refRewardsUnpaid = db.prepare("SELECT * FROM referral_rewards WHERE status='PENDING' AND amount != '0' ORDER BY ts ASC LIMIT ?");
  // Sums of referral rewards by race, grouped by currency and status
  private refRewardsSumsByRace = db.prepare(`
    SELECT currency, status, CAST(SUM(CAST(amount AS REAL)) AS TEXT) AS total
    FROM referral_rewards
    WHERE raceId = ?
    GROUP BY currency, status
  `);
  private refAggUpsert = db.prepare(`
    INSERT INTO referral_aggregates (wallet, directCount, indirectCount, totalRewards, totalPaid, lastUpdated)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET directCount=excluded.directCount, indirectCount=excluded.indirectCount, totalRewards=excluded.totalRewards, totalPaid=excluded.totalPaid, lastUpdated=excluded.lastUpdated
  `);
  private refAggGet = db.prepare("SELECT * FROM referral_aggregates WHERE wallet = ?");
  private refRewardsTotalsByWallet = db.prepare(`
    SELECT 
      CAST(SUM(CASE WHEN status='PENDING' THEN CAST(amount AS REAL) ELSE 0 END) AS TEXT) AS pending,
      CAST(SUM(CASE WHEN status='PAID' THEN CAST(amount AS REAL) ELSE 0 END) AS TEXT) AS paid
    FROM referral_rewards
    WHERE toWallet = ? AND currency = ?
  `);

  getDirectReferrals(code: string): string[] {
    try {
      const rows = this.refAttrsByCodeAll.all(code) as Array<{ wallet: string }>;
      return rows.map(r => r.wallet);
    } catch { return []; }
  }

  getCodesForWallets(wallets: string[]): string[] {
    const out: string[] = [];
    for (const w of wallets) {
      try {
        const row = this.refUserByWallet.get(w) as any;
        if (row?.code) out.push(String(row.code));
      } catch {}
    }
    return out;
  }

  getReferralTotalsForWallet(wallet: string, currency: 'SOL' | 'RACE'): { pending: string; paid: string } {
    try {
      const r = this.refRewardsTotalsByWallet.get(wallet, currency) as any;
      return { pending: String(r?.pending || '0'), paid: String(r?.paid || '0') };
    } catch { return { pending: '0', paid: '0' }; }
  }

  // Postgres mirrors for referrals (best-effort durability when pgReady)
  private async pgInsertBet(row: { id: string; raceId: string; wallet: string; runnerIdx: number; amount: string; sig: string; ts: number; blockTimeMs?: number | null; slot?: number | null; clientId?: string | null; memo?: string | null; currency?: string }) {
    if (!pgReady || !pgPool) {
      console.warn('⚠️ Postgres not ready - bet not persisted to durable storage:', row.id);
      return;
    }
    try {
    await pgPool.query(
      `INSERT INTO bets (id, race_id, wallet, runner_idx, amount, sig, ts, block_time_ms, slot, client_id, memo, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         race_id = EXCLUDED.race_id,
         wallet = EXCLUDED.wallet,
         runner_idx = EXCLUDED.runner_idx,
         amount = EXCLUDED.amount,
         sig = EXCLUDED.sig,
         ts = EXCLUDED.ts,
         block_time_ms = EXCLUDED.block_time_ms,
         slot = EXCLUDED.slot,
         client_id = EXCLUDED.client_id,
         memo = EXCLUDED.memo,
         currency = EXCLUDED.currency
      `,
      [
        row.id,
        row.raceId,
        row.wallet,
        row.runnerIdx,
        row.amount,
        row.sig,
        row.ts,
        row.blockTimeMs ?? null,
        row.slot ?? null,
        row.clientId ?? null,
        row.memo ?? null,
        (row.currency || 'RACE')
      ]
    );
    } catch (e) {
      console.error('❌ Failed to persist bet to Postgres:', row.id, e);
    }
  }
  private async pgInsertSettlementTransfer(row: { id: string; raceId: string; transferType: string; toWallet: string; amount: string; txSig: string; currency?: string; ts: number }) {
    if (!pgReady || !pgPool) {
      console.warn('⚠️ Postgres not ready - settlement transfer not persisted:', row.id);
      return;
    }
    try {
    await pgPool.query(
      `INSERT INTO settlement_transfers (id, race_id, transfer_type, to_wallet, amount, tx_sig, currency, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.raceId, row.transferType, row.toWallet, row.amount, row.txSig, (row.currency || 'RACE'), row.ts]
    );
    } catch (e) {
      console.error('❌ Failed to persist settlement transfer to Postgres:', row.id, e);
    }
  }
  private async pgInsertSettlementError(row: { id: string; raceId: string; toWallet?: string; amount?: string; currency?: string; error: string; ts?: number }) {
    if (!pgReady || !pgPool) {
      console.warn('⚠️ Postgres not ready - settlement error not persisted:', row.id);
      return;
    }
    try {
    await pgPool.query(
      `INSERT INTO settlement_errors (id, race_id, to_wallet, amount, currency, error, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.raceId, row.toWallet || null, row.amount || null, (row.currency || 'RACE'), row.error, row.ts || Date.now()]
    );
    } catch (e) {
      console.error('❌ Failed to persist settlement error to Postgres:', row.id, e);
    }
  }
  private async pgUpsertReferralUser(row: { wallet: string; code: string; createdAt: number; updatedAt: number }) {
    if (!pgReady || !pgPool) {
      console.warn('⚠️ Postgres not ready - referral user not persisted:', row.wallet);
      return;
    }
    try {
    await pgPool.query(
      `INSERT INTO referral_users (wallet, code, created_at, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT(wallet) DO UPDATE SET code=EXCLUDED.code, updated_at=EXCLUDED.updated_at`,
      [row.wallet, row.code, row.createdAt, row.updatedAt]
    );
    } catch (e) {
      console.error('❌ Failed to persist referral user to Postgres:', row.wallet, e);
    }
  }
  private async pgUpsertAttribution(row: { id: string; wallet: string; code: string; source?: string; firstSeenTs: number; lastSeenTs: number }) {
    if (!pgReady || !pgPool) {
      console.warn('⚠️ Postgres not ready - referral attribution not persisted:', row.wallet);
      return;
    }
    try {
    await pgPool.query(
      `INSERT INTO referral_attributions (id, wallet, code, source, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code, source=EXCLUDED.source, last_seen=EXCLUDED.last_seen`,
      [row.id, row.wallet, row.code, row.source || null, row.firstSeenTs, row.lastSeenTs]
    );
    } catch (e) {
      console.error('❌ Failed to persist referral attribution to Postgres:', row.wallet, e);
    }
  }
  private async pgInsertReward(row: { id: string; raceId: string; fromWallet: string; toWallet: string; level: number; currency: string; amount: string; ts: number }) {
    if (!pgReady || !pgPool) {
      console.warn('⚠️ Postgres not ready - referral reward not persisted:', row.id);
      return;
    }
    try {
    await pgPool.query(
      `INSERT INTO referral_rewards (id, race_id, from_wallet, to_wallet, level, currency, amount, status, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)
       ON CONFLICT(id) DO NOTHING`,
      [row.id, row.raceId, row.fromWallet, row.toWallet, row.level, row.currency, row.amount, row.ts]
    );
    } catch (e) {
      console.error('❌ Failed to persist referral reward to Postgres:', row.id, e);
    }
  }
  private async pgMarkRewardPaid(id: string, txSig: string) {
    if (!pgReady || !pgPool) {
      console.warn('⚠️ Postgres not ready - referral reward payment status not persisted:', id);
      return;
    }
    try {
    await pgPool.query(`UPDATE referral_rewards SET status='PAID', tx_sig=$1 WHERE id=$2`, [txSig, id]);
    } catch (e) {
      console.error('❌ Failed to update referral reward status in Postgres:', id, e);
    }
  }

  // Leaderboard and user stats queries
  private userRaceResultUpsert = db.prepare(`
    INSERT INTO user_race_results (wallet, raceId, betAmount, payoutAmount, win, edgePoints, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet, raceId) DO UPDATE SET
      betAmount = excluded.betAmount,
      payoutAmount = excluded.payoutAmount,
      win = excluded.win,
      edgePoints = excluded.edgePoints,
      ts = excluded.ts
  `);
  private userRaceResultsByWallet = db.prepare("SELECT betAmount, payoutAmount, win, edgePoints FROM user_race_results WHERE wallet = ?");
  private userRaceResultsRecentByWallet = db.prepare("SELECT raceId, betAmount, payoutAmount, win, edgePoints, ts FROM user_race_results WHERE wallet = ? ORDER BY ts DESC LIMIT ?");
  private racePotFromResults = db.prepare(`
    SELECT 
      CAST(SUM(CAST(betAmount AS REAL)) AS TEXT) AS totalPot,
      COUNT(1) AS betCount
    FROM user_race_results
    WHERE raceId = ?
  `);
  private userStatsUpsert = db.prepare(`
    INSERT INTO user_stats (wallet, totalRaces, wins, losses, totalWagered, totalAwarded, edgePoints, lastUpdated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET
      totalRaces = excluded.totalRaces,
      wins = excluded.wins,
      losses = excluded.losses,
      totalWagered = excluded.totalWagered,
      totalAwarded = excluded.totalAwarded,
      edgePoints = excluded.edgePoints,
      lastUpdated = excluded.lastUpdated
  `);
  private leaderboardSelect = db.prepare("SELECT wallet, totalRaces, wins, losses, totalWagered, totalAwarded, edgePoints, lastUpdated FROM user_stats ORDER BY CAST(edgePoints AS REAL) DESC, wins DESC LIMIT ?");
  private userStatsSelect = db.prepare("SELECT wallet, totalRaces, wins, losses, totalWagered, totalAwarded, edgePoints, lastUpdated FROM user_stats WHERE wallet = ?");
  private userRankSelect = db.prepare(`
    WITH target AS (
      SELECT CAST(edgePoints AS REAL) AS ep FROM user_stats WHERE wallet = ?
    )
    SELECT CASE WHEN (SELECT ep FROM target) IS NULL THEN NULL ELSE 1 + (
      SELECT COUNT(1) FROM user_stats WHERE CAST(edgePoints AS REAL) > (SELECT ep FROM target)
    ) END AS rank
  `);
  private userStatsCount = db.prepare("SELECT COUNT(1) AS count FROM user_stats");
  private userStatsSummaryStmt = db.prepare(`
    SELECT COUNT(1) AS walletCount, COALESCE(MAX(lastUpdated), 0) AS lastUpdated
    FROM user_stats
  `);

  // Reconciliation aggregates
  private sumAllBets = db.prepare("SELECT CAST(SUM(CAST(amount AS REAL)) AS TEXT) AS total FROM bets");
  private sumAllPayouts = db.prepare("SELECT CAST(SUM(CAST(amount AS REAL)) AS TEXT) AS total FROM settlement_transfers WHERE transferType = 'PAYOUT'");
  private sumAllRake = db.prepare("SELECT CAST(SUM(CAST(amount AS REAL)) AS TEXT) AS total FROM settlement_transfers WHERE transferType = 'RAKE'");
  private distinctResultWalletsSelect = db.prepare("SELECT DISTINCT wallet FROM user_race_results");
  private userRaceResultsSummaryStmt = db.prepare(`
    SELECT COUNT(DISTINCT wallet) AS walletCount, COALESCE(MAX(ts), 0) AS lastUpdated
    FROM user_race_results
  `);

  // Aggregation directly from all-time user_race_results (fallback when user_stats is empty)
  private aggLeaderboardFromResults = db.prepare(`
    SELECT 
      wallet,
      COUNT(1) AS totalRaces,
      SUM(win) AS wins,
      (COUNT(1) - SUM(win)) AS losses,
      CAST(SUM(CAST(betAmount AS REAL)) AS TEXT) AS totalWagered,
      CAST(SUM(CAST(payoutAmount AS REAL)) AS TEXT) AS totalAwarded,
      CAST(SUM(CAST(edgePoints AS REAL)) AS TEXT) AS edgePoints,
      MAX(ts) AS lastUpdated
    FROM user_race_results
    GROUP BY wallet
    ORDER BY CAST(edgePoints AS REAL) DESC, wins DESC
    LIMIT ?
  `);
  private aggAllFromResults = db.prepare(`
    SELECT 
      wallet,
      COUNT(1) AS totalRaces,
      SUM(win) AS wins,
      (COUNT(1) - SUM(win)) AS losses,
      CAST(SUM(CAST(betAmount AS REAL)) AS TEXT) AS totalWagered,
      CAST(SUM(CAST(payoutAmount AS REAL)) AS TEXT) AS totalAwarded,
      CAST(SUM(CAST(edgePoints AS REAL)) AS TEXT) AS edgePoints,
      MAX(ts) AS lastUpdated
    FROM user_race_results
    GROUP BY wallet
    ORDER BY CAST(edgePoints AS REAL) DESC, wins DESC
  `);
  private aggUserFromResults = db.prepare(`
    SELECT 
      wallet,
      COUNT(1) AS totalRaces,
      SUM(win) AS wins,
      (COUNT(1) - SUM(win)) AS losses,
      CAST(SUM(CAST(betAmount AS REAL)) AS TEXT) AS totalWagered,
      CAST(SUM(CAST(payoutAmount AS REAL)) AS TEXT) AS totalAwarded,
      CAST(SUM(CAST(edgePoints AS REAL)) AS TEXT) AS edgePoints,
      MAX(ts) AS lastUpdated
    FROM user_race_results
    WHERE wallet = ?
    GROUP BY wallet
  `);
  private aggRankFromResults = db.prepare(`
    WITH aggregated AS (
      SELECT wallet, SUM(CAST(edgePoints AS REAL)) AS ep FROM user_race_results GROUP BY wallet
    )
    SELECT CASE WHEN (SELECT ep FROM aggregated WHERE wallet = ?) IS NULL THEN NULL ELSE 1 + (
      SELECT COUNT(1) FROM aggregated WHERE ep > (SELECT ep FROM aggregated WHERE wallet = ?)
    ) END AS rank
  `);

  // Recent winners queries
  private recentWinnersInsert = db.prepare(`
    INSERT INTO recent_winners (raceId, raceData, settledAt)
    VALUES (?, ?, ?)
    ON CONFLICT(raceId) DO UPDATE SET
      raceData = excluded.raceData,
      settledAt = excluded.settledAt
  `);
  private recentWinnersSelect = db.prepare(`
    SELECT raceData FROM recent_winners 
    ORDER BY settledAt DESC 
    LIMIT ?
  `);
  private recentWinnersCleanup = db.prepare(`
    DELETE FROM recent_winners 
    WHERE id NOT IN (
      SELECT id FROM recent_winners 
      ORDER BY settledAt DESC 
      LIMIT ?
    )
  `);

  // Expose controlled helpers for hydration without breaking encapsulation
  upsertRecentWinnerRaw(raceId: string, raceData: string, settledAt: number): void {
    this.recentWinnersInsert.run(raceId, raceData, settledAt);
  }

  cleanupRecentWinners(limit: number = 6): void {
    this.recentWinnersCleanup.run(limit);
  }

  createRace(race: Race): Race {
    this.raceInsert.run(
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
    );
    return race;
  }

  getRace(id: string): Race | undefined {
    const row = this.raceSelect.get(id) as any;
    if (!row) return undefined;
    
    return {
      ...row,
      jackpotFlag: Boolean(row.jackpotFlag),
      runners: JSON.parse(row.runners)
    };
  }

  getRaces(status?: string): Race[] {
    const rows = status 
      ? this.racesSelect.all(status) 
      : this.racesSelectAll.all();
    
    return (rows as any[])
      .map(row => ({
        ...row,
        jackpotFlag: Boolean(row.jackpotFlag),
        runners: JSON.parse(row.runners)
      }))
      .sort((a, b) => a.startTs - b.startTs); // Sort by start time (earliest first)
  }

  updateRace(race: Race): void {
    this.raceUpdate.run(
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
      race.id
    );
  }

  createBet(bet: any): void {
    console.log('🔍 Database createBet called with:', bet);
    console.log('🔍 runnerIdx value:', bet.runnerIdx, 'type:', typeof bet.runnerIdx);
    
    const runnerIdx = bet.runnerIdx !== undefined ? bet.runnerIdx : bet.tokenIdx;
    const raceId = bet.raceId || bet.marketId;
    
    if (runnerIdx === undefined || runnerIdx === null) {
      throw new Error(`runnerIdx is required but got: ${runnerIdx}`);
    }
    
    try {
      this.betInsert.run(
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
        (bet.currency || 'RACE')
      );
      // Mirror to Postgres (best-effort)
      fireAndForget(async () => {
        await this.pgInsertBet({
          id: String(bet.id),
          raceId: String(raceId),
          wallet: String(bet.wallet),
          runnerIdx: Number(runnerIdx),
          amount: String(bet.amount),
          sig: String(bet.sig),
          ts: Number(bet.ts || Date.now()),
          blockTimeMs: bet.blockTimeMs !== undefined && bet.blockTimeMs !== null ? Number(bet.blockTimeMs) : null,
          slot: bet.slot !== undefined && bet.slot !== null ? Number(bet.slot) : null,
          clientId: bet.clientId ?? null,
          memo: bet.memo ?? null,
          currency: String(bet.currency || 'RACE')
        });
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('UNIQUE') && msg.includes('bets.sig')) {
        console.log(`ℹ️  Duplicate bet ignored for sig=${bet.sig}`);
        return;
      }
      throw e;
    }
  }

  getBetsForRace(raceId: string): Prediction[] {
    return this.betsSelectByRace.all(raceId) as Prediction[];
  }

    async getRaceBetAggregates(raceIds: string[]): Promise<RaceBetAggregateMap> {
      if (!Array.isArray(raceIds) || raceIds.length === 0) {
        return {};
      }
      const uniqueIds = Array.from(new Set(raceIds.map(id => String(id))));
      if (uniqueIds.length === 0) {
        return {};
      }
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const sql = `
        SELECT 
          raceId AS race_id,
          UPPER(COALESCE(currency, 'RACE')) AS currency,
          COUNT(1) AS betCount,
          CAST(SUM(CAST(amount AS REAL)) AS TEXT) AS totalAmount
        FROM bets
        WHERE raceId IN (${placeholders})
        GROUP BY raceId, currency
      `;
      const rows = db.prepare(sql).all(...uniqueIds) as Array<{ race_id: string; currency: string; betCount: number; totalAmount: string }>;
      const aggregates: RaceBetAggregateMap = {};
      for (const row of rows) {
        const key = String(row.race_id);
        if (!aggregates[key]) {
          aggregates[key] = { totalPotSol: '0', betCountSol: 0, totalPotRace: '0', betCountRace: 0 };
        }
        const normalizedCurrency = String(row.currency || 'RACE').toUpperCase() === 'SOL' ? 'SOL' : 'RACE';
        const amountStr = row.totalAmount ?? '0';
        if (normalizedCurrency === 'SOL') {
          aggregates[key].totalPotSol = new Decimal(amountStr || '0').toString();
          aggregates[key].betCountSol = Number(row.betCount) || 0;
        } else {
          aggregates[key].totalPotRace = new Decimal(amountStr || '0').toString();
          aggregates[key].betCountRace = Number(row.betCount) || 0;
        }
      }
      return aggregates;
    }

  getBetsForWallet(wallet: string, raceId?: string): Prediction[] {
    if (raceId) {
      return this.betsSelectByWalletAndRace.all(wallet, raceId) as Prediction[];
    }
    return this.betsSelectByWallet.all(wallet) as Prediction[];
  }

  createClaim(claim: Claim): void {
    this.claimInsert.run(
      claim.id,
      (claim as any).marketId,
      claim.wallet,
      claim.amount,
      claim.sig,
      claim.ts
    );
  }

  getClaimsForRace(raceId: string): Claim[] {
    return this.claimsSelectByRace.all(raceId) as Claim[];
  }

  getClaimsForWallet(wallet: string): Claim[] {
    return this.claimsSelectByWallet.all(wallet) as Claim[];
  }

  getTreasury(): Treasury {
    const row = this.treasurySelect.get() as any;
    // Clamp to zero to avoid negative displays if a race condition ever attempted an underflow
    const safeJackpotRace = new Decimal(row?.jackpotBalance || '0');
    const safeJackpotSol = new Decimal(row?.jackpotBalanceSol || '0');
    // If either balance is negative in storage, heal it to 0 persistently
    if (safeJackpotRace.isNegative() || safeJackpotSol.isNegative()) {
      const healedRace = safeJackpotRace.isNegative() ? new Decimal(0) : safeJackpotRace;
      const healedSol = safeJackpotSol.isNegative() ? new Decimal(0) : safeJackpotSol;
      try {
        this.treasuryUpdateBalances.run(healedRace.toString(), healedSol.toString());
      } catch {}
    }
    return {
      jackpotBalance: (safeJackpotRace.isNegative() ? new Decimal(0) : safeJackpotRace).toString(),
      jackpotBalanceSol: (safeJackpotSol.isNegative() ? new Decimal(0) : safeJackpotSol).toString(),
      raceMint: row?.raceMint || undefined,
      maintenanceMode: Boolean(row?.maintenanceMode),
      maintenanceMessage: row?.maintenanceMessage || undefined,
      maintenanceAnchorRaceId: row?.maintenanceAnchorRaceId || undefined
    } as any;
  }

  updateTreasury(updates: Partial<Treasury>): void {
    const current = this.getTreasury();
    const merged = { ...current, ...updates } as any;
    this.treasuryUpdate.run(
      merged.jackpotBalance ?? current.jackpotBalance,
      merged.jackpotBalanceSol ?? current.jackpotBalanceSol,
      merged.raceMint ?? null,
      merged.maintenanceMode ? 1 : 0,
      merged.maintenanceMessage ?? null,
      merged.maintenanceAnchorRaceId ?? null
    );
  }

  /**
   * Atomically adjust jackpot balances by deltas and clamp to zero.
   * This prevents lost updates when multiple settlements adjust concurrently.
   */
  adjustJackpotBalances(deltas: { deltaRace?: string | Decimal; deltaSol?: string | Decimal }): { jackpotBalance: string; jackpotBalanceSol: string } {
    const tx = (db as any).transaction((deltaRace: string, deltaSol: string) => {
      const row = this.treasurySelect.get() as any;
      const currentRace = new Decimal(row?.jackpotBalance || '0');
      const currentSol = new Decimal(row?.jackpotBalanceSol || '0');
      const nextRace = currentRace.add(new Decimal(deltaRace || '0'));
      const nextSol = currentSol.add(new Decimal(deltaSol || '0'));
      const clampedRace = nextRace.isNegative() ? new Decimal(0) : nextRace;
      const clampedSol = nextSol.isNegative() ? new Decimal(0) : nextSol;
      this.treasuryUpdateBalances.run(clampedRace.toString(), clampedSol.toString());
      return { jackpotBalance: clampedRace.toString(), jackpotBalanceSol: clampedSol.toString() };
    });

    const deltaRaceStr = deltas?.deltaRace !== undefined ? String(deltas.deltaRace) : '0';
    const deltaSolStr = deltas?.deltaSol !== undefined ? String(deltas.deltaSol) : '0';
    try {
      return tx(deltaRaceStr, deltaSolStr);
    } catch (e) {
      // Fallback (should not happen with single-process better-sqlite3): compute once and clamp
      const row = this.treasurySelect.get() as any;
      const currentRace = new Decimal(row?.jackpotBalance || '0');
      const currentSol = new Decimal(row?.jackpotBalanceSol || '0');
      const nextRace = currentRace.add(new Decimal(deltaRaceStr || '0'));
      const nextSol = currentSol.add(new Decimal(deltaSolStr || '0'));
      const clampedRace = nextRace.isNegative() ? new Decimal(0) : nextRace;
      const clampedSol = nextSol.isNegative() ? new Decimal(0) : nextSol;
      this.treasuryUpdateBalances.run(clampedRace.toString(), clampedSol.toString());
      return { jackpotBalance: clampedRace.toString(), jackpotBalanceSol: clampedSol.toString() };
    }
  }

  clearRaces(): void {
    // PRODUCTION SAFETY: Block destructive operations in production
    const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
    const isReplit = Boolean(process.env.REPLIT_DEPLOYMENT);
    
    if (isProd && isReplit && process.env.ALLOW_RESET !== '1') {
      console.error('⛔ clearRaces() is BLOCKED in production');
      console.error('⛔ This would delete all race/bet data');
      console.error('⛔ Set ALLOW_RESET=1 to override (NOT RECOMMENDED)');
      throw new Error('clearRaces blocked in production - would cause data loss');
    }
    
    this.betDeleteAll.run();
    this.raceDeleteAll.run();
    console.log("🗑️ Cleared all races and bets");
  }

  // Transaction deduplication methods
  hasSeenTransaction(sig: string): boolean {
    return !!this.seenTxSelect.get(sig);
  }

  recordTransaction(sig: string): void {
    // Use upsert so callers can safely record without worrying about prior reservations
    this.seenTxUpsert.run(sig, Date.now());
  }

  cleanupOldTransactions(maxAge: number = 48 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAge;
    this.seenTxCleanup.run(cutoff);
  }

  // Reserve a transaction signature atomically to prevent replay/race conditions
  reserveTransaction(sig: string): boolean {
    try {
      this.seenTxInsert.run(sig, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  // Release a previously reserved signature (used when verification fails)
  releaseTransaction(sig: string): void {
    try {
      this.seenTxDelete.run(sig);
    } catch {}
  }

  // Settlement transfer methods
  recordSettlementTransfer(transfer: any): void {
    this.settlementTransferUpsert.run(
      transfer.id,
      transfer.raceId,
      transfer.transferType,
      transfer.toWallet,
      transfer.amount,
      transfer.txSig,
      (transfer.currency || 'RACE'),
      transfer.ts
    );
    // Mirror to Postgres (best-effort)
    fireAndForget(async () => {
      await this.pgInsertSettlementTransfer({
        id: String(transfer.id),
        raceId: String(transfer.raceId),
        transferType: String(transfer.transferType),
        toWallet: String(transfer.toWallet),
        amount: String(transfer.amount),
        txSig: String(transfer.txSig),
        currency: String(transfer.currency || 'RACE'),
        ts: Number(transfer.ts || Date.now())
      });
    });
  }

  recordSettlementError(entry: { id: string; raceId: string; toWallet?: string; amount?: string; currency?: 'SOL' | 'RACE'; error: string; ts?: number }): void {
    this.settlementErrorUpsert.run(
      entry.id,
      entry.raceId,
      entry.toWallet ?? null,
      entry.amount ?? null,
      (entry.currency || 'RACE'),
      entry.error,
      entry.ts ?? Date.now()
    );
    fireAndForget(async () => {
      await this.pgInsertSettlementError(entry);
    });
  }

  // ===== Leaderboard and Stats API =====
  upsertUserRaceResult(result: { wallet: string; raceId: string; betAmount: string; payoutAmount: string; win: boolean; edgePoints: string; ts?: number; }): void {
    this.userRaceResultUpsert.run(
      result.wallet,
      result.raceId,
      result.betAmount,
      result.payoutAmount,
      result.win ? 1 : 0,
      result.edgePoints,
      result.ts ?? Date.now()
    );

    // Mirror to Postgres for durability
    if (pgReady && pgPool) {
      const { wallet, raceId, betAmount, payoutAmount, win, edgePoints } = result;
      const ts = result.ts ?? Date.now();
      fireAndForget(async () => {
        await pgPool!.query(
          `INSERT INTO user_race_results (wallet, race_id, bet_amount, payout_amount, win, edge_points, ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (wallet, race_id) DO UPDATE SET
             bet_amount = EXCLUDED.bet_amount,
             payout_amount = EXCLUDED.payout_amount,
             win = EXCLUDED.win,
             edge_points = EXCLUDED.edge_points,
             ts = EXCLUDED.ts`,
          [wallet, raceId, betAmount, payoutAmount, win, edgePoints, ts]
        );
      });
    }
  }

  recalcUserStats(wallet: string): void {
    const rows = this.userRaceResultsByWallet.all(wallet) as Array<{ betAmount: string; payoutAmount: string; win: number; edgePoints: string }>;
    const totalRaces = rows.length;
    let wins = 0;
    let totalWagered = new Decimal('0');
    let totalAwarded = new Decimal('0');
    let edgePoints = new Decimal('0');
    for (const r of rows) {
      if (r.win) wins++;
      totalWagered = totalWagered.add(new Decimal(r.betAmount || '0'));
      totalAwarded = totalAwarded.add(new Decimal(r.payoutAmount || '0'));
      edgePoints = edgePoints.add(new Decimal(r.edgePoints || '0'));
    }
    const losses = Math.max(0, totalRaces - wins);
    this.userStatsUpsert.run(
      wallet,
      totalRaces,
      wins,
      losses,
      totalWagered.toString(),
      totalAwarded.toString(),
      edgePoints.toString(),
      Date.now()
    );
    
    // Force checkpoint to ensure persistence
    this.checkpoint();

    // Mirror to Postgres for durability
    if (pgReady && pgPool) {
      const lastUpdated = Date.now();
      const totalW = totalWagered.toString();
      const totalA = totalAwarded.toString();
      const edge = edgePoints.toString();
      fireAndForget(async () => {
        await pgPool!.query(
          `INSERT INTO user_stats (wallet, total_races, wins, losses, total_wagered, total_awarded, edge_points, last_updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (wallet) DO UPDATE SET
             total_races = EXCLUDED.total_races,
             wins = EXCLUDED.wins,
             losses = EXCLUDED.losses,
             total_wagered = EXCLUDED.total_wagered,
             total_awarded = EXCLUDED.total_awarded,
             edge_points = EXCLUDED.edge_points,
             last_updated = EXCLUDED.last_updated`,
          [wallet, totalRaces, wins, losses, totalW, totalA, edge, lastUpdated]
        );
      });
    }
  }

  getLeaderboard(limit: number = 10): Array<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number }> {
    return this.leaderboardSelect.all(limit) as any[];
  }

  getUserStats(wallet: string): { wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number } | undefined {
    return this.userStatsSelect.get(wallet) as any;
  }

  getUserRank(wallet: string): number | null {
    const row = this.userRankSelect.get(wallet) as any;
    if (!row || row.rank === null || row.rank === undefined) return null;
    return Number(row.rank);
  }

  getUserStatsRowCount(): number {
    const row = this.userStatsCount.get() as any;
    return Number((row && row.count) || 0);
  }

  getUserStatsSummary(): { walletCount: number; lastUpdated: number } {
    const row = this.userStatsSummaryStmt.get() as any;
    return {
      walletCount: Number(row?.walletCount || 0),
      lastUpdated: Number(row?.lastUpdated || 0)
    };
  }

  getDistinctWalletsWithResults(): string[] {
    const rows = this.distinctResultWalletsSelect.all() as any[];
    return rows.map(r => r.wallet);
  }

  getUserRaceResultsSummary(): { walletCount: number; lastUpdated: number } {
    const row = this.userRaceResultsSummaryStmt.get() as any;
    return {
      walletCount: Number(row?.walletCount || 0),
      lastUpdated: Number(row?.lastUpdated || 0)
    };
  }

  // ===== Fallback aggregation (all-time) from user_race_results =====
  getLeaderboardFromResults(limit: number = 10): Array<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number }> {
    return this.aggLeaderboardFromResults.all(limit) as any[];
  }

  // ===== Per-race pot snapshot from durable results (avoids missing bets after restart) =====
  getRacePotSnapshot(raceId: string): { totalPot: string; betCount: number } {
    try {
      const row = this.racePotFromResults.get(raceId) as any;
      return {
        totalPot: String(row?.totalPot ?? '0'),
        betCount: Number(row?.betCount ?? 0)
      };
    } catch {
      return { totalPot: '0', betCount: 0 };
    }
  }

  getUserStatsFromResults(wallet: string): { wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number } | undefined {
    return this.aggUserFromResults.get(wallet) as any;
  }

  getUserRankFromResults(wallet: string): number | null {
    const row = this.aggRankFromResults.get(wallet, wallet) as any;
    if (!row || row.rank === null || row.rank === undefined) return null;
    return Number(row.rank);
  }

  rebuildUserStatsFromResults(): void {
    const rows = this.aggAllFromResults.all() as any[];
    const now = Date.now();
    for (const r of rows) {
      this.userStatsUpsert.run(
        r.wallet,
        Number(r.totalRaces) || 0,
        Number(r.wins) || 0,
        Number(r.losses) || 0,
        String(r.totalWagered ?? '0'),
        String(r.totalAwarded ?? '0'),
        String(r.edgePoints ?? '0'),
        now
      );
    }
    this.checkpoint();
  }

  // ===== Optional Postgres reads for durability when SQLite cache is empty =====
  async getLeaderboardFromPostgres(limit: number = 10): Promise<Array<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number }>> {
    if (!pgReady || !pgPool) return [];
    try {
      // Prefer user_stats table
      const res = await pgPool.query(
        `SELECT wallet, total_races, wins, losses, total_wagered, total_awarded, edge_points, last_updated
         FROM user_stats
         ORDER BY edge_points::numeric DESC, wins DESC
         LIMIT $1`,
        [limit]
      );
      if (res.rows && res.rows.length > 0) {
        return res.rows.map((r: any) => ({
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
      // Fallback aggregate from user_race_results
      const agg = await pgPool.query(
        `SELECT wallet,
                COUNT(1) AS total_races,
                SUM(CASE WHEN win THEN 1 ELSE 0 END) AS wins,
                (COUNT(1) - SUM(CASE WHEN win THEN 1 ELSE 0 END)) AS losses,
                COALESCE(SUM(bet_amount), 0) AS total_wagered,
                COALESCE(SUM(payout_amount), 0) AS total_awarded,
                COALESCE(SUM(edge_points), 0) AS edge_points,
                COALESCE(MAX(ts), 0) AS last_updated
         FROM user_race_results
         GROUP BY wallet
         ORDER BY edge_points::numeric DESC, wins DESC
         LIMIT $1`,
        [limit]
      );
      return agg.rows.map((r: any) => ({
        wallet: String(r.wallet),
        totalRaces: Number(r.total_races) || 0,
        wins: Number(r.wins) || 0,
        losses: Number(r.losses) || 0,
        totalWagered: String(r.total_wagered ?? '0'),
        totalAwarded: String(r.total_awarded ?? '0'),
        edgePoints: String(r.edge_points ?? '0'),
        lastUpdated: Number(r.last_updated) || 0
      }));
    } catch (e) {
      console.warn('⚠️ getLeaderboardFromPostgres failed:', e);
      return [];
    }
  }

  async getUserStatsFromPostgres(wallet: string): Promise<{ wallet: string; totalRaces: number; wins: number; losses: number; totalWagered: string; totalAwarded: string; edgePoints: string; lastUpdated: number } | undefined> {
    if (!pgReady || !pgPool) return undefined;
    try {
      const res = await pgPool.query(
        `SELECT wallet, total_races, wins, losses, total_wagered, total_awarded, edge_points, last_updated FROM user_stats WHERE wallet=$1`,
        [wallet]
      );
      if (res.rows && res.rows[0]) {
        const r = res.rows[0];
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
      // Fallback aggregate from user_race_results
      const agg = await pgPool.query(
        `SELECT wallet,
                COUNT(1) AS total_races,
                SUM(CASE WHEN win THEN 1 ELSE 0 END) AS wins,
                (COUNT(1) - SUM(CASE WHEN win THEN 1 ELSE 0 END)) AS losses,
                COALESCE(SUM(bet_amount), 0) AS total_wagered,
                COALESCE(SUM(payout_amount), 0) AS total_awarded,
                COALESCE(SUM(edge_points), 0) AS edge_points,
                COALESCE(MAX(ts), 0) AS last_updated
         FROM user_race_results
         WHERE wallet=$1
         GROUP BY wallet`,
        [wallet]
      );
      if (agg.rows && agg.rows[0]) {
        const r = agg.rows[0];
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
      return undefined;
    } catch (e) {
      console.warn('⚠️ getUserStatsFromPostgres failed:', e);
      return undefined;
    }
  }

  async getUserRankFromPostgres(wallet: string): Promise<number | null> {
    if (!pgReady || !pgPool) return null;
    try {
      // Rank by aggregated edge points
      const agg = await pgPool.query(
        `WITH aggregated AS (
           SELECT wallet, COALESCE(SUM(edge_points),0) AS ep
           FROM user_race_results
           GROUP BY wallet
         )
         SELECT CASE WHEN (SELECT ep FROM aggregated WHERE wallet=$1) IS NULL THEN NULL ELSE 1 + (
           SELECT COUNT(1) FROM aggregated WHERE ep > (SELECT ep FROM aggregated WHERE wallet=$1)
         ) END AS rank`,
        [wallet]
      );
      const rank = agg.rows?.[0]?.rank;
      return rank === null || rank === undefined ? null : Number(rank);
    } catch (e) {
      console.warn('⚠️ getUserRankFromPostgres failed:', e);
      return null;
    }
  }

  getSettlementTransfers(raceId: string): any[] {
    return this.settlementTransfersSelect.all(raceId);
  }

  // New helpers for receipts/UX
  getSettlementTransfersForWallet(wallet: string, limit: number = 20): any[] {
    return this.settlementTransfersByWallet.all(wallet, limit);
  }

  getSettlementTransferForRaceAndWallet(raceId: string, wallet: string): any | undefined {
    return this.settlementTransferByRaceAndWallet.get(raceId, wallet) as any;
  }

  getSettlementErrors(raceId: string, limit: number = 100): any[] {
    return this.settlementErrorsByRace.all(raceId, limit) as any[];
  }

  getRecentSettlementErrors(limit: number = 100): any[] {
    return this.settlementErrorsRecent.all(limit) as any[];
  }

  getUserRecentResults(wallet: string, limit: number = 20): Array<{ raceId: string; betAmount: string; payoutAmount: string; win: number; edgePoints: string; ts: number }>{
    return this.userRaceResultsRecentByWallet.all(wallet, limit) as any[];
  }

  // Aggregates for reconciliation
  getLedgerAggregates(): { totalBets: string; totalPayouts: string; totalRake: string } {
    const b = (this.sumAllBets.get() as any)?.total || '0';
    const p = (this.sumAllPayouts.get() as any)?.total || '0';
    const r = (this.sumAllRake.get() as any)?.total || '0';
    return { totalBets: String(b), totalPayouts: String(p), totalRake: String(r) };
  }

  // Recent winners methods
  addRecentWinner(race: Race): void {
    // Only add if race is settled with a winner
    if (race.status !== 'SETTLED' || race.winnerIndex === undefined) {
      return;
    }

    // Compute and persist pot/betCount snapshot to avoid later resets showing 0
    // Include per-currency totals so we don't need to recompute from bets later
    const bets = this.getBetsForRace(race.id) as any[];
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

    this.recentWinnersInsert.run(race.id, raceData, settledAt);
    
    // Clean up old winners, keep only the last 6
    this.recentWinnersCleanup.run(6);
    
    // Force checkpoint to ensure persistence
    this.checkpoint();

    // Mirror to Postgres for durability
    if (pgReady && pgPool) {
      fireAndForget(async () => {
        await pgPool!.query(
          `INSERT INTO recent_winners (race_id, race_data, settled_at, total_pot, bet_count)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (race_id) DO UPDATE SET
             race_data = EXCLUDED.race_data,
             settled_at = EXCLUDED.settled_at,
             total_pot = EXCLUDED.total_pot,
             bet_count = EXCLUDED.bet_count`,
          [race.id, raceData, settledAt, totalPotNum, betCount]
        );
      });
    }
  }

  getRecentWinners(limit: number = 6): Race[] {
    // Prefer SQLite (already hydrated at boot); if empty and PG is available, hydrate on-demand
    const rows = this.recentWinnersSelect.all(limit) as any[];
    if (rows && rows.length > 0) {
      return rows.map(row => JSON.parse(row.raceData));
    }
    // Fallback: try to load from Postgres synchronously via cached snapshot (not available), return empty and rely on boot hydration
    return [];
  }

  // ===== Referrals API =====
  upsertReferralUser({ wallet, code }: { wallet: string; code: string }): { wallet: string; code: string } {
    const now = Date.now();
    this.refUserUpsert.run(wallet, code, now, now);
    // Mirror async
    try { this.pgUpsertReferralUser({ wallet, code, createdAt: now, updatedAt: now }); } catch {}
    return { wallet, code };
  }

  getReferralUserByWallet(wallet: string): { wallet: string; code: string; createdAt: number; updatedAt: number } | undefined {
    return this.refUserByWallet.get(wallet) as any;
  }

  getReferralUserByCode(code: string): { wallet: string; code: string; createdAt: number; updatedAt: number } | undefined {
    return this.refUserByCode.get(code) as any;
  }

  upsertReferralAttribution({ id, wallet, code, source }: { id: string; wallet: string; code: string; source?: string }): void {
    const now = Date.now();
    this.refAttrUpsert.run(id, wallet, code, source ?? null, now, now);
    try { this.pgUpsertAttribution({ id, wallet, code, source, firstSeenTs: now, lastSeenTs: now }); } catch {}
  }

  getReferralAttributionForWallet(wallet: string): { id: string; wallet: string; code: string } | undefined {
    return this.refAttrByWallet.get(wallet) as any;
  }

  getReferralSettings(): any {
    return this.refSettingsGet.get() as any;
  }

  updateReferralSettings(settings: Partial<{ enabled: boolean; discountBps: number; level1Bps: number; level2Bps: number; level3Bps: number; poolBps: number; minPayout: string; payoutCron: string }>): void {
    const current = this.getReferralSettings();
    const merged = {
      enabled: (settings.enabled ?? (current?.enabled ?? 1)) ? 1 : 0,
      discountBps: settings.discountBps ?? current?.discountBps ?? 500,
      level1Bps: settings.level1Bps ?? current?.level1Bps ?? 3000,
      level2Bps: settings.level2Bps ?? current?.level2Bps ?? 600,
      level3Bps: settings.level3Bps ?? current?.level3Bps ?? 200,
      poolBps: settings.poolBps ?? current?.poolBps ?? 5000,
      minPayout: settings.minPayout ?? current?.minPayout ?? '0.01',
      payoutCron: settings.payoutCron ?? current?.payoutCron ?? 'daily'
    };
    this.refSettingsUpdate.run(merged.enabled, merged.discountBps, merged.level1Bps, merged.level2Bps, merged.level3Bps, merged.poolBps, merged.minPayout, merged.payoutCron);
  }

  insertReferralReward(row: { id: string; raceId: string; fromWallet: string; toWallet: string; level: number; currency: 'RACE' | 'SOL'; amount: string; ts?: number }): void {
    const ts = row.ts ?? Date.now();
    this.refRewardInsert.run(row.id, row.raceId, row.fromWallet, row.toWallet, row.level, row.currency, row.amount, 'PENDING', null, ts);
    try { this.pgInsertReward({ ...row, ts }); } catch {}
  }

  markReferralRewardPaid(id: string, txSig: string): void {
    this.refRewardUpdatePaid.run(txSig, Date.now(), id);
    try { this.pgMarkRewardPaid(id, txSig); } catch {}
  }

  getUnpaidReferralRewards(limit: number = 500): any[] {
    return this.refRewardsUnpaid.all(limit) as any[];
  }

  upsertReferralAggregate(row: { wallet: string; directCount: number; indirectCount: number; totalRewards: string; totalPaid: string; ts?: number }): void {
    this.refAggUpsert.run(row.wallet, row.directCount, row.indirectCount, row.totalRewards, row.totalPaid, row.ts ?? Date.now());
  }

  getReferralAggregate(wallet: string): any | undefined {
    return this.refAggGet.get(wallet) as any;
  }

  // Return referral reward sums for a given race, split by currency and status
  getReferralRewardSumsForRace(raceId: string): { RACE: { paid: string; pending: string }; SOL: { paid: string; pending: string } } {
    const out = { RACE: { paid: '0', pending: '0' }, SOL: { paid: '0', pending: '0' } } as const;
    try {
      const rows = this.refRewardsSumsByRace.all(raceId) as Array<{ currency: 'RACE' | 'SOL'; status: 'PENDING' | 'PAID' | string; total: string }>;
      const result: any = { RACE: { paid: '0', pending: '0' }, SOL: { paid: '0', pending: '0' } };
      for (const r of rows || []) {
        const cur = (String(r.currency || 'RACE').toUpperCase() === 'SOL') ? 'SOL' : 'RACE';
        const st = (String(r.status || 'PENDING').toUpperCase() === 'PAID') ? 'paid' : 'pending';
        result[cur][st] = String(r.total || '0');
      }
      return result;
    } catch {
      return { RACE: { paid: '0', pending: '0' }, SOL: { paid: '0', pending: '0' } } as any;
    }
  }

  close(): void {
    if (db) {
      db.close();
    }
  }

  // Force a WAL checkpoint to ensure data is written to disk
  checkpoint(): void {
    try {
      if (db && typeof db.pragma === 'function') {
        const result = db.pragma('wal_checkpoint(PASSIVE)');
        console.log('💾 Manual checkpoint result:', result);
      }
    } catch (e) {
      console.error('❌ Manual checkpoint failed:', e);
    }
  }
}

// Create storage instance based on environment
let storageInstance: any = null;

if (usePostgres) {
  // Production mode: Use PostgresStorage (async methods)
  // We'll lazy-init after pgPool is ready
  console.log("ℹ️  Production mode: PostgresStorage will be initialized after Postgres connects");
} else if (db) {
  // Development mode: Use SQLiteStorage (sync methods)
  storageInstance = new SQLiteStorage();
  console.log("✅ SQLiteStorage initialized for development mode");
}

// Export storage - will be PostgresStorage in production, SQLiteStorage in development
// NOTE: In production, this will be set after hydrationPromise resolves
export let sqliteDb: any = storageInstance;

// Export getter function to avoid capturing null value at import time
export function getDb(): any {
  return sqliteDb;
}

// Export driver selection info for diagnostics
export { usePostgres, isProd };

// Export pgPool for direct Postgres access when needed
export { pgPool, pgReady };

// Export a promise that resolves when Postgres initialization is complete
export const hydrationPromise: Promise<void> = (async () => {
  try {
    // Wrap initPostgres() with timeout to prevent indefinite hangs
    const initPromise = initPostgres();
    const timeoutPromise = new Promise<void>((_, reject) => 
      setTimeout(() => reject(new Error('Postgres initialization timeout after 30s')), 30000)
    );
    
    await Promise.race([initPromise, timeoutPromise]);
    
    if (pgReady && pgPool) {
      if (usePostgres) {
        console.log('✅ Postgres initialized - setting up PostgresStorage');
        
        // Initialize PostgresStorage for production (using static import to avoid esbuild issues)
        try {
          sqliteDb = new PostgresStorage(pgPool);
          console.log('✅ PostgresStorage initialized - production mode ready');
        } catch (err) {
          console.error('❌ Failed to initialize PostgresStorage:', err);
          throw err;
        }
      } else {
        console.log('✅ Postgres initialized - available as secondary backend');
      }
    } else {
      if (usePostgres) {
        console.error('❌ CRITICAL: Production mode requires Postgres but initialization failed!');
      } else {
        console.log('ℹ️  Postgres not configured - using SQLite only (development mode)');
      }
    }
  } catch (e) {
    console.error('❌ Database initialization failed:', e);
    if (usePostgres) {
      console.error('❌ CRITICAL: Production mode requires Postgres - startup failed!');
      throw e; // Fail startup in production if Postgres is unavailable
    }
    // Don't throw in development - allow server to start with SQLite only
  }
})();

// Deployment diagnostics (admin-only exposure via routes)
export async function getDbDiagnostics(): Promise<{
  database_backend: 'postgres' | 'sqlite';
  sqlite: { path: string; user_stats_count: number; user_race_results_count: number; recent_winners_count: number; bets_count: number; settlement_transfers_count: number; referrals_count: number };
  postgres: { 
    ready: boolean; 
    usedKey: string | null; 
    connection: string | null; 
    user_stats_count?: number; 
    user_race_results_count?: number; 
    recent_winners_count?: number; 
    bets_count?: number;
    settlement_transfers_count?: number;
    referrals_count?: number;
    db_url_hash?: string;
    current_database?: string;
    current_schema?: string;
    migrations_applied?: number;
    last_migration?: string;
  };
  env: { DATABASE_URL: boolean; PGHOST: boolean; NODE_ENV: string; REPLIT_DEPLOYMENT: boolean };
}> {
  try {
    const countQuery = (sql: string): number => {
      if (!db) return 0; // No SQLite in production
      try {
        const row = db.prepare(sql).get() as any;
        return Number(row?.count || 0);
      } catch {
        return 0;
      }
    };
    const sqliteDiag = {
      path: sqlitePath,
      user_stats_count: db ? countQuery('SELECT COUNT(1) AS count FROM user_stats') : 0,
      user_race_results_count: db ? countQuery('SELECT COUNT(1) AS count FROM user_race_results') : 0,
      recent_winners_count: db ? countQuery('SELECT COUNT(1) AS count FROM recent_winners') : 0,
      bets_count: db ? countQuery('SELECT COUNT(1) AS count FROM bets') : 0,
      settlement_transfers_count: db ? countQuery('SELECT COUNT(1) AS count FROM settlement_transfers') : 0,
      referrals_count: db ? countQuery('SELECT COUNT(1) AS count FROM referral_users') : 0
    };

    const pgDiag: { ready: boolean; usedKey: string | null; connection: string | null; user_stats_count?: number; user_race_results_count?: number; recent_winners_count?: number; bets_count?: number } = {
      ready: pgReady,
      usedKey: lastPgConfigInfo.usedKey,
      connection: lastPgConfigInfo.connectionStringRedacted
    };
    if (pgReady && pgPool) {
      try {
        const res1 = await pgPool.query('SELECT COUNT(1) AS count FROM user_stats');
        pgDiag.user_stats_count = Number(res1.rows?.[0]?.count || 0);
      } catch {}
      try {
        const res2 = await pgPool.query('SELECT COUNT(1) AS count FROM user_race_results');
        pgDiag.user_race_results_count = Number(res2.rows?.[0]?.count || 0);
      } catch {}
      try {
        const res3 = await pgPool.query('SELECT COUNT(1) AS count FROM recent_winners');
        pgDiag.recent_winners_count = Number(res3.rows?.[0]?.count || 0);
      } catch {}
      try {
        const res4 = await pgPool.query('SELECT COUNT(1) AS count FROM bets');
        pgDiag.bets_count = Number(res4.rows?.[0]?.count || 0);
      } catch {}
      try {
        const res5 = await pgPool.query('SELECT COUNT(1) AS count FROM settlement_transfers');
        pgDiag.settlement_transfers_count = Number(res5.rows?.[0]?.count || 0);
      } catch {}
      try {
        const res6 = await pgPool.query('SELECT COUNT(1) AS count FROM referral_users');
        pgDiag.referrals_count = Number(res6.rows?.[0]?.count || 0);
      } catch {}
      
      // Database connection info
      try {
        const dbInfo = await pgPool.query('SELECT current_database(), current_schema()');
        pgDiag.current_database = dbInfo.rows?.[0]?.current_database;
        pgDiag.current_schema = dbInfo.rows?.[0]?.current_schema;
      } catch {}
      
      // Hash of DATABASE_URL for verification (not the full URL for security)
      try {
        if (process.env.DATABASE_URL) {
          const crypto = await import('node:crypto');
          const hash = crypto.createHash('sha256').update(process.env.DATABASE_URL).digest('hex');
          pgDiag.db_url_hash = hash.substring(0, 16);
        }
      } catch {}
      
      // Migration info
      try {
        const migRes = await pgPool.query('SELECT COUNT(1) AS count FROM app_migrations');
        pgDiag.migrations_applied = Number(migRes.rows?.[0]?.count || 0);
      } catch {}
      
      try {
        const lastMig = await pgPool.query('SELECT filename, applied_at FROM app_migrations ORDER BY applied_at DESC LIMIT 1');
        if (lastMig.rows?.[0]) {
          const date = new Date(Number(lastMig.rows[0].applied_at));
          pgDiag.last_migration = `${lastMig.rows[0].filename} (${date.toISOString()})`;
        }
      } catch {}
    }

    const backend = pgReady ? 'postgres' : 'sqlite';

    return {
      database_backend: backend,
      sqlite: sqliteDiag,
      postgres: pgDiag,
      env: {
        DATABASE_URL: !!process.env.DATABASE_URL,
        PGHOST: !!process.env.PGHOST,
        NODE_ENV: process.env.NODE_ENV || 'development',
        REPLIT_DEPLOYMENT: !!process.env.REPLIT_DEPLOYMENT
      }
    };
  } catch {
    return {
      database_backend: pgReady ? 'postgres' : 'sqlite',
      sqlite: { 
        path: sqlitePath, 
        user_stats_count: 0, 
        user_race_results_count: 0, 
        recent_winners_count: 0, 
        bets_count: 0,
        settlement_transfers_count: 0,
        referrals_count: 0
      },
      postgres: { ready: pgReady, usedKey: lastPgConfigInfo.usedKey, connection: lastPgConfigInfo.connectionStringRedacted },
      env: { 
        DATABASE_URL: !!process.env.DATABASE_URL, 
        PGHOST: !!process.env.PGHOST,
        NODE_ENV: process.env.NODE_ENV || 'development',
        REPLIT_DEPLOYMENT: !!process.env.REPLIT_DEPLOYMENT
      }
    };
  }
}
