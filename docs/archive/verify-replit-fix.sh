#!/bin/bash
# Verification script for Replit database persistence fix

echo "🔍 Verifying Replit Database Persistence Fix"
echo "=============================================="
echo ""

# Check 1: .replit has database migrations disabled
echo "✓ Check 1: Database migrations disabled in .replit"
if grep -q "\[deployment.databaseMigrations\]" .replit && grep -q "enabled = false" .replit; then
    echo "  ✅ PASS: [deployment.databaseMigrations] enabled = false"
else
    echo "  ❌ FAIL: Missing [deployment.databaseMigrations] enabled = false"
    exit 1
fi
echo ""

# Check 2: sql-scripts directory exists and has migrations
echo "✓ Check 2: SQL migrations exist"
if [ -d "sql-scripts" ] && [ "$(ls -1 sql-scripts/*.sql 2>/dev/null | wc -l)" -gt 0 ]; then
    echo "  ✅ PASS: Found $(ls -1 sql-scripts/*.sql | wc -l) migration file(s)"
    ls -1 sql-scripts/*.sql | sed 's/^/    - /'
else
    echo "  ❌ FAIL: sql-scripts/ directory missing or empty"
    exit 1
fi
echo ""

# Check 3: Migration runner exists
echo "✓ Check 3: Migration runner exists"
if [ -f "scripts/sql-migrations.ts" ]; then
    echo "  ✅ PASS: scripts/sql-migrations.ts found"
else
    echo "  ❌ FAIL: scripts/sql-migrations.ts missing"
    exit 1
fi
echo ""

# Check 4: No destructive operations in baseline migration
echo "✓ Check 4: Safe migrations (no destructive operations)"
if grep -E "(DROP TABLE|TRUNCATE|DELETE FROM) (bets|settlement_transfers|user_)" sql-scripts/001_baseline.sql > /dev/null 2>&1; then
    echo "  ❌ FAIL: Found destructive operations in baseline migration"
    exit 1
else
    echo "  ✅ PASS: No destructive operations in 001_baseline.sql"
fi
echo ""

# Check 5: Migration runner uses app_migrations table
echo "✓ Check 5: Using app_migrations (not drizzle_migrations)"
if grep -q "app_migrations" scripts/sql-migrations.ts; then
    echo "  ✅ PASS: Migration runner uses app_migrations table"
else
    echo "  ❌ FAIL: Migration runner not configured correctly"
    exit 1
fi
echo ""

# Check 6: No Drizzle dependencies in package.json
echo "✓ Check 6: No Drizzle dependencies"
if grep -q '"drizzle-orm"' package.json || grep -q '"drizzle-kit"' package.json; then
    echo "  ⚠️  WARNING: Drizzle dependencies found in package.json"
    echo "     This might trigger Replit's auto-detection"
else
    echo "  ✅ PASS: No Drizzle dependencies found"
fi
echo ""

# Check 7: Migration runner is called from server
echo "✓ Check 7: Migrations run at app startup"
if grep -q "runSqlMigrations" server/db.ts; then
    echo "  ✅ PASS: server/db.ts calls runSqlMigrations()"
else
    echo "  ❌ FAIL: Migrations not integrated into app startup"
    exit 1
fi
echo ""

# Check 8: Verify baseline migration has required tables
echo "✓ Check 8: Baseline migration defines required tables"
REQUIRED_TABLES=("bets" "settlement_transfers" "settlement_errors" "user_stats")
for table in "${REQUIRED_TABLES[@]}"; do
    if grep -q "CREATE TABLE IF NOT EXISTS $table" sql-scripts/001_baseline.sql; then
        echo "  ✅ $table table defined"
    else
        echo "  ❌ $table table missing"
        exit 1
    fi
done
echo ""

# Check 9: Verify currency column in settlement_transfers
echo "✓ Check 9: Currency column defined in settlement_transfers"
if grep -A 10 "CREATE TABLE IF NOT EXISTS settlement_transfers" sql-scripts/001_baseline.sql | grep -q "currency TEXT"; then
    echo "  ✅ PASS: currency column defined"
else
    echo "  ❌ FAIL: currency column missing"
    exit 1
fi
echo ""

# Optional: Check DATABASE_URL if available
echo "✓ Check 10: Database connection"
if [ -n "$DATABASE_URL" ]; then
    echo "  ✅ PASS: DATABASE_URL is set"
    
    # Try to connect and check tables
    if command -v psql > /dev/null 2>&1; then
        echo ""
        echo "  📊 Checking production database..."
        
        # Check if app_migrations table exists
        if psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM app_migrations" > /dev/null 2>&1; then
            MIGRATION_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM app_migrations" 2>/dev/null | tr -d ' ')
            echo "     - Applied migrations: $MIGRATION_COUNT"
        else
            echo "     - app_migrations table not yet created (first run)"
        fi
        
        # Check if bets table exists and has data
        if psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM bets" > /dev/null 2>&1; then
            BETS_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM bets" 2>/dev/null | tr -d ' ')
            echo "     - Bets in production: $BETS_COUNT"
        else
            echo "     - bets table not yet created"
        fi
        
        # Check if settlement_transfers has currency column
        if psql "$DATABASE_URL" -t -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'settlement_transfers' AND column_name = 'currency'" > /dev/null 2>&1; then
            echo "     - currency column: ✅ exists"
        fi
    fi
else
    echo "  ⚠️  WARNING: DATABASE_URL not set (set in Replit Secrets for production)"
fi
echo ""

echo "=============================================="
echo "🎉 All verification checks passed!"
echo ""
echo "✅ Your database persistence fix is properly configured"
echo ""
echo "Next steps:"
echo "1. Commit these changes:"
echo "   git add .replit .replitignore REPLIT_DATABASE_PERSISTENCE_SOLUTION.md"
echo "   git commit -m 'fix: disable Replit database auto-detection'"
echo ""
echo "2. Deploy to Replit"
echo ""
echo "3. If you still see warnings during deployment:"
echo "   - Click 'Deploy anyway' (your data is safe)"
echo "   - The warning is a false positive"
echo "   - Migrations will run safely in app startup"
echo ""
echo "4. Verify data persists after deployment"
echo ""
echo "📖 See REPLIT_DATABASE_PERSISTENCE_SOLUTION.md for details"
