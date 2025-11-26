# Postgres-Only Mode Status

## Changes Made

### 1. Fixed FORCE_PG Environment Variable Detection
**File**: `server/db.ts`

Changed from:
```typescript
const forcePg = process.env.FORCE_PG === 'true';
```

To:
```typescript
const forcePg = process.env.FORCE_PG === 'true' || process.env.FORCE_PG === '1';
```

This fixes the issue where `FORCE_PG=1` wasn't being recognized.

### 2. Disabled SQLite in Production Mode
**File**: `server/db.ts`

- Production mode now returns `db = null` (no SQLite initialization)
- SQLite tables are NOT created in production
- `sqliteDb` export is set to a stub object in production that throws helpful error messages

### 3. Removed SQLite Hydration Logic
Removed the complex hydration logic that was trying to populate SQLite from Postgres on startup, since SQLite is not used in production.

### 4. Updated Diagnostics
Fixed `getDbDiagnostics()` to handle null `db` in production mode.

## Current State

✅ **Fixed**: The startup crash where SQLiteStorage tried to call `db.prepare()` on null

⚠️ **Warning**: The application will now throw errors if routes try to use `sqliteDb` methods in production

## Next Steps Required

The application code currently uses `sqliteDb` extensively in routes and business logic:
- `server/routes.ts`
- `server/bets.ts`
- `server/settlement.ts`
- `server/referrals.ts`
- `server/race-state-machine.ts`
- `server/admin.ts`
- etc.

### Option A: Create PostgresStorage Adapter (Recommended)
Create a `PostgresStorage` class that implements the same interface as `SQLiteStorage` but uses Postgres directly. Then export the appropriate storage based on environment:

```typescript
export const sqliteDb = usePostgres 
  ? new PostgresStorage(pgPool) 
  : new SQLiteStorage(db);
```

### Option B: Update All Routes
Update all routes to check if in production mode and use `pgPool` directly instead of `sqliteDb`.

### Option C: Make SQLiteStorage Delegate to Postgres
Modify the existing `SQLiteStorage` class to check `usePostgres` and delegate to Postgres methods when in production mode.

## Testing

To test the current fix, the application should now:
1. ✅ Start without crashing
2. ✅ Recognize `FORCE_PG=1` correctly
3. ✅ Skip SQLite initialization in production
4. ✅ Initialize Postgres successfully
5. ⚠️ Throw clear error messages if code tries to use sqliteDb methods in production

## Environment Variables

Make sure these are set for production:
- `NODE_ENV=production` OR `FORCE_PG=1` (or `FORCE_PG=true`)
- `DATABASE_URL=postgres://...` (your Postgres connection string)
