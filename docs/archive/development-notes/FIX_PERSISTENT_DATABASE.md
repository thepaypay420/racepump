# Database Persistence Fix

## Issue
Your SQLite database was being stored in a non-persistent location (`/home/runner/workspace/data/`) which gets wiped on every Replit redeploy, causing receipts and leaderboard data to disappear.

## Root Causes Found

1. **Non-persistent database path**: SQLite was stored in ephemeral location
2. **API requests before hydration**: Endpoints served requests before Postgres hydration completed
3. **Missing on-demand hydration**: Limited fallback to Postgres when SQLite was empty

## Fixes Applied

### 1. Added Hydration Wait in Routes
The API endpoints now wait for database hydration to complete before serving requests:

```typescript
// CRITICAL: Wait for hydration to complete before serving data requests
await hydrationPromise;
```

### 2. Enhanced On-Demand Hydration
Both `/api/user/:wallet/receipts` and `/api/leaderboard` endpoints now:
- Check if SQLite has data
- If empty, immediately query Postgres
- Hydrate data into SQLite for future requests
- Return data from Postgres if available

### 3. Better Logging
Added detailed logging to track:
- When SQLite is empty
- When Postgres is queried
- How many records are hydrated
- Where data is being served from

## CRITICAL: Set Environment Variable

To ensure the database persists across redeploys, you **MUST** set the `DB_PATH` environment variable in Replit:

### Steps:

1. **Open Replit Secrets/Environment Variables**:
   - Click on "Tools" → "Secrets" in your Replit sidebar
   - OR go to your deployment settings

2. **Add/Update the following variable**:
   ```
   DB_PATH=/mnt/data/pump-racers.db
   ```

3. **Verify DATABASE_URL is set**:
   Make sure your Postgres connection string is also set:
   ```
   DATABASE_URL=postgres://user:password@your-neon-host.neon.tech/dbname?sslmode=require
   ```

4. **Redeploy your application**:
   After setting the environment variable, redeploy your app.

### How to Verify It's Working

After redeploying, check the startup logs. You should see:

✅ **GOOD** (persistent):
```
📁 Database path: /mnt/data/pump-racers.db
```

❌ **BAD** (non-persistent):
```
⚠️ Using non-persistent DB path on Replit: /home/runner/workspace/data/pump-racers.db
```

## What This Fixes

### After these changes:

1. **Database persists across redeploys** - SQLite cache remains intact
2. **Initial requests work correctly** - API waits for hydration before serving
3. **On-demand loading** - If SQLite is empty for a specific user/query, Postgres is checked
4. **Fast subsequent requests** - Data is cached in SQLite after first load
5. **Better visibility** - Detailed logging shows exactly what's happening

### Data Flow:

```
Redeploy Happens
    ↓
Server Starts
    ↓
Postgres Connection Established
    ↓
Hydration Begins (background)
    ↓
Routes Wait for Hydration
    ↓
API Endpoints Ready
    ↓
User Request Arrives
    ↓
Check SQLite First
    ↓
If Empty → Query Postgres → Hydrate SQLite → Return Data
If Found → Return from SQLite (fast)
```

## Testing

Once you've set the environment variable and redeployed:

1. **Check startup logs** for persistent DB path
2. **Visit the leaderboard** - should show full data
3. **Check your receipts** - should show complete history
4. **Redeploy again** - data should still be there!

## Monitoring

Watch for these log messages after redeploy:

- `🪄 Hydrated X recent winners from Postgres`
- `🪄 Hydrated X user race results from Postgres`  
- `🪄 Hydrated X bets from Postgres`
- `✅ Database hydration complete, ready to serve requests`

If you see:
- `🔍 SQLite empty for wallet...` - On-demand hydration is working
- `✅ Loaded X leaderboard entries from Postgres` - Postgres fallback working
