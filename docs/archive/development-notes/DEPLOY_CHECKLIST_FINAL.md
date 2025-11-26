# ✅ Pre-Deploy Checklist - Replit Table Wipe Fix

## 🔍 Pre-Deploy Verification

Run this command before deploying:
```bash
./verify-no-drizzle.sh
```

Expected output:
```
✅ All checks passed! No Drizzle references found.
```

## 📋 What Will Happen on Deploy

### 1. Server Starts
```
🚀 Starting PumpBets server with deployment fixes...
🔄 Initializing database and hydration...
```

### 2. Migrations Run Automatically
```
🔄 Running pure SQL migration runner...
📂 Found 2 SQL migration file(s)

⏭️  Skipping 001_baseline.sql (already applied at 2025-10-26...)
📝 Applying migration: 002_remove_drizzle_table.sql
✅ Applied 002_remove_drizzle_table.sql

✅ Pure SQL migration complete:
   - Applied: 1
   - Skipped: 1
   - Total: 2
```

### 3. Replit Scans Database
```
🔍 Replit: Checking for Drizzle migrations...
❌ No drizzle_migrations table found
❌ No Drizzle packages found
✅ No action needed
```

### 4. Your App Runs Normally
```
✅ Hydration completed, verifying diagnostics...
✅ SQLite hydration from Postgres complete
🏁 Pump Racers server running on port 5000
✅ Server ready to accept connections
```

## 🚫 What Will NOT Happen

❌ **Replit will NOT show this warning:**
> "Your database schema has changed. We need to run migrations that will DROP the bets table."

❌ **Your bets table will NOT be wiped**

❌ **No data loss**

## 🔒 Safety Guarantees

1. **Migration 002 is safe** - Only drops `drizzle_migrations` (tracking table, no user data)
2. **Bets table is untouched** - Uses `CREATE TABLE IF NOT EXISTS` (never drops)
3. **All user data preserved** - No DELETE, TRUNCATE, or DROP operations on data tables
4. **Rollback-safe** - Migration runs in a transaction, rolls back on error

## 📊 Post-Deploy Verification

After deploy, run these queries to verify:

### Check Migration Status
```sql
-- Should show both migrations applied
SELECT * FROM app_migrations ORDER BY applied_at DESC;
```

Expected result:
```
| filename                        | applied_at      |
|---------------------------------|-----------------|
| 002_remove_drizzle_table.sql   | 2025-10-26 ... |
| 001_baseline.sql               | 2025-10-26 ... |
```

### Verify No Drizzle Table
```sql
-- Should return false
SELECT EXISTS (
  SELECT FROM information_schema.tables 
  WHERE table_name = 'drizzle_migrations'
);
```

### Check Bets Table is Intact
```sql
-- Should show your existing bets
SELECT COUNT(*) FROM bets;
```

## 🎯 Success Criteria

- ✅ Server starts without errors
- ✅ Migration 002 applies successfully
- ✅ No Replit migration warnings
- ✅ Bets table has data
- ✅ App functions normally
- ✅ No `drizzle_migrations` table exists

## 🚨 Emergency Rollback

If something goes wrong (unlikely):

1. The migration runs in a transaction - it will auto-rollback on error
2. Your data is safe because we didn't touch any data tables
3. You can manually revert by:
   ```bash
   git revert HEAD
   git push
   ```

## 📝 Files Changed

- ✅ `migrations/001_baseline.sql` - Removed drizzle_migrations creation
- ✅ `migrations/002_remove_drizzle_table.sql` - Added cleanup migration  
- ✅ `scripts/sql-migrations.ts` - Allow dropping drizzle_migrations
- ✅ `verify-no-drizzle.sh` - Added verification script

## 🎉 Ready to Deploy?

If the verification script passes, you're good to go!

```bash
# 1. Verify locally
./verify-no-drizzle.sh

# 2. Commit and push
git add .
git commit -m "fix: remove all Drizzle references to prevent Replit table wipes"
git push

# 3. Deploy on Replit
# Click "Deploy" button or wait for auto-deploy
```

---

**This is a safe deployment. Your data will NOT be lost.** ✅
