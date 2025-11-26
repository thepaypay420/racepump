# Production Deployment Checklist

## Critical: Persistence Setup

Without this, **receipts, leaderboard, and referrals will reset on every redeploy!**

### Step 1: Create Neon Postgres Database (5 minutes)

1. Go to https://neon.tech
2. Sign up (free tier is fine)
3. Create new project
4. Copy the connection string from dashboard
   - Format: `postgres://user:password@ep-xxx-yyy.neon.tech/dbname?sslmode=require`

### Step 2: Configure Replit (2 minutes)

1. Open your Repl
2. Click Secrets (lock icon) in left sidebar
3. Add new secret:
   - **Key**: `DATABASE_URL`
   - **Value**: Paste your Neon connection string
4. Replit will auto-redeploy

### Step 3: Verify (1 minute)

Run this command (replace with your app URL):
```bash
curl https://your-app.repl.co/api/persistence
```

**Expected** (healthy):
```json
{
  "status": "healthy",
  "backend": "postgres",
  "persistent": true
}
```

**Problem** (not configured):
```json
{
  "status": "warning",
  "backend": "sqlite-only",
  "persistent": false,
  "warning": "Postgres not configured - data will reset on redeploy"
}
```

If you see the warning, DATABASE_URL is not set correctly. Check Replit Secrets.

## What Gets Persisted

With DATABASE_URL configured:

✅ All receipts (payouts, rake, jackpot transfers)  
✅ Complete leaderboard (stats, results, rankings)  
✅ All referrals (codes, attributions, rewards)  
✅ Recent winners history  

Without DATABASE_URL:

❌ All data resets on redeploy  
⚠️ Race mechanics still work, but no history  

## Post-Deployment Verification

After setting DATABASE_URL and redeploying, check:

### 1. Check persistence endpoint
```bash
curl https://your-app.repl.co/api/persistence | jq
```

Should show `"persistent": true`

### 2. Check startup logs

Look for these messages in Replit logs:
```
✅ Postgres initialized and ready
📊 Persistence enabled: Receipts, leaderboard, and referrals will survive redeploys
🪄 Hydrated X recent winners from Postgres
🪄 Hydrated X user race results from Postgres
```

### 3. Test persistence

1. Note current leaderboard: `curl https://your-app.repl.co/api/leaderboard`
2. Redeploy (no code changes)
3. Check leaderboard again - should be identical

## Warning Signs

If you see these in logs, persistence is NOT working:

```
❌ CRITICAL: DATABASE_URL is REQUIRED for production persistence!
⚠️ Postgres not ready - bet not persisted to durable storage
⚠️ No DATABASE_URL or PG* env provided; skipping Postgres init
```

**Fix**: Set DATABASE_URL in Replit Secrets (see Step 2 above)

## Optional: Additional Secrets

While setting up secrets, you may also want to set:

- `ADMIN_TOKEN` - For admin panel access (required)
- `RPC_URL` - Custom Solana RPC (optional, defaults to public mainnet)
- `RACE_MINT` - RACE token address (optional, auto-detected)
- `LOG_LEVEL` - Logging level (optional, defaults to 'info')

See `.env.production.example` for full list.

## Support

If persistence verification fails:

1. **Check secret name**: Must be exactly `DATABASE_URL` (case-sensitive)
2. **Check format**: Must end with `?sslmode=require`
3. **Check Neon status**: Visit Neon dashboard, project may be paused (free tier)
4. **Check logs**: Look for Postgres connection errors on startup

Full troubleshooting guide: See `PERSISTENCE_SETUP.md`

## Quick Reference

| Check | Command |
|-------|---------|
| Persistence status | `curl https://app/api/persistence` |
| Health check | `curl https://app/api/health` |
| Leaderboard | `curl https://app/api/leaderboard` |
| Admin diagnostics | `curl -H "Authorization: Bearer TOKEN" https://app/api/admin/db-diagnostics` |

## Deployment is Complete When...

- [ ] `/api/persistence` shows `"persistent": true`
- [ ] Startup logs show Postgres initialization success
- [ ] Startup logs show data hydration from Postgres
- [ ] No Postgres warnings in logs
- [ ] Test redeploy preserves leaderboard data
- [ ] App is accessible at production URL

## Rollback

If issues arise, you can temporarily disable Postgres:

1. Remove `DATABASE_URL` from Replit Secrets
2. Redeploy
3. App runs with SQLite only (ephemeral)
4. Race mechanics work, but data resets on redeploy

Not recommended for production, but safe for troubleshooting.
