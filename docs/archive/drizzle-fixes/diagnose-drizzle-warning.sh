#!/bin/bash
# Diagnostic script to understand Drizzle warnings

echo "═══════════════════════════════════════════════════"
echo "🔍 DRIZZLE WARNING DIAGNOSTIC"
echo "═══════════════════════════════════════════════════"
echo ""

# Check 1: DATABASE_URL
echo "1️⃣  Checking DATABASE_URL..."
if [ -z "$DATABASE_URL" ]; then
  echo "   ❌ DATABASE_URL is NOT set in this shell"
  echo "   Note: It might be in Replit Secrets but not loaded yet"
  echo "   Try: Stop and restart your Repl"
else
  echo "   ✅ DATABASE_URL is set"
  DB_HOST=$(echo "$DATABASE_URL" | grep -oP '(?<=@)[^/]+' | cut -d':' -f1)
  echo "   Host: $DB_HOST"
fi
echo ""

# Check 2: Drizzle config
echo "2️⃣  Checking drizzle.config.ts..."
echo "   Schema path:"
grep "schema:" drizzle.config.ts | head -1
echo "   Output path:"
grep "out:" drizzle.config.ts | head -1
echo ""

# Check 3: Schema file
echo "3️⃣  Checking schema file..."
if [ -f "server/db/schema-drizzle.ts" ]; then
  echo "   ✅ server/db/schema-drizzle.ts exists"
  echo "   Tables defined:"
  grep "export const" server/db/schema-drizzle.ts | wc -l
  echo "   Has 'bets' table:"
  grep -q "export const bets" server/db/schema-drizzle.ts && echo "   ✅ Yes" || echo "   ❌ No"
  echo "   Has 'currency' in bets:"
  grep -A 20 "export const bets" server/db/schema-drizzle.ts | grep -q "currency" && echo "   ✅ Yes" || echo "   ❌ No"
  echo "   Has 'settlement_errors' table:"
  grep -q "export const settlementErrors" server/db/schema-drizzle.ts && echo "   ✅ Yes" || echo "   ❌ No"
else
  echo "   ❌ server/db/schema-drizzle.ts NOT FOUND"
fi
echo ""

# Check 4: Snapshot
echo "4️⃣  Checking snapshot file..."
if [ -f "drizzle-migrations/meta/0000_snapshot.json" ]; then
  echo "   ✅ Snapshot exists"
  echo "   Tables in snapshot:"
  grep -o '"public\.[^"]*"' drizzle-migrations/meta/0000_snapshot.json | head -12
  echo "   Snapshot size: $(wc -c < drizzle-migrations/meta/0000_snapshot.json) bytes"
  
  # Check if bets table has currency in snapshot
  if grep -q '"bets"' drizzle-migrations/meta/0000_snapshot.json && grep -A 200 '"bets"' drizzle-migrations/meta/0000_snapshot.json | grep -q '"currency"'; then
    echo "   ✅ bets table has currency column in snapshot"
  else
    echo "   ❌ currency column missing from bets in snapshot"
  fi
else
  echo "   ❌ Snapshot NOT FOUND"
fi
echo ""

# Check 5: Git status
echo "5️⃣  Checking git status..."
CURRENT_COMMIT=$(git rev-parse --short HEAD)
echo "   Current commit: $CURRENT_COMMIT"
echo "   Last commit message:"
git log -1 --pretty=format:"   %s" && echo ""
UNCOMMITTED=$(git status --porcelain | wc -l)
if [ "$UNCOMMITTED" -eq 0 ]; then
  echo "   ✅ No uncommitted changes"
else
  echo "   ⚠️  $UNCOMMITTED uncommitted changes"
  git status --short
fi
echo ""

# Check 6: Test drizzle-kit
echo "6️⃣  Testing drizzle-kit generate..."
npx drizzle-kit generate 2>&1 | grep -E "(No schema changes|tables|⚠|WARNING|Error)" | head -10
echo ""

# Check 7: If DATABASE_URL is set, test push dry-run
if [ -n "$DATABASE_URL" ]; then
  echo "7️⃣  Testing drizzle-kit push --dry-run..."
  echo "   This will show what Drizzle wants to do to your database:"
  echo ""
  npx drizzle-kit push --dry-run 2>&1 | head -100
else
  echo "7️⃣  Skipping push test (DATABASE_URL not available)"
  echo "   To test this:"
  echo "   1. Make sure DATABASE_URL is in Replit Secrets"
  echo "   2. Stop and restart your Repl"
  echo "   3. Run this script again"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "📋 SUMMARY"
echo "═══════════════════════════════════════════════════"
echo ""
echo "If you're seeing a deletion warning, please share:"
echo "1. The complete output of THIS script"
echo "2. WHERE you see the warning (terminal? Replit UI? Neon?)"
echo "3. WHAT you're doing when you see it (deploying? running a command?)"
echo ""
