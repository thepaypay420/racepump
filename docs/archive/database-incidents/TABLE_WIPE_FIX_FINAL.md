# Table Wipe Fix - Final Solution

## Problem Summary
Despite multiple previous fixes, the bets table and leaderboard were still being wiped on every redeploy. The issue was that **Replit's deployment system was ignoring migration settings and automatically running Drizzle schema comparisons**.

## Root Cause
Replit's deployment system has hardcoded detection that:
1. Scans for `drizzle-kit` in ANY dependencies (including devDependencies)
2. Looks for ANY file matching `drizzle*.config.*` pattern
3. Automatically runs schema comparison against production database
4. Shows warnings and generates destructive migrations even when `[deployment.databaseMigrations] enabled = false`

## The Fix Applied

### 1. Removed Drizzle from Package Dependencies
- Removed `drizzle-kit` from `devDependencies` in `package.json`
- Disabled `db:generate` command to prevent accidental usage

### 2. Hid Drizzle Configuration Files
- Moved `drizzle.config.local.ts` to `.config/drizzle.config.local.ts`
- Moved `server/db/schema-drizzle.ts` to `.config/schema-drizzle.ts`
- Updated config file to point to new schema location

### 3. Updated .replit Configuration
- Added `.config` and `drizzle-migrations` to hidden files
- This prevents Replit from detecting Drizzle files

### 4. Fixed Migration Runner Dependencies
- Added `dotenv` dependency to `package.json`
- Fixed import path in migration runner

## Files Changed
- `package.json` - Removed drizzle-kit, added dotenv, disabled db:generate
- `.replit` - Added .config and drizzle-migrations to hidden files
- `.config/drizzle.config.local.ts` - Moved from root, updated schema path
- `.config/schema-drizzle.ts` - Moved from server/db/
- `test-migration-fix.sh` - Created test script to verify fix

## How It Works Now

1. **Replit can't detect Drizzle**: No drizzle-kit in dependencies, no drizzle config files in root
2. **Migrations run safely**: Your custom migration runner handles schema creation
3. **No destructive operations**: Migration runner blocks DROP/TRUNCATE/DELETE operations
4. **Data preserved**: Tables are created with `IF NOT EXISTS` and `DO` blocks

## Verification

Run the test script to verify the fix:
```bash
./test-migration-fix.sh
```

## Next Steps

1. **Commit these changes**:
   ```bash
   git add .
   git commit -m "Fix: Hide Drizzle from Replit detection to prevent table wiping"
   git push
   ```

2. **Deploy to production** and verify that:
   - No more "Warning, this migration may permanently remove data" messages
   - Bets table and leaderboard data persist across redeploys
   - Migration runner logs show "✅ Production migrations complete"

3. **Monitor the deployment** for any remaining issues

## Why This Fix Works

- **Replit can't find Drizzle**: No drizzle-kit package or config files to detect
- **Your migrations are safe**: Custom runner with proper guards against destructive operations
- **Schema is preserved**: Tables created with idempotent SQL that won't drop existing data
- **No more auto-migrations**: Replit won't run its own schema comparison

This should completely resolve the table wiping issue that was causing data loss on every redeploy.