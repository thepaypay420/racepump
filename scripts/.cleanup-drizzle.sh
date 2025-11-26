#!/bin/bash
# Script to clean up Drizzle and old database fix documentation
# Run this manually when you're ready: bash .cleanup-drizzle.sh

set -e

echo "🧹 Cleaning up Drizzle remnants and old fix documentation..."
echo ""

# Create archive directory
mkdir -p docs/archive/drizzle-fixes
mkdir -p docs/archive/database-incidents

echo "📦 Archiving Drizzle-related files..."
mv -v SOLUTION_DRIZZLE_WARNING.md docs/archive/drizzle-fixes/ 2>/dev/null || true
mv -v DRIZZLE_MIGRATION_DIRECTORY_FIX.md docs/archive/drizzle-fixes/ 2>/dev/null || true
mv -v FIX_DRIZZLE_TABLE_MANUALLY.sql docs/archive/drizzle-fixes/ 2>/dev/null || true
mv -v diagnose-drizzle-warning.sh docs/archive/drizzle-fixes/ 2>/dev/null || true
mv -v drop-drizzle-table.sh docs/archive/drizzle-fixes/ 2>/dev/null || true
mv -v verify-no-drizzle.sh docs/archive/drizzle-fixes/ 2>/dev/null || true

echo ""
echo "📦 Archiving old database incident reports..."
mv -v ACTION_REQUIRED.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v ACTION_PLAN.txt docs/archive/database-incidents/ 2>/dev/null || true
mv -v CRITICAL_FIX_SUMMARY.txt docs/archive/database-incidents/ 2>/dev/null || true
mv -v CRITICAL_README.txt docs/archive/database-incidents/ 2>/dev/null || true
mv -v DATA_LOSS_INCIDENT.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v DATABASE_PERSISTENCE_FIXED.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v DATABASE_ROLLBACK_FIX_COMPLETE.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v DATABASE_URL_MISSING_FIX.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v DEPLOYMENT_DATA_LOSS_FIX.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v DEPLOYMENT_SAFETY_EXPLAINED.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v DUPLICATE_MIGRATION_FIX.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v DUPLICATE_PG_TYPE_FIX.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v FIX_RLS_ISSUE.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v FIX_VERIFICATION.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v NUCLEAR_FIX_COMPLETE.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v POSTGRES_HYDRATION_FIX_SUMMARY.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v PURE_SQL_MIGRATION_SOLUTION.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v REPLIT_DATABASE_PERSISTENCE_SOLUTION.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v REPLIT_DATABASE_WIPE_FIX_V4.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v REPLIT_DEPLOYMENT_FIX.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v REPLIT_TABLE_WIPE_FIX_FINAL.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v REPLIT_WARNING_FIX_V2.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v REPLIT_WARNING_FIX_V3.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v SAFE_MIGRATIONS_IMPLEMENTATION.md docs/archive/database-incidents/ 2>/dev/null || true
mv -v TABLE_WIPE_FIX_FINAL.md docs/archive/database-incidents/ 2>/dev/null || true

echo ""
echo "📦 Archiving one-time test/diagnostic scripts..."
mv -v test-migration-fix.sh docs/archive/ 2>/dev/null || true
mv -v test-migration-safety.sh docs/archive/ 2>/dev/null || true
mv -v test-persistence-fix.sh docs/archive/ 2>/dev/null || true
mv -v test-pure-sql-fix.sh docs/archive/ 2>/dev/null || true
mv -v fix-rls-now.sh docs/archive/ 2>/dev/null || true
mv -v verify-replit-fix.sh docs/archive/ 2>/dev/null || true
mv -v diagnose-races.js docs/archive/ 2>/dev/null || true
mv -v reset_app_tables.js docs/archive/ 2>/dev/null || true
mv -v reset_app_tables.mjs docs/archive/ 2>/dev/null || true

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "📂 Archived files are in:"
echo "   - docs/archive/drizzle-fixes/"
echo "   - docs/archive/database-incidents/"
echo "   - docs/archive/"
echo ""
echo "🗑️  If you don't need the history, you can delete the archive:"
echo "   rm -rf docs/archive"
echo ""
echo "📝 Active documentation remains in root:"
echo "   - README.md"
echo "   - DEPLOYMENT_CHECKLIST.md"
echo "   - LEADERBOARD_FIX_SUMMARY.md"
echo "   - And other relevant current docs"
echo ""
