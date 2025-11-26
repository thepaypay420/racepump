# PumpBets Deployment Guide

## How Production Database Separation Works

### The Problem You Were Experiencing
When development and production share the same `DATABASE_URL`, any changes in your workspace (development) directly affect live users (production). This causes:
- Lost bets when you test features
- Erased leaderboards when you experiment
- Race history disappearing on redeploy

### The Solution
Replit provides **automatic database separation** when you deploy:

1. **Your Workspace** (Development)
   - Uses the `DATABASE_URL` secret from your workspace Secrets tab
   - This is where you test features, make changes, and experiment
   - Changes here do NOT affect production

2. **Your Published App** (Production)
   - Automatically gets a DIFFERENT `DATABASE_URL` from Replit
   - This database is completely separate and persistent
   - User bets, race results, and leaderboards stay safe across redeployments

## Deployment Checklist

### Before Your First Deploy

- [ ] Verify your workspace has a `DATABASE_URL` secret set (for development)
- [ ] Confirm all migrations in `sql-scripts/` use `CREATE TABLE IF NOT EXISTS`
- [ ] Test the app works in your workspace (development mode)

### When You Deploy

1. **Click the Deploy button** in Replit
2. Replit automatically:
   - Provisions a NEW production database (separate from development)
   - Runs all migrations from `sql-scripts/` on the production database
   - Sets a production-specific `DATABASE_URL` environment variable
   - Starts your app connected to the production database

3. **First deployment**: Tables will be created fresh
4. **Future deployments**: Existing data stays safe, only schema changes are applied

### After Deployment

- [ ] Visit your production URL to verify it works
- [ ] Check that production has its own empty database (first deploy) or preserved data (subsequent deploys)
- [ ] Make test bets in DEVELOPMENT to ensure they don't appear in PRODUCTION

## Migration Timeout Protection

**NEW**: Migrations now have timeout protection to prevent deployment hangs:

- **Overall migration timeout**: 90 seconds
- **Per-query timeout**: 5-45 seconds depending on operation
- **Graceful degradation**: If migrations timeout, the server checks if tables already exist and continues startup
- **Better logging**: Shows exactly which migration file and which step is running

This means your production deployment will **always start**, even if migrations have temporary issues.

## How Database Migrations Work

Your migrations in `sql-scripts/` are designed to be **safe and idempotent**:

```sql
-- ✅ SAFE: Creates table only if it doesn't exist
CREATE TABLE IF NOT EXISTS races (...);

-- ✅ SAFE: Adds column only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name='races' AND column_name='new_field') THEN
    ALTER TABLE races ADD COLUMN new_field TEXT;
  END IF;
END $$;

-- ❌ DANGEROUS: Would destroy data (we don't do this)
-- DROP TABLE races;
-- DELETE FROM bets;
-- TRUNCATE user_stats;
```

### Migration Execution

When your app starts (in any environment):
1. Connects to the appropriate database (dev or prod)
2. Runs `scripts/sql-migrations.ts`
3. Executes each `.sql` file in `sql-scripts/` in order
4. Tracks which migrations ran in the `applied_migrations` table
5. Skips migrations that already ran

## Troubleshooting

### "My production data disappeared!"
**Likely cause**: You're still using the same DATABASE_URL for both environments.

**Fix**: 
1. Delete the `DATABASE_URL` secret from your production deployment
2. Replit will automatically provision a fresh production database
3. Your workspace `DATABASE_URL` stays unchanged

### "Changes in development affect production"
**Cause**: Both environments share the same database.

**Fix**: Follow the steps above to separate the databases.

### "I need to reset production data"
**Warning**: Only do this if absolutely necessary.

1. In the Replit deployment settings, you can reset the production database
2. This will create a fresh database and run all migrations
3. All user data will be lost (bets, race history, leaderboard)

## Best Practices

1. **Never manually set DATABASE_URL in production** - Let Replit handle it
2. **Always test migrations in development first** - Run `npm run db:push` in your workspace
3. **Write additive migrations** - Add columns, don't drop them
4. **Use feature flags** - Hide incomplete features rather than removing code
5. **Keep production migrations safe** - Always use `IF NOT EXISTS` patterns

## Current Migration Files

Your `sql-scripts/` directory contains:
- `001_baseline.sql` - Creates all initial tables
- `002_remove_drizzle_table.sql` - Removes legacy Drizzle tracking table
- `003_disable_rls.sql` - Disables Row Level Security (for admin access)
- `004_add_missing_race_columns.sql` - Adds race-specific columns

All migrations are safe to run multiple times and won't destroy existing data.
