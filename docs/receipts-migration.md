# Receipts + Leaderboard Migration (SQLite → Neon Postgres)

Follow this safe, idempotent process to persist data and switch production to Postgres.

Prereqs:
- Ensure envs at deploy time: `DB_PATH=/data/pump-racers.db`, `BACKUP_DIR=/data/backups`, `DATABASE_URL`.

Run order:

1) Backup the current SQLite database

```bash
npm run backup:sqlite
```

2) Migrate selected tables from SQLite → Postgres

```bash
MIGRATE_TABLES=receipts,recent_receipts,leaderboard npm run migrate:sqlite-to-pg
```

Notes:
- If `MIGRATE_TABLES` is not set, defaults to `receipts,recent_receipts,leaderboard`.
- The script introspects schema from SQLite (PRAGMA table_info) and creates Postgres tables when missing.
- Data is copied in chunks (1000 rows) with `ON CONFLICT DO NOTHING` so it is safe to re-run.

3) Switch production to use Postgres for receipts and leaderboard

Set the feature flag and redeploy:

```bash
# Production env
RECEIPTS_BACKEND=postgres
```

On boot you should see logs:
- `📁 Using persistent SQLite path: /data/pump-racers.db`
- `Using Postgres for receipts/leaderboard`
