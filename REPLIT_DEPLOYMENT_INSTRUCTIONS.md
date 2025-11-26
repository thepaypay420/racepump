# Replit Deployment Instructions

## ⚠️ IMPORTANT: You're Getting "Treasury Does Not Exist" Because...

The server is **not running**! The error appears when you try to start it. Let's fix it.

## Issue: DATABASE_URL from Replit Secrets

You said DATABASE_URL is set in Replit Secrets, but the server can't see it. Here's why and how to fix:

### Problem: How You're Starting the Server

**❌ WRONG (doesn't load secrets):**
```bash
# Running in Shell tab
npm start
```

**✅ CORRECT (loads secrets):**
1. Click the **"Run"** button at the top of Replit
2. OR use the `.replit` configuration

### Why This Happens

Replit Secrets are only injected when the app runs through:
- The "Run" button
- Deployments
- The configured `run` command in `.replit`

They are **NOT** available in the Shell tab!

## Step-by-Step Fix

### Option 1: Use Replit's Run Button (Recommended)

1. **Make sure DATABASE_URL is set:**
   - Click "Tools" → "Secrets"
   - Verify `DATABASE_URL` exists
   - Should look like: `postgres://user:pass@host.postgres.database.azure.com:5432/dbname?sslmode=require`

2. **Click the "Run" button** at the top of Replit
   - This starts your app with secrets loaded
   - Server will connect to PostgreSQL automatically
   - Migrations run automatically
   - Racing system starts

3. **Check the console output:**
   ```
   ✅ Look for these lines:
   📦 Using Postgres connection string from DATABASE_URL
   ✅ Postgres connection verified
   🔄 Running migrations...
   ✅ Postgres initialized and ready
   ```

### Option 2: Create .env File (For Testing)

If you want to test in Shell tab:

1. Create `.env` file in project root:
```bash
DATABASE_URL=postgres://user:pass@host.database.azure.com:5432/dbname?sslmode=require
NODE_ENV=production
```

2. Then run in Shell:
```bash
npm start
```

**⚠️ Don't commit .env to git!** (Already in .gitignore)

## Verify It's Working

### Check Server Logs

When you click "Run", look for:

**Good Signs:**
```
✅ Using Postgres connection string from DATABASE_URL
✅ Postgres connection verified  
🔄 Running pure SQL migrations...
✅ Applied 001_baseline.sql
✅ Pure SQL migrations complete
✅ PostgresStorage initialized - production mode ready
Server listening on port 5000
```

**Bad Signs (and fixes):**
```
❌ DATABASE_URL is REQUIRED
→ Fix: Set in Replit Secrets, use Run button

❌ Postgres connection failed
→ Fix: Check DATABASE_URL is correct

❌ Migration failed
→ Fix: See error details, might need to reset database
```

### Test Endpoints

Once server is running:

```bash
# Test persistence
curl http://localhost:5000/api/persistence

# Test treasury
curl http://localhost:5000/api/treasury

# Test races
curl http://localhost:5000/api/races
```

All should return JSON (not errors).

## Common Issues

### "DATABASE_URL not set" but it's in Secrets

**Cause:** Running `npm start` in Shell tab
**Fix:** Use the "Run" button instead

### "Connection refused" or "Server not running"

**Cause:** Server hasn't started or crashed
**Fix:** Click "Run" button, check logs for errors

### "Treasury does not exist"

**Cause:** Migrations haven't run (because DATABASE_URL not loaded)
**Fix:** Use "Run" button so DATABASE_URL is available

### "Authentication failed"

**Cause:** Wrong credentials in DATABASE_URL
**Fix:** Get fresh connection string from Replit's database dashboard

## Replit Database Setup

If you're using **Replit's built-in PostgreSQL**:

1. Go to "Tools" → "Database"
2. Enable PostgreSQL
3. Copy the connection string
4. Add to Secrets as `DATABASE_URL`
5. Click "Run"

## Deployment to Replit

When you deploy:

1. Deployment automatically gets secrets
2. Runs `npm run build` (from `.replit` config)
3. Runs `npm run start`
4. Migrations run automatically
5. Everything works!

**Make sure:**
- DATABASE_URL is set in deployment secrets
- `.replit` file has correct deployment config (already configured)

## Current .replit Configuration

Your `.replit` file is already correctly configured:

```toml
run = "npm run dev"          # Development

[deployment]
build = ["npm", "run", "build"]
run = ["sh", "-c", "npm run start"]  # Production

[deployment.databaseMigrations]
enabled = false  # We handle migrations in code
```

## Summary

**The Fix:**
1. ✅ DATABASE_URL is in Replit Secrets
2. ✅ Click "Run" button (NOT shell command)
3. ✅ Server starts with DATABASE_URL loaded
4. ✅ Migrations run automatically
5. ✅ Racing system works!

**Don't:**
- ❌ Run `npm start` in Shell tab (secrets not loaded)
- ❌ Expect DATABASE_URL in background agent
- ❌ Try to manually run migrations

**Do:**
- ✅ Use "Run" button
- ✅ Check console logs for connection success
- ✅ Let migrations run automatically

## Need Help?

If it still doesn't work after clicking "Run":

1. **Check logs** - Look for database connection errors
2. **Verify SECRET** - Tools → Secrets → DATABASE_URL exists
3. **Check DATABASE_URL format:**
   ```
   postgres://user:pass@host.postgres.database:5432/dbname?sslmode=require
   ```
4. **Try diagnostic startup:**
   ```bash
   bash start-with-diagnostics.sh
   ```

The system is fully configured. You just need to start it the correct way!
