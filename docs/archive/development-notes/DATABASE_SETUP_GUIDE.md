# PostgreSQL Database Setup Guide

## Critical: Treasury and Database Errors

If you're seeing errors like **"treasury does not exist"** or the racing server can't connect, it means your PostgreSQL database is not properly configured.

## Quick Fix (5 minutes)

### Step 1: Get a PostgreSQL Database

Get a **free** PostgreSQL database from one of these providers:

- **Neon** (Recommended): https://neon.tech
  - Free tier: 500MB storage
  - No credit card required
  - Perfect for production

- **Supabase**: https://supabase.com
  - Free tier: 500MB storage
  - Includes additional features

- **Railway**: https://railway.app
  - Free trial available
  - Simple deployment

### Step 2: Get Your Connection String

After creating your database, you'll get a connection string that looks like:

```
postgres://username:password@host.region.provider.tech/dbname?sslmode=require
```

**Example (Neon):**
```
postgres://myuser:abc123password@ep-cool-sunset-123456.us-east-2.aws.neon.tech/mydb?sslmode=require
```

### Step 3: Set DATABASE_URL

Choose one of these methods:

#### Option A: Replit Secrets (Recommended for Replit)

1. Open your Repl
2. Click "Tools" in the left sidebar
3. Click "Secrets"
4. Click "New Secret"
5. Key: `DATABASE_URL`
6. Value: Paste your connection string
7. Click "Add Secret"

#### Option B: .env File (Local Development)

Create a file named `.env` in the project root:

```bash
DATABASE_URL=postgres://username:password@host.neon.tech/dbname?sslmode=require
NODE_ENV=production
```

#### Option C: Environment Variable (Linux/Mac)

```bash
export DATABASE_URL="postgres://username:password@host.neon.tech/dbname?sslmode=require"
```

### Step 4: Verify Setup

Run the database status checker:

```bash
npm run db:status
```

This will:
- ✅ Verify DATABASE_URL is set
- ✅ Test connection to PostgreSQL
- ✅ Check all required tables exist
- ✅ Show current data counts

If tables are missing, it will tell you to run migrations.

### Step 5: Run Migrations

If tables don't exist, run:

```bash
npm run db:migrate
```

This creates all required tables including:
- `treasury` (app state and jackpot)
- `races` (race data)
- `bets` (user bets)
- `user_stats` (leaderboard)
- `user_race_results` (receipts)
- `settlement_transfers` (payouts)
- And more...

### Step 6: Start the Server

```bash
npm start           # Production
npm run dev         # Development
```

The server will:
1. Connect to PostgreSQL automatically
2. Run migrations if needed
3. Initialize the treasury table
4. Start the racing system

## Troubleshooting

### Error: "treasury does not exist"

**Cause:** Migrations haven't run yet.

**Fix:**
```bash
npm run db:migrate
```

### Error: "DATABASE_URL is not set"

**Cause:** Environment variable not configured.

**Fix:** Follow Step 3 above to set DATABASE_URL.

### Error: "Connection failed" or "ENOTFOUND"

**Cause:** Invalid connection string or network issue.

**Fix:**
1. Double-check your DATABASE_URL
2. Make sure it includes `?sslmode=require`
3. Verify your database is running
4. Check your network/firewall

### Error: "Authentication failed" (28P01)

**Cause:** Wrong username or password.

**Fix:**
1. Get a new connection string from your database provider
2. Update DATABASE_URL with the correct credentials

### Error: "Can't connect to racing server"

**Cause:** Database not initialized or migrations failed.

**Fix:**
1. Run `npm run db:status` to check
2. Run `npm run db:migrate` if tables are missing
3. Restart the server: `npm start`

## Production Checklist

Before deploying to production:

- [ ] DATABASE_URL is set in Replit Secrets (not .env)
- [ ] Connection string includes `?sslmode=require`
- [ ] Run `npm run db:status` - all checks pass
- [ ] Treasury table exists and initialized
- [ ] Server starts without database errors
- [ ] Racing system can create and settle races

## Support

If you're still having issues:

1. Run the diagnostic:
   ```bash
   npm run db:status
   ```

2. Check server logs for database errors:
   ```bash
   npm start 2>&1 | grep -i "database\|postgres\|treasury"
   ```

3. Verify migrations ran:
   ```bash
   npm run db:migrate
   ```

## Why PostgreSQL?

The system uses PostgreSQL for production because:

- ✅ **Data Persistence**: Survives server restarts and redeployments
- ✅ **Scalability**: Handles thousands of concurrent bets
- ✅ **Reliability**: ACID transactions for financial data
- ✅ **Speed**: Optimized for complex queries (leaderboards, receipts)

SQLite is only used for local development. Production **must** use PostgreSQL.

## Architecture

```
Production:
PostgreSQL (Neon/Supabase) ←→ Server ←→ Clients

Development:
SQLite (local file) ←→ Server ←→ Clients
```

All code is designed to work with PostgreSQL in production. The server automatically detects the environment and uses the correct database driver.
