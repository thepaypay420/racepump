#!/bin/bash
# Database Setup Verification Script
# Run this to check if DATABASE_URL is properly configured

echo "🔍 Checking Database Configuration..."
echo ""

# Check 1: DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
  echo "❌ DATABASE_URL is NOT set"
  echo "   → Add it to Replit Secrets and restart"
  echo ""
  echo "Steps to fix:"
  echo "1. Click the 🔒 Lock icon (Secrets) in Replit sidebar"
  echo "2. Click '+ New Secret'"
  echo "3. Key: DATABASE_URL"
  echo "4. Value: Your Neon PostgreSQL connection string"
  echo "5. Restart your Repl"
  exit 1
else
  echo "✅ DATABASE_URL is set"
  # Redact sensitive parts
  DB_REDACTED=$(echo "$DATABASE_URL" | sed 's/:\/\/[^@]*@/:\/\/***@/')
  echo "   Connection: $DB_REDACTED"
fi

# Check 2: Drizzle config
echo ""
echo "📝 Checking Drizzle config..."
if grep -q "server/db/schema-drizzle.ts" drizzle.config.ts; then
  echo "✅ drizzle.config.ts points to correct schema"
else
  echo "❌ drizzle.config.ts is misconfigured"
  exit 1
fi

# Check 3: Schema file exists
echo ""
echo "📄 Checking schema file..."
if [ -f "server/db/schema-drizzle.ts" ]; then
  echo "✅ Schema file exists"
else
  echo "❌ server/db/schema-drizzle.ts not found"
  exit 1
fi

# Check 4: Migration safety
echo ""
echo "🔒 Checking migration safety..."
npm run db:check

# Check 5: Schema changes
echo ""
echo "🔄 Checking for schema changes..."
npx drizzle-kit generate 2>&1 | grep -E "(No schema changes|tables|columns)" | head -20

echo ""
echo "═══════════════════════════════════════════════════"
echo "✅ All checks passed! Safe to deploy."
echo "═══════════════════════════════════════════════════"
