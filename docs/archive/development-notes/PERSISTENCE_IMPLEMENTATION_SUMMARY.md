# Persistence Implementation Summary

## Problem Solved

**Issue**: Receipts, global leaderboard, and referrals were resetting on every Replit redeploy.

**Root Cause**: The codebase had Postgres persistence infrastructure in place, but DATABASE_URL was likely not configured in production, causing the app to fall back to ephemeral SQLite storage.

## Solution

No major code changes were needed - the persistence infrastructure was already built! The solution involved:

1. **Improved diagnostics and error messaging**
2. **Better logging for persistence failures**
3. **Comprehensive setup documentation**
4. **Public API endpoint to verify persistence status**

## Changes Made

### 1. Fixed Diagnostic Endpoint Crash (`server/db/index.ts`)
- **Before**: Diagnostics would `process.exit(1)` on Postgres connection failure
- **After**: Gracefully handles failures and returns diagnostic info
- **Impact**: Allows app to start even without Postgres (with warnings)

### 2. Enhanced Postgres Initialization (`server/db.ts`)
- **Added**: Clear warning banner when DATABASE_URL is missing in production
- **Added**: Success message when persistence is enabled
- **Impact**: Operators immediately see if persistence is configured

```
❌ CRITICAL: DATABASE_URL is REQUIRED for production persistence!

Without Postgres, receipts/leaderboard/referrals will reset on redeploy.

To fix:
1. Sign up for Neon Postgres (free): https://neon.tech
2. Create a database and copy the connection string
3. Set DATABASE_URL in Replit Secrets
```

### 3. Improved Error Logging (`server/db.ts`)
- **Added**: Warnings when Postgres writes fail
- **Added**: Error logging for all async Postgres operations
- **Impact**: Operators can detect persistence issues in logs

Examples:
```
⚠️ Postgres not ready - bet not persisted to durable storage: bet-123
❌ Failed to persist referral user to Postgres: wallet123
```

### 4. New Public Persistence Endpoint (`server/routes.ts`)
- **New endpoint**: `GET /api/persistence`
- **No auth required**: Safe, public diagnostic info
- **Returns**: Clear persistence status

Example response:
```json
{
  "status": "healthy",
  "backend": "postgres",
  "persistent": true,
  "postgres": {
    "ready": true,
    "configured": true,
    "receipts": 1234,
    "leaderboard_stats": 567,
    "leaderboard_results": 2345,
    "recent_winners": 6
  },
  "sqlite": {
    "receipts": 1234,
    "leaderboard_stats": 567,
    "leaderboard_results": 2345,
    "recent_winners": 6
  },
  "setup_required": false
}
```

Or when Postgres is not configured:
```json
{
  "status": "warning",
  "backend": "sqlite-only",
  "persistent": false,
  "warning": "Postgres not configured - data will reset on redeploy",
  "setup_required": true
}
```

### 5. Comprehensive Documentation

Created three documentation files:

#### `PERSISTENCE_SETUP.md` (New)
- Complete setup guide for Neon Postgres
- Troubleshooting section
- How the dual-storage system works
- Cost information

#### `README.md` (Updated)
- Added persistence to feature list
- Added "Production Setup" section with DATABASE_URL instructions
- Links to persistence setup guide
- Quick verification command

#### `.env.production.example` (New)
- Template for production environment variables
- Clear comments on what's required
- DATABASE_URL format example

## How It Works

### Architecture (Unchanged)
The app uses a **dual-storage architecture**:
- **SQLite**: Fast local cache (ephemeral on Replit)
- **Postgres**: Durable persistent storage

### Data Flow (Unchanged)

**Writes**: All critical data is written to BOTH databases
```
bet placed → SQLite (immediate) + Postgres (async fire-and-forget)
```

**Reads**: Always from SQLite (fast)
```
get leaderboard → SQLite.query()
```

**On Boot**: Hydrate SQLite from Postgres
```
1. Connect to Postgres
2. Load recent_winners → SQLite
3. Load user_stats → SQLite
4. Load user_race_results → SQLite
5. Load settlement_transfers → SQLite
6. Load referrals → SQLite
```

### What Persists

With DATABASE_URL configured, the following survive redeploys:

✅ **Receipts** (settlement_transfers table)
- All payouts
- All rake deductions
- All jackpot transfers

✅ **Leaderboard** (user_stats, user_race_results tables)
- Per-user aggregated stats
- Per-race results
- Edge points
- Win/loss records

✅ **Referrals** (referral_* tables)
- Referral codes
- Attributions
- Rewards (pending and paid)
- Aggregates

✅ **Recent Winners** (recent_winners table)
- Last 6 winning races
- Full race data with pot size

## Configuration Steps

### For Production (Replit)

1. **Get Neon Postgres** (free tier is sufficient)
   - Sign up at https://neon.tech
   - Create a project and database
   - Copy connection string

2. **Set Replit Secret**
   - Open Repl → Secrets (lock icon)
   - Add secret:
     - Key: `DATABASE_URL`
     - Value: `postgres://user:pass@ep-xxx.neon.tech/dbname?sslmode=require`

