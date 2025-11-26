#!/bin/bash

# Quick fix for RLS issue - disables Row Level Security on all tables
# This fixes Replit's "wants to drop bets table" warning

set -e

echo "🔧 Fixing Row Level Security (RLS) issue..."
echo ""

# Check DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
  echo "❌ ERROR: DATABASE_URL environment variable is not set"
  echo ""
  echo "Set it in Replit Secrets, then try again."
  exit 1
fi

echo "📊 Current RLS status:"
psql "$DATABASE_URL" -c "
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('bets', 'settlement_errors', 'settlement_transfers', 'user_race_results', 'user_stats', 'recent_winners')
ORDER BY tablename;
" || echo "⚠️ Could not query tables (they might not exist yet)"

echo ""
echo "🔧 Disabling RLS on all tables..."

psql "$DATABASE_URL" << 'EOF'
-- Disable RLS on all application tables
ALTER TABLE IF EXISTS bets DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS settlement_errors DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS settlement_transfers DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS user_race_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS user_stats DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS recent_winners DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS referral_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS referral_attributions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS referral_rewards DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS referral_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS referral_aggregates DISABLE ROW LEVEL SECURITY;
EOF

echo ""
echo "✅ RLS disabled successfully!"
echo ""
echo "📊 New RLS status:"
psql "$DATABASE_URL" -c "
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('bets', 'settlement_errors', 'settlement_transfers', 'user_race_results', 'user_stats', 'recent_winners')
ORDER BY tablename;
"

echo ""
echo "🎉 Fix complete! All tables should show rowsecurity = f (false)"
echo ""
echo "Next steps:"
echo "1. Redeploy your app"
echo "2. Replit should NO LONGER show the 'drop bets table' warning"
echo "3. Your 107 bets are safe!"
echo ""
