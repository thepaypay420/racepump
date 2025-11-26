# Persistence Setup Guide

## Overview

This application uses a **dual-storage architecture** for optimal performance and durability:
- **SQLite** - Fast local cache (ephemeral on Replit deploys)
- **Postgres (Neon)** - Durable persistent storage

## What Gets Persisted

The following data **requires** Postgres to persist across redeploys:

1. **Receipts** - All settlement transfers (payouts, rake, jackpot)
2. **Leaderboard** - User stats and race results
3. **Referrals** - Referral codes, attributions, and rewards

Without Postgres, this data will **reset on every redeploy**.

Race mechanics (escrow, winners, etc.) continue to work with SQLite only, but historical data is lost.

## Setup Instructions

### 1. Create a Neon Postgres Database (Free)

1. Sign up at https://neon.tech (free tier is sufficient)
2. Create a new project
3. Copy the connection string from the dashboard
   - It looks like: `postgres://user:password@ep-xxx-yyy.neon.tech/dbname?sslmode=require`

### 2. Configure on Replit

1. Open your Repl
2. Go to **Secrets** (lock icon in left sidebar)
3. Add a new secret:
   - Key: `DATABASE_URL`
   - Value: Paste your Neon connection string
4. Redeploy your app

### 3. Verify Setup

After redeploying, check the persistence status:

```bash
curl https://your-app.repl.co/api/persistence
```

You should see:
```json
{
  "status": "healthy",
  "backend": "postgres",
  "persistent": true,
  "postgres": {
    "ready": true,
    "configured": true,
    "receipts": 0,
    "leaderboard_stats": 0,
    "leaderboard_results": 0
  }
}
```

If you see `"status": "warning"` or `"persistent": false`, check:
1. DATABASE_URL is set correctly in Replit Secrets
2. Connection string includes `?sslmode=require`
3. Check logs for connection errors: Look for "❌ Postgres connection failed"

## How It Works

### On Startup

1. App connects to Postgres using `DATABASE_URL`
2. Creates tables if they don't exist (safe, idempotent)
3. **Hydrates** SQLite cache from Postgres:
   - Recent winners
   - User stats
   - Receipts/transfers
   - Referrals

### During Operation

- All writes go to **both** SQLite (fast) and Postgres (durable)
- Reads come from SQLite (fast cache)
- If Postgres write fails, warning is logged but app continues

### On Redeploy

1. SQLite cache is wiped (ephemeral storage)
2. App reconnects to Postgres
3. Hydrates fresh SQLite cache from durable Postgres data
4. **No data loss** - all receipts, stats, referrals are intact

## Troubleshooting

### "Postgres not configured" warning

**Symptom**: `/api/persistence` shows `"persistent": false`

**Fix**: 
1. Check DATABASE_URL is set in Replit Secrets
2. Ensure it's in the correct format
3. Test connection: `psql "your-connection-string" -c "SELECT 1"`

### Connection timeouts

**Symptom**: Logs show "❌ Postgres connection failed"

**Fix**:
1. Verify Neon project is not paused (free tier auto-pauses after 7 days inactivity)
2. Wake up project by visiting Neon dashboard
3. Check firewall/network restrictions

### Data not persisting after redeploy

**Symptom**: Leaderboard resets, receipts gone

**Causes**:
1. DATABASE_URL not set → Using SQLite only (ephemeral)
2. Postgres writes failing silently → Check logs for "⚠️ Postgres not ready"
3. Hydration failing on startup → Check startup logs for "🪄 Hydrated"

**Fix**:
1. Verify `/api/persistence` shows `"persistent": true`
2. Check startup logs for successful hydration messages
3. Monitor logs for Postgres write warnings

### Partial data after redeploy

**Symptom**: Some data persists, some doesn't

**Likely Cause**: DATABASE_URL was added mid-deployment

**Fix**:
- Old data (before DATABASE_URL) was lost
- New data (after DATABASE_URL) persists correctly
- This is expected - only data written after Postgres setup persists

## Local Development

For local dev, you can use SQLite only:
1. Don't set DATABASE_URL
2. Set `DB_PATH=./dev.db` for persistent local cache
3. Data persists locally but won't survive Replit redeploys

## Production Best Practices

1. **Always set DATABASE_URL** in production
2. **Monitor** `/api/persistence` endpoint after deploys
3. **Check logs** for Postgres write warnings
4. **Backup** Neon database periodically (Neon has built-in backups on paid tiers)

## Schema

Tables are created automatically on first connection. No manual migration needed.

Key tables:
- `bets` - All race bets
- `user_race_results` - Per-user, per-race outcomes
- `user_stats` - Aggregated leaderboard stats
- `recent_winners` - Last 6 winning races
- `settlement_transfers` - All payouts/receipts
- `referral_*` - Referral system data

## Cost

**Neon Free Tier** is sufficient for most use cases:
- 3 GB storage
- 10 GB data transfer/month
- Auto-pause after 7 days inactivity

For high traffic, upgrade to Neon Pro ($20/mo) for:
- No auto-pause
- More storage
- Better performance

## Support

If persistence issues persist after following this guide:
1. Check `/api/persistence` output
2. Review startup logs for Postgres connection/hydration
3. Verify DATABASE_URL format
4. Test connection directly with `psql`