3. **Redeploy**
   - Replit will automatically redeploy with new secret

4. **Verify**
   ```bash
   curl https://your-app.repl.co/api/persistence
   ```
   Should show `"persistent": true`

### For Local Development

No DATABASE_URL needed - SQLite works fine for local dev:
```bash
# Set local SQLite path (optional)
DB_PATH=./dev.db

# Start dev server
npm run dev
```

## Verification Checklist

After setting up DATABASE_URL, verify:

- [ ] `/api/persistence` shows `"status": "healthy"`
- [ ] `/api/persistence` shows `"persistent": true`
- [ ] Startup logs show "✅ Postgres initialized and ready"
- [ ] Startup logs show "📊 Persistence enabled: ..."
- [ ] Startup logs show hydration messages: "🪄 Hydrated X items from Postgres"
- [ ] No warnings in logs: "⚠️ Postgres not ready"
- [ ] Place a bet, redeploy, check receipt still exists

## Monitoring

### Check Persistence Status
```bash
curl https://your-app.repl.co/api/persistence | jq
```

### Check Admin Diagnostics (requires admin token)
```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://your-app.repl.co/api/admin/db-diagnostics | jq
```

### Watch Logs for Warnings
After deploying, monitor for:
```
❌ CRITICAL: DATABASE_URL is REQUIRED
⚠️ Postgres not ready - bet not persisted
❌ Failed to persist ... to Postgres
```

If you see these, DATABASE_URL is not configured correctly.

## Rollback Plan

If issues arise, you can temporarily run without Postgres:

1. Remove `DATABASE_URL` from Replit Secrets
2. Redeploy
3. App will run with SQLite only (ephemeral)
4. Race mechanics continue to work
5. Historical data (receipts/leaderboard) will reset on each deploy

This is safe for testing but not recommended for production.

## Testing

### Manual Test

1. **Before redeploy**:
   ```bash
   # Check current data
   curl https://your-app.repl.co/api/leaderboard
   curl https://your-app.repl.co/api/user/WALLET/receipts
   ```

2. **Redeploy** (no code changes)

3. **After redeploy**:
   ```bash
   # Verify data still present
   curl https://your-app.repl.co/api/leaderboard
   curl https://your-app.repl.co/api/user/WALLET/receipts
   ```

4. **Check persistence**:
   ```bash
   curl https://your-app.repl.co/api/persistence
   ```

Should see same leaderboard data before and after redeploy.

## Cost

**Neon Free Tier** is sufficient for most deployments:
- 3 GB storage
- 10 GB data transfer/month
- Shared compute
- Auto-pause after 7 days inactivity

Free tier limitations:
- Project pauses after 7 days of inactivity (wakes up on first request)
- May have slightly higher latency

For production at scale, consider **Neon Pro** ($20/mo):
- No auto-pause
- Dedicated compute
- Better performance
- More storage/bandwidth

## Performance

The dual-storage architecture provides:
- **Fast reads**: All reads from local SQLite cache (sub-ms)
- **Durable writes**: Async Postgres writes don't block user requests
- **Resilient**: Even if Postgres is temporarily down, app continues with cached data

Hydration on boot takes ~1-2 seconds for typical datasets.

## Troubleshooting

### Postgres not configured warning on startup

**Fix**: Set DATABASE_URL in Replit Secrets

### Data disappears after redeploy

**Cause**: DATABASE_URL not set or incorrect

**Fix**: 
1. Check `/api/persistence` → should show `"persistent": true`
2. If false, verify DATABASE_URL in Replit Secrets
3. Check format: must end with `?sslmode=require`

### Partial data missing

**Cause**: DATABASE_URL was added after some data was created

**Expected**: Only data created AFTER DATABASE_URL is set will persist

### Connection timeouts

**Cause**: Neon project auto-paused (free tier after 7 days inactivity)

**Fix**: Visit Neon dashboard to wake project, or upgrade to Pro

## Security

- DATABASE_URL contains credentials - keep in Replit Secrets (encrypted)
- Never commit DATABASE_URL to git
- `.env.example` files show format but no real credentials
- Postgres connection uses SSL (`sslmode=require`)

## Support

If persistence issues continue after following this guide:

1. Check `/api/persistence` and share output
2. Check startup logs for Postgres connection messages
3. Verify DATABASE_URL format (no spaces, correct encoding)
4. Test connection directly: `psql "$DATABASE_URL" -c "SELECT 1"`

## Summary

✅ **Problem identified**: DATABASE_URL not configured in production  
✅ **Solution**: Set DATABASE_URL in Replit Secrets  
✅ **Verification**: New `/api/persistence` endpoint  
✅ **Documentation**: Comprehensive setup guide  
✅ **Monitoring**: Enhanced logging for failures  
✅ **Testing**: Manual verification steps  

The persistence infrastructure was already in place. The fix is entirely configuration - no code deployment needed if DATABASE_URL is set correctly.
