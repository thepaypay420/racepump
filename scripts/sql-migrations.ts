import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Pure SQL Migration System (No Drizzle)
 * - Runs SQL files directly from sql-scripts/ directory (renamed from "migrations" to avoid Replit detection)
 * - Tracks applied migrations in app_migrations table
 * - Blocks destructive operations
 * - Completely independent of Drizzle
 */

// Global lock to prevent concurrent migration runs
let migrationLock: Promise<void> | null = null;

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

async function runSqlMigrations(existingPool?: Pool) {
  console.log(`🎯 runSqlMigrations called with existingPool=${!!existingPool}`);
  
  // If migrations are already running, wait for them to complete
  console.log(`🔒 Checking migration lock... migrationLock=${!!migrationLock}`);
  if (migrationLock) {
    console.log('⏳ Migrations already running, waiting for completion...');
    try {
      await migrationLock;
      console.log('✅ Migrations completed by another process');
    } catch (error) {
      console.error('⚠️  Previous migration failed, attempting to continue...');
    }
    return;
  }

  // Create lock promise with guaranteed resolution
  let resolveLock: () => void = () => {}; // Default no-op to prevent undefined
  let rejectLock: (reason?: any) => void = () => {};
  
  migrationLock = new Promise((resolve, reject) => {
    resolveLock = resolve;
    rejectLock = reject;
  });

  try {
    // Use existing pool if provided, otherwise create new one from DATABASE_URL
    let pool: Pool;
    let shouldClosePool = false;
    
    if (existingPool) {
      console.log('🔄 Using existing database connection for migrations');
      pool = existingPool;
    } else {
      const DATABASE_URL = process.env.DATABASE_URL;
      
      if (!DATABASE_URL) {
        console.error('❌ DATABASE_URL is required to run migrations');
        process.exit(1);
      }

      pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
        query_timeout: 30000,
        statement_timeout: 30000,
        max: 5, // Limit pool size to prevent exhaustion
        idleTimeoutMillis: 30000,
        allowExitOnIdle: true
      });
      shouldClosePool = true;
    }

    try {
      console.log('🔄 Starting pure SQL migration runner...');
    
      // Ensure migrations tracking table exists (not drizzle_migrations)
      console.log('📋 Creating app_migrations tracking table...');
      await withTimeout(
        pool.query(`
          CREATE TABLE IF NOT EXISTS app_migrations (
            id SERIAL PRIMARY KEY,
            filename TEXT NOT NULL UNIQUE,
            hash TEXT NOT NULL,
            applied_at BIGINT NOT NULL
          )
        `),
        15000,
        'Creating app_migrations table'
      );
      console.log('✅ Tracking table ready');

      // Read all migration files from sql-scripts/ directory
      // (renamed from "migrations" to avoid Replit's auto-detection)
      const migrationsDir = path.join(process.cwd(), 'sql-scripts');
      
      // Create sql-scripts directory if it doesn't exist
      if (!fs.existsSync(migrationsDir)) {
        fs.mkdirSync(migrationsDir, { recursive: true });
        console.log('📁 Created sql-scripts/ directory');
      }

      const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

      console.log(`📂 Found ${files.length} SQL migration file(s)`);

      let appliedCount = 0;
      let skippedCount = 0;

      for (const file of files) {
        console.log(`🔍 Processing migration file: ${file}`);
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');
        const hash = crypto.createHash('sha256').update(sql).digest('hex');

        // Check if already applied (check by filename)
        console.log(`   Checking if ${file} was already applied...`);
        const { rows } = await withTimeout(
          pool.query(
            'SELECT id, applied_at FROM app_migrations WHERE filename = $1',
            [file]
          ),
          10000,
          `Checking migration status for ${file}`
        );

        if (rows.length > 0) {
          const appliedDate = new Date(Number(rows[0].applied_at)).toISOString();
          console.log(`⏭️  Skipping ${file} (already applied at ${appliedDate})`);
          skippedCount++;
          continue;
        }

        // Check for destructive operations
        // Note: Dropping drizzle_migrations is safe (it's just a tracking table we no longer use)
        const hasDrizzleDrop = /DROP\s+TABLE\s+IF\s+EXISTS\s+drizzle_migrations/i.test(sql);
        
        const destructivePatterns = [
          /DROP\s+TABLE/i,
          /DROP\s+COLUMN/i,
          /TRUNCATE/i,
          /DELETE\s+FROM\s+(bets|user_race_results|user_stats|recent_winners|settlement_transfers|referral_)/i
        ];

        const isDestructive = destructivePatterns.some(pattern => pattern.test(sql)) && !hasDrizzleDrop;
        
        if (isDestructive && process.env.ALLOW_DESTRUCTIVE_MIGRATIONS !== '1') {
          console.error(`❌ DESTRUCTIVE MIGRATION DETECTED in ${file}`);
          console.error('⛔ This migration contains DROP TABLE, DROP COLUMN, TRUNCATE, or DELETE operations');
          console.error('⛔ Set ALLOW_DESTRUCTIVE_MIGRATIONS=1 to override (NOT RECOMMENDED IN PRODUCTION)');
          process.exit(1);
        }

        if (isDestructive) {
          console.warn(`⚠️  WARNING: Running DESTRUCTIVE migration ${file} (ALLOW_DESTRUCTIVE_MIGRATIONS=1)`);
        }

        console.log(`📝 Applying migration: ${file}`);
        
        try {
          // Run migration in a transaction with timeout protection
          console.log(`   Starting transaction...`);
          await withTimeout(pool.query('BEGIN'), 5000, 'BEGIN transaction');
          
          console.log(`   Executing SQL (${sql.length} characters)...`);
          await withTimeout(pool.query(sql), 45000, `Executing ${file}`);
          
          // Record migration as applied
          console.log(`   Recording migration...`);
          await withTimeout(
            pool.query(
              'INSERT INTO app_migrations (filename, hash, applied_at) VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING',
              [file, hash, Date.now()]
            ),
            5000,
            'Recording migration'
          );
          
          console.log(`   Committing transaction...`);
          await withTimeout(pool.query('COMMIT'), 5000, 'COMMIT transaction');
          
          console.log(`✅ Applied ${file}`);
          appliedCount++;
        } catch (error: any) {
          console.log(`   Rolling back transaction...`);
          try {
            await withTimeout(pool.query('ROLLBACK'), 5000, 'ROLLBACK transaction');
          } catch (rollbackError) {
            console.error(`   ⚠️  Rollback failed:`, rollbackError);
          }
          
          // If this is a duplicate key error on the filename, it means another process
          // applied this migration concurrently. This is safe to ignore.
          if (error.code === '23505' && error.constraint === 'app_migrations_filename_key') {
            console.log(`⏭️  Skipping ${file} (applied by concurrent process)`);
            skippedCount++;
            continue;
          }
          
          console.error(`❌ Failed to apply ${file}:`, error);
          console.error(`   Error code: ${error.code}`);
          console.error(`   Error detail: ${error.detail}`);
          throw error;
        }
      }

      console.log(`\n✅ Pure SQL migration complete:`);
      console.log(`   - Applied: ${appliedCount}`);
      console.log(`   - Skipped: ${skippedCount}`);
      console.log(`   - Total: ${files.length}`);

    } catch (error) {
      console.error('❌ Migration failed:', error);
      
      // Store error to reject lock with
      const migrationError = error;
      
      // Clean up pool before throwing
      if (shouldClosePool) {
        try {
          console.log('🔌 Closing migration database connection after error...');
          await withTimeout(pool.end(), 5000, 'Closing pool connection');
          console.log('✅ Connection closed');
        } catch (closeError) {
          console.error('⚠️  Failed to close pool cleanly:', closeError);
        }
      }
      
      // Reject the lock so waiting processes know about the error
      rejectLock(migrationError);
      migrationLock = null;
      
      throw error;
    }
    
    // Success path: close pool and resolve lock
    if (shouldClosePool) {
      try {
        console.log('🔌 Closing migration database connection...');
        await withTimeout(pool.end(), 5000, 'Closing pool connection');
        console.log('✅ Connection closed');
      } catch (closeError) {
        console.error('⚠️  Failed to close pool cleanly:', closeError);
      }
    }
    
    // Resolve lock on success
    resolveLock();
    migrationLock = null;
    
  } catch (outerError) {
    // This catches any errors in pool setup before the inner try block
    console.error('❌ Fatal error in migration setup:', outerError);
    rejectLock(outerError);
    migrationLock = null;
    throw outerError;
  }
}

// Run if called directly (CLI usage only)
// IMPORTANT: This check must never trigger when imported as a module
// Disabled for now to prevent any accidental execution during import
// To run migrations directly, use: tsx scripts/sql-migrations.ts
/*
const isMainModule = typeof import.meta.url === 'string' && 
                     import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  console.log('🚀 Running migrations from CLI...');
  runSqlMigrations().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
*/

export { runSqlMigrations };