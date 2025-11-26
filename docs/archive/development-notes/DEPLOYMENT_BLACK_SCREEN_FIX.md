# Deployment Black Screen Fix

## Problem
The deployed application at https://racepump.fun/ was experiencing a black screen after briefly flashing. 

### Root Causes Identified:

1. **Backend Error**: Missing database tables
   - Error: `relation "treasury" does not exist`
   - The PostgreSQL migration file `001_baseline.sql` was incomplete
   - Missing critical tables: `races`, `predictions`, `claims`, `seen_tx`, and `treasury`

2. **Frontend Error**: Type safety issues
   - Error: `TypeError: (s || []).filter is not a function`
   - The frontend was not properly handling cases where API responses might fail or return unexpected data
   - When the backend failed to initialize, API calls returned errors, but the frontend tried to process them as arrays

## Solutions Implemented

### 1. Fixed PostgreSQL Migration Schema

**File**: `sql-scripts/001_baseline.sql`

Added missing core tables to the baseline migration:

- **`races`** table - Stores race information (id, status, timestamps, winner info, runners)
- **`predictions`** table - Legacy predictions storage
- **`claims`** table - Claim transactions
- **`seen_tx`** table - Transaction deduplication
- **`treasury`** table - Application state (jackpot balances, maintenance mode, race mint)

All tables are wrapped in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` blocks to make them idempotent and safe for concurrent deployments.

The treasury table includes:
```sql
CREATE TABLE IF NOT EXISTS treasury (
  state TEXT PRIMARY KEY DEFAULT 'main',
  jackpot_balance NUMERIC NOT NULL DEFAULT 0,
  jackpot_balance_sol NUMERIC NOT NULL DEFAULT 0,
  race_mint TEXT,
  maintenance_mode INTEGER NOT NULL DEFAULT 0,
  maintenance_message TEXT,
  maintenance_anchor_race_id TEXT
);
```

### 2. Added Frontend Type Safety

**File**: `client/src/pages/Lobby.tsx`

Added explicit `Array.isArray()` checks to prevent `.filter()` being called on non-array values:

```typescript
// Before:
const sortedRaces = races?.sort(...) || [];
const settledRaces = (recentWinners || []).filter(...);

// After:
const sortedRaces = Array.isArray(races) ? races.sort(...) : [];
const settledRaces = (Array.isArray(recentWinners) ? recentWinners : []).filter(...);
```

This ensures that even if the API returns unexpected data (due to backend errors), the frontend won't crash.

## How Migrations Work

The application uses a pure SQL migration system (no Drizzle ORM):

1. **Migration files** are stored in `/workspace/sql-scripts/` (renamed from "migrations" to avoid Replit auto-detection)
2. **Migration runner** is at `/workspace/scripts/sql-migrations.ts`
3. **Tracking table** is `app_migrations` (NOT `drizzle_migrations`)
4. **Execution**: 
   - Migrations run automatically on server startup when `initPostgres()` is called
   - See `server/db.ts` line 171: `await runProductionMigrations(pgPool);`
   - Each migration is tracked by filename and hash to prevent re-running
   - All migrations run in transactions for safety

## Expected Behavior After Fix

1. **Server startup**:
   - ✅ Connects to PostgreSQL database
   - ✅ Runs migrations to create all required tables
   - ✅ Successfully initializes application
   - ✅ Serves API endpoints without errors

2. **Frontend loading**:
   - ✅ Connects to wallet
   - ✅ Fetches races from `/api/races` successfully
   - ✅ Displays lobby with races, leaderboard, and recent winners
   - ✅ No console errors about `.filter is not a function`

## Testing the Fix

After deploying these changes:

1. Check deployment logs for:
   ```
   ✅ Postgres connection verified
   🔄 Running migrations to initialize schema...
   ✅ Applied 001_baseline.sql
   ✅ Pure SQL migration complete
   ✅ Postgres initialized and ready
   ```

2. Check browser console - should see:
   ```
   ✅ Wallet connected: [address]
   Audio system initialized
   ```
   (No TypeError about filter function)

3. The application should load fully and display the lobby with available races

## Files Modified

1. `/workspace/sql-scripts/001_baseline.sql` - Added missing tables
2. `/workspace/client/src/pages/Lobby.tsx` - Added array type safety checks

## Related Documentation

- Migration system: `/workspace/scripts/sql-migrations.ts`
- Database initialization: `/workspace/server/db.ts` (lines 45-191)
- API routes: `/workspace/server/routes.ts`
