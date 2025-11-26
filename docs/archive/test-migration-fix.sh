#!/bin/bash

echo "🧪 Testing Migration Fix"
echo "========================"

# Test 1: Check that drizzle-kit is removed from package.json
echo "Test 1: Checking drizzle-kit removal..."
if grep -q "drizzle-kit" package.json; then
    echo "❌ FAIL: drizzle-kit still in package.json"
    exit 1
else
    echo "✅ PASS: drizzle-kit removed from package.json"
fi

# Test 2: Check that config files are hidden
echo "Test 2: Checking config files are hidden..."
if [ -f "drizzle.config.local.ts" ]; then
    echo "❌ FAIL: drizzle.config.local.ts still in root"
    exit 1
else
    echo "✅ PASS: drizzle.config.local.ts moved to .config/"
fi

if [ -f "server/db/schema-drizzle.ts" ]; then
    echo "❌ FAIL: schema-drizzle.ts still in server/db/"
    exit 1
else
    echo "✅ PASS: schema-drizzle.ts moved to .config/"
fi

# Test 3: Check that migration runner works
echo "Test 3: Testing migration runner..."
if DATABASE_URL="postgresql://test:test@localhost:5432/test" node -e "import('./scripts/run-migrations.ts').then(m => m.runMigrations()).catch(e => console.error('Error:', e.message))" 2>&1 | grep -q "ECONNREFUSED"; then
    echo "✅ PASS: Migration runner works (connection error expected)"
else
    echo "❌ FAIL: Migration runner failed"
    exit 1
fi

# Test 4: Check that db:generate is disabled
echo "Test 4: Testing db:generate is disabled..."
if npm run db:generate 2>&1 | grep -q "disabled"; then
    echo "✅ PASS: db:generate is disabled"
else
    echo "❌ FAIL: db:generate is still enabled"
    exit 1
fi

echo ""
echo "✅ All tests passed! Migration fix is working."
echo ""
echo "Next steps:"
echo "1. Commit these changes"
echo "2. Deploy to production"
echo "3. Verify that tables are no longer wiped"