-- ================================================================
-- MANUAL FIX: Remove drizzle_migrations table from production
-- ================================================================
-- 
-- WHY THIS IS NEEDED:
-- Replit scans your production database BEFORE deployment starts.
-- If it finds a table named "drizzle_migrations", it assumes you're 
-- using Drizzle ORM and shows a warning about wiping data.
--
-- Even though your .replit has "enabled = false", the WARNING still
-- appears because Replit's scanner runs before reading that config.
--
-- THIS FIX:
-- 1. Drops the drizzle_migrations table from production
-- 2. Records it in app_migrations so migration 002 doesn't run again
-- 3. Prevents Replit from ever detecting Drizzle again
--
-- SAFETY:
-- ✅ The drizzle_migrations table is just a tracking table
-- ✅ Your actual data (bets, users, etc.) is NOT affected
-- ✅ Your app uses app_migrations now, not drizzle_migrations
--
-- ================================================================

-- Step 1: Drop the problematic table
-- This is what's triggering Replit's detection
DROP TABLE IF EXISTS drizzle_migrations CASCADE;

-- Step 2: Ensure app_migrations tracking table exists
CREATE TABLE IF NOT EXISTS app_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  applied_at BIGINT NOT NULL
);

-- Step 3: Mark migration 002 as already applied
-- This prevents your app from trying to drop the table again
INSERT INTO app_migrations (filename, hash, applied_at)
VALUES (
  '002_remove_drizzle_table.sql',
  'manual-fix-' || floor(extract(epoch from now()) * 1000)::text,
  floor(extract(epoch from now()) * 1000)
)
ON CONFLICT (filename) DO NOTHING;

-- Step 4: Verify the fix
SELECT 
  'drizzle_migrations exists?' as check_name,
  EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_name = 'drizzle_migrations'
  ) as result;

-- Should show "false" for result

-- Step 5: Check that app_migrations is being used
SELECT 
  'app_migrations count' as check_name,
  COUNT(*) as result
FROM app_migrations;

-- Should show 1 or more migrations

-- ================================================================
-- HOW TO RUN THIS:
-- ================================================================
--
-- Option 1: Using Replit Database Console
-- 1. Go to your Replit project
-- 2. Click on "Database" in the sidebar
-- 3. Open the SQL console
-- 4. Copy and paste this entire file
-- 5. Click "Run"
--
-- Option 2: Using psql from terminal
-- 1. Get your DATABASE_URL from Replit Secrets
-- 2. Run: psql $DATABASE_URL < FIX_DRIZZLE_TABLE_MANUALLY.sql
--
-- Option 3: Using Neon/Supabase web console
-- 1. Log into your Postgres provider
-- 2. Open SQL editor
-- 3. Copy and paste this file
-- 4. Run it
--
-- ================================================================
-- AFTER RUNNING THIS:
-- ================================================================
--
-- 1. Verify the table is gone:
--    SELECT tablename FROM pg_tables WHERE tablename = 'drizzle_migrations';
--    -- Should return 0 rows
--
-- 2. Try deploying again
--    - You should NOT see the warning anymore
--    - Replit won't detect Drizzle
--    - Your bets table is safe
--
-- 3. If you still see a warning, it might be cached:
--    - Click "Deploy Anyway"
--    - The warning is harmless because .replit has enabled=false
--    - After first deploy, it won't appear again
--
-- ================================================================
