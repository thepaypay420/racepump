#!/bin/bash

echo "🧪 Testing Migration Safety Implementation"
echo "=========================================="
echo ""

# Test 1: Check migration guard script exists and is executable
echo "Test 1: Migration guard script..."
if [ -x scripts/check-migrations.mjs ]; then
    echo "✅ PASS: scripts/check-migrations.mjs is executable"
else
    echo "❌ FAIL: scripts/check-migrations.mjs is not executable"
    exit 1
fi

# Test 2: Check migration guard works on baseline
echo ""
echo "Test 2: Running migration guard on baseline..."
if npm run db:check > /tmp/check-output.txt 2>&1; then
    echo "✅ PASS: Baseline migration passed safety check"
    cat /tmp/check-output.txt | grep "safe"
else
    echo "❌ FAIL: Baseline migration failed safety check"
    cat /tmp/check-output.txt
    exit 1
fi

# Test 3: Create a destructive migration and verify it's blocked
echo ""
echo "Test 3: Testing destructive operation detection..."
cat > drizzle-migrations/9999_test_destructive.sql << 'EOSQL'
-- This should be BLOCKED
DROP TABLE bets;
EOSQL

if npm run db:check > /tmp/destructive-check.txt 2>&1; then
    echo "❌ FAIL: Destructive migration was NOT blocked"
    cat /tmp/destructive-check.txt
    rm drizzle-migrations/9999_test_destructive.sql
    exit 1
else
    echo "✅ PASS: Destructive migration was correctly blocked"
    cat /tmp/destructive-check.txt | grep -i "destructive\|blocked"
fi

# Cleanup test file
rm drizzle-migrations/9999_test_destructive.sql

# Test 4: Check db:push is disabled
echo ""
echo "Test 4: Verify db:push is disabled..."
if npm run db:push 2>&1 | grep -i "disabled\|deprecated"; then
    echo "✅ PASS: db:push is disabled"
else
    echo "❌ FAIL: db:push is still enabled"
    exit 1
fi

# Test 5: Check migrations folder structure
echo ""
echo "Test 5: Check migrations folder structure..."
if [ -f "drizzle-migrations/0000_baseline.sql" ] && [ -f "drizzle-migrations/meta/_journal.json" ]; then
    echo "✅ PASS: Migrations folder structure is correct"
else
    echo "❌ FAIL: Migrations folder structure is incomplete"
    exit 1
fi

# Test 6: Check documentation exists
echo ""
echo "Test 6: Check documentation..."
if [ -f "MIGRATIONS.md" ] && [ -f "DEPLOY_SAFETY.md" ]; then
    echo "✅ PASS: Documentation files exist"
else
    echo "❌ FAIL: Documentation files missing"
    exit 1
fi

echo ""
echo "=========================================="
echo "🎉 ALL TESTS PASSED!"
echo "✅ Migration safety implementation verified"
echo ""
echo "Next steps:"
echo "1. Commit changes: git add . && git commit -m 'Implement safe migrations'"
echo "2. Deploy to production"
echo "3. Verify /api/admin/db-diagnostics shows migrations_applied > 0"
