# Production Deployment Safety Checklist

## ✅ Pre-Deployment Checklist

Before every production deploy, verify:

### 1. Environment Variables
- [ ] `DATABASE_URL` is set (Neon/Postgres connection string)
- [ ] `ADMIN_TOKEN` is set (never commit this!)
- [ ] `NODE_ENV=production`
- [ ] `RPC_URL` is set (Solana RPC endpoint)

### 2. Database Migrations
- [ ] Run `npm run db:check` to scan for destructive operations
- [ ] Review all new migration files in `drizzle/`
- [ ] Migrations are additive only (no DROP operations)
- [ ] Migrations tested locally

### 3. Data Persistence
- [ ] Postgres is configured and reachable
- [ ] Tables exist (check `/api/admin/db-diagnostics`)
- [ ] Recent data is present in Postgres
- [ ] SQLite is NOT being used for receipts/leaderboard

### 4. Code Safety Guards
- [ ] `ALLOW_RESET` is NOT set (or set to `0`)
- [ ] `ALLOW_DESTRUCTIVE_MIGRATIONS` is NOT set
- [ ] Destructive admin endpoints are blocked

## 🚀 Deployment Commands

### Standard Deployment
```bash
# 1. Build application
npm run build

# 2. Check migrations (automatic in CI)
npm run db:check

# 3. Start server (migrations run automatically)
NODE_ENV=production npm start
```

### Replit Deployment
Migrations run automatically on startup when `NODE_ENV=production`.

Just deploy normally:
```bash
git push origin main
```

## 🛡️ Post-Deployment Verification

After deploy, immediately check:

### 1. Server Health
```bash
curl https://your-app.com/api/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": 1234567890,
  "version": "1.0.0",
  "environment": "production"
}
```

### 2. Database Diagnostics (Admin Only)
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.com/api/admin/db-diagnostics
```

Verify:
- `database_backend: "postgres"` ✅
- `postgres.ready: true` ✅
- `postgres.migrations_applied > 0` ✅
- Table counts > 0 for:
  - `bets_count`
  - `user_stats_count`
  - `settlement_transfers_count`
  - `referrals_count`

### 3. Test Critical Flows
- [ ] Place a bet (check it persists)
- [ ] Check leaderboard (should show data)
- [ ] Check receipts (should show history)
- [ ] Create referral code (should persist)

## 🚨 Emergency Rollback

If deployment causes issues:

### Option 1: Revert Code
```bash
git revert HEAD
git push origin main
```

### Option 2: Emergency Fix
1. Identify the issue (check logs)
2. Fix the code/migration
3. Deploy fix immediately
4. Verify data integrity

### Option 3: Disable Features
```bash
# Set maintenance mode
curl -X POST https://your-app.com/api/admin/maintenance \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": true, "message": "Maintenance in progress"}'
```

## 📊 Monitoring After Deploy

### First 5 Minutes
- [ ] Check server logs for errors
- [ ] Verify `/api/health` responds
- [ ] Check database counts haven't dropped

### First Hour
- [ ] Monitor new bets (should persist)
- [ ] Check leaderboard updates
- [ ] Verify receipts are recording

### First Day
- [ ] Check data consistency
- [ ] Verify no data loss reports
- [ ] Monitor error rates

## ⚠️ Red Flags - STOP and Investigate

Immediately investigate if:
- ❌ Database counts drop to 0
- ❌ "Postgres not ready" errors in logs
- ❌ Bets not persisting
- ❌ Leaderboard shows 0 users
- ❌ Receipts missing
- ❌ "DROP TABLE" in migration output
- ❌ "TRUNCATE" in migration output
- ❌ Users report missing data

## 🔧 Common Issues and Fixes

### Issue: "Postgres not ready"
**Cause**: DATABASE_URL not set or unreachable
**Fix**: 
1. Verify DATABASE_URL is set correctly
2. Check Neon dashboard for connection string
3. Ensure SSL is enabled in connection string

### Issue: "Migration failed"
**Cause**: SQL syntax error or constraint violation
**Fix**:
1. Check server logs for SQL error
2. Fix migration file
3. Redeploy

### Issue: "Bets count is 0"
**Cause**: Wrong database or tables not created
**Fix**:
1. Check `/api/admin/db-diagnostics`
2. Verify `database_backend: "postgres"`
3. Check migrations were applied

### Issue: "Destructive migration detected"
**Cause**: Migration contains DROP/TRUNCATE/DELETE
**Fix**:
1. Review migration file
2. Rewrite to be additive
3. Remove destructive operations
4. Redeploy

## 📝 Deployment Log Template

Keep a log of each deployment:

```
Date: 2025-10-25
Time: 14:30 UTC
Branch: main
Commit: abc123
Deployed by: @username

Pre-deploy checks:
- [x] db:check passed
- [x] Migrations reviewed
- [x] Environment variables verified

Post-deploy verification:
- [x] Health check: OK
- [x] Database: Postgres
- [x] Migrations applied: 1
- [x] Bets count: 1234
- [x] Users count: 56
- [x] Test bet placed: SUCCESS

Issues: None
Rollback required: No
```

## 🎯 Success Criteria

A successful deployment has:
- ✅ Zero data loss
- ✅ All services healthy
- ✅ Migrations applied successfully
- ✅ Data persisting to Postgres
- ✅ No increase in error rates
- ✅ Users can place bets and see history
- ✅ Leaderboard updating correctly

---

**Remember: When in doubt, deploy to a staging environment first!**
