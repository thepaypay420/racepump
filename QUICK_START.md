# Quick Start Guide - Fix "Treasury Does Not Exist" Error

## The Problem

You're seeing this error because the PostgreSQL database is not connected or tables don't exist.

## The Solution (5 Minutes)

### Step 1: Set DATABASE_URL

You need a PostgreSQL connection string. Get one from:
- **Neon** (recommended): https://neon.tech - Free, no credit card
- **Supabase**: https://supabase.com - Free tier available
- **Railway**: https://railway.app - Simple deployment

After creating your database, you'll get a connection string like:
```
postgres://user:password@host.region.neon.tech/dbname?sslmode=require
```

**Add it to Replit Secrets:**
1. Click "Tools" → "Secrets"
2. Add key: `DATABASE_URL`
3. Paste your connection string as value
4. Save

**Or create a `.env` file:**
```bash
DATABASE_URL=postgres://user:pass@host.neon.tech/dbname?sslmode=require
NODE_ENV=production
```

### Step 2: Test Connection

```bash
npm run db:test
```

This will:
- ✅ Verify DATABASE_URL is set
- ✅ Test PostgreSQL connection
- ✅ Check if treasury table exists
- ❌ Tell you exactly what's wrong if it fails

### Step 3: Run Migrations (If Needed)

If the test says "treasury table does NOT exist", run:

```bash
npm run db:migrate
```

This creates all tables:
- treasury (app state, jackpot)
- races (race data)
- bets (user bets)
- user_stats (leaderboard)
- user_race_results (receipts)
- settlement_transfers (payouts)
- And 10+ more tables

### Step 4: Start Server

```bash
npm start           # Production
# or
npm run dev         # Development
```

**The server will:**
1. Connect to PostgreSQL automatically
2. Run migrations if they haven't run yet
3. Initialize treasury table
4. Start racing system
5. Everything works! 🎉

## Why Do We Need Migrations?

When you get a PostgreSQL database from Neon/Supabase, it's **empty**. Migrations create the table structure:

```
Empty PostgreSQL Database
         ↓
   Migrations Run
         ↓
All Tables Created (treasury, races, bets, etc.)
         ↓
   Server Can Start
```

Without migrations, PostgreSQL has no tables, so queries fail with "relation does not exist".

## Do Migrations Run Automatically?

**YES!** Migrations run automatically when the server starts:

```typescript
// server/db.ts - initPostgres() function
1. Connect to PostgreSQL
2. Test connection
3. Run migrations automatically ← THIS CREATES TABLES
4. Server ready
```

## Troubleshooting

### "DATABASE_URL is not set"
→ Add DATABASE_URL to Replit Secrets or .env file

### "Connection failed" or "ENOTFOUND"
→ Check your DATABASE_URL is correct (copy-paste from Neon/Supabase)

### "Treasury does not exist"
→ Run: `npm run db:migrate`

### "Authentication failed"
→ Your DATABASE_URL has wrong username/password - get new string from provider

### "Can't connect to racing server"
→ Run `npm run db:test` to diagnose, then follow the fix it suggests

## Testing the Setup

Run these in order:

```bash
# 1. Check if DATABASE_URL is set and connection works
npm run db:test

# 2. Check all tables and data counts
npm run db:status

# 3. Start the server
npm start
```

If all three work, your system is fully configured! 🚀

## Quick Commands Reference

| Command | What It Does |
|---------|--------------|
| `npm run db:test` | Quick connection test |
| `npm run db:status` | Full database status |
| `npm run db:migrate` | Create tables (run once) |
| `npm start` | Start production server |
| `npm run dev` | Start development server |

## Architecture

```
Your App Server
       ↓
DATABASE_URL (environment variable)
       ↓
PostgreSQL (Neon/Supabase)
       ↓
Tables (created by migrations)
```

**Without DATABASE_URL:** Server can't connect → "treasury does not exist"
**With DATABASE_URL:** Server connects → runs migrations → creates tables → works perfectly

## Still Not Working?

1. Run diagnostic:
```bash
npm run db:test
```

2. Read error message carefully - it tells you exactly what to do

3. Common fixes:
   - No DATABASE_URL? → Set it in Secrets/env
   - Can't connect? → Check DATABASE_URL spelling
   - No tables? → Run `npm run db:migrate`
   - Server won't start? → Check server logs for DATABASE errors

4. Check server logs:
```bash
npm start 2>&1 | grep -i "database\|postgres\|treasury\|migration"
```

## That's It!

Once DATABASE_URL is set and migrations run, everything else works automatically. The entire system is designed to use PostgreSQL in production.
