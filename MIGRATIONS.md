# Safe Database Migrations Guide

This project now uses **explicit, additive migrations** to prevent data loss in production deployments.

## ⛔ What Changed

**BEFORE (DANGEROUS):**
- `drizzle-kit push` would automatically sync schema
- Could DROP tables/columns without warning
- Production data lost on deploy

**AFTER (SAFE):**
- Explicit migration files that are reviewed before deploy
- Automatic blocking of destructive operations
- Migration tracking to prevent re-running
- Production data persists across deploys

## 🚀 Quick Start

### Running Migrations in Production

Migrations run automatically on server startup when `NODE_ENV=production`:

```bash
npm start  # Migrations run automatically
```

### Checking Migrations Before Deploy

```bash
npm run db:check  # Scan for destructive operations
```

This will **BLOCK deployment** if any migrations contain:
- `DROP TABLE`
- `DROP COLUMN`
- `TRUNCATE`
- `DELETE FROM` critical tables

### Creating a New Migration

1. **Edit your schema** in `shared/schema.ts` (if using Drizzle schema)

2. **Generate migration**:
```bash
npm run db:generate
```

3. **Review the migration file** in `drizzle/`:
   - Check for any DROP operations
   - Ensure it's additive only
   - Test locally first

4. **Commit the migration**:
```bash
git add drizzle/
git commit -m "Add migration: add new column"
```

5. **Deploy** - migration runs automatically

## 📁 Migration Files

Migrations are stored in `drizzle/` directory:

```
drizzle/
├── 0000_baseline.sql          # Initial schema
├── 0001_add_column.sql        # Example: add column
├── meta/
│   ├── _journal.json          # Migration registry
│   └── 0000_snapshot.json     # Schema snapshots
```

## 🛡️ Safety Features

### 1. Destructive Operation Detection

The deploy guard automatically scans for:
- Table drops
- Column drops
- Data deletions
- Truncations

### 2. Migration Tracking

Migrations are tracked in `drizzle_migrations` table:
```sql
SELECT * FROM drizzle_migrations ORDER BY created_at DESC;
```

### 3. Production Guards in Code

Several functions are blocked in production:
- `sqliteDb.clearRaces()` - requires `ALLOW_RESET=1`
- `handleClearRaces()` - blocked by default
- `handleResetRaceMint()` - requires confirmation

## 🔧 Development Workflow

### Adding a New Column

1. Create migration file `drizzle/0001_add_user_avatar.sql`:
```sql
-- Add avatar URL column to user_stats
ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS avatar_url TEXT;
```

2. Test locally:
```bash
npm run db:migrate
```

3. Verify:
```bash
npm run db:check  # Should pass
```

4. Commit and deploy

### Adding a New Index

```sql
-- Migration: 0002_add_performance_index.sql
CREATE INDEX IF NOT EXISTS idx_bets_wallet_ts 
ON bets(wallet, ts DESC);
```

### Adding a New Table

```sql
-- Migration: 0003_add_notifications.sql
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
```

## ⚠️ Emergency Overrides

**WARNING: Use these ONLY in emergencies and NEVER in production**

### Allow Destructive Migrations

```bash
ALLOW_DESTRUCTIVE_MIGRATIONS=1 npm run db:migrate
```

### Allow Destructive Code Operations

```bash
ALLOW_RESET=1 npm start
```

## 📊 Monitoring

### Check Applied Migrations

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-app.com/api/admin/db-diagnostics
```

Response includes:
- `postgres.migrations_applied` - count of applied migrations
- `postgres.last_migration` - hash and timestamp of last migration
- Database counts for all tables

### Health Check (No Auth Required)

```bash
curl https://your-app.com/api/health
```

## 🚨 Troubleshooting

### Migration Failed to Apply

1. Check server logs for SQL errors
2. Verify database connectivity
3. Check if migration was already partially applied
4. Fix the SQL and retry

### Data Missing After Deploy

1. Check diagnostics endpoint - are counts correct?
2. Verify DATABASE_URL is set correctly
3. Check if Postgres tables were created
4. Review migration logs

### "Destructive migration detected" Error

This is INTENTIONAL protection. Options:

1. **Recommended**: Rewrite migration to be additive
2. **Not recommended**: Set `ALLOW_DESTRUCTIVE_MIGRATIONS=1` (only for dev)

## 📝 Best Practices

### DO ✅
- Always use `IF NOT EXISTS` for CREATE
- Always use `IF EXISTS` for DROP (but avoid DROP!)
- Use `ALTER TABLE ADD COLUMN IF NOT EXISTS`
- Test migrations locally first
- Review migration files before committing
- Use migrations for schema changes only

### DON'T ❌
- Never DROP tables in production
- Never DROP columns (mark as deprecated instead)
- Never TRUNCATE data
- Never DELETE FROM production tables
- Never skip migration review
- Never commit untested migrations

## 🔄 Migration Workflow Diagram

```
┌─────────────────────────────────────────────────────┐
│ 1. Developer makes schema change                    │
│    → Edit schema.ts or write raw SQL                │
└────────────────┬────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────┐
│ 2. Generate migration                               │
│    → npm run db:generate                            │
│    → Review drizzle/*.sql                           │
└────────────────┬────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────┐
│ 3. Test locally                                     │
│    → npm run db:migrate                             │
│    → Verify changes                                 │
└────────────────┬────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────┐
│ 4. Check for destructive ops                       │
│    → npm run db:check                               │
│    → Abort if detected                              │
└────────────────┬────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────┐
│ 5. Commit migration                                 │
│    → git add drizzle/                               │
│    → git commit                                     │
└────────────────┬────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────┐
│ 6. Deploy to production                            │
│    → CI/CD runs db:check                           │
│    → Server startup runs migrations                │
│    → Data persists safely                          │
└─────────────────────────────────────────────────────┘
```

## 📧 Support

If you encounter issues with migrations:

1. Check this documentation first
2. Review server logs for errors
3. Check `/api/admin/db-diagnostics` endpoint
4. Open an issue with migration details

---

**Remember: Migrations are one-way operations. Always test before deploying to production!**
