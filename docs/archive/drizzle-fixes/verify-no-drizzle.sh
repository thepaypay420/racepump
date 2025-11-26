#!/bin/bash

# Script to verify all Drizzle references have been removed
# This helps ensure Replit won't detect any Drizzle-related objects

echo "🔍 Verifying Drizzle removal..."
echo ""

# Check package.json for drizzle packages (in dependencies, not in script messages)
echo "1. Checking package.json for Drizzle packages..."
if grep -E '"(drizzle-orm|drizzle-kit|drizzle-zod)"' package.json 2>/dev/null; then
  echo "❌ FOUND Drizzle packages in package.json dependencies"
  exit 1
else
  echo "✅ No Drizzle packages in package.json dependencies"
fi
echo ""

# Check for drizzle config files
echo "2. Checking for Drizzle config files..."
if find . -name "drizzle.config.*" -not -path "./node_modules/*" 2>/dev/null | grep -q .; then
  echo "❌ FOUND Drizzle config files"
  exit 1
else
  echo "✅ No Drizzle config files found"
fi
echo ""

# Check for drizzle directories
echo "3. Checking for Drizzle directories..."
if find . -type d -name "drizzle" -not -path "./node_modules/*" 2>/dev/null | grep -q .; then
  echo "❌ FOUND Drizzle directories"
  exit 1
else
  echo "✅ No Drizzle directories found"
fi
echo ""

# Check TypeScript/JavaScript files for drizzle imports
echo "4. Checking source files for Drizzle imports..."
if grep -r "from ['\"]drizzle-" --include="*.ts" --include="*.js" --exclude-dir=node_modules --exclude-dir=dist . 2>/dev/null; then
  echo "❌ FOUND Drizzle imports in source files"
  exit 1
else
  echo "✅ No Drizzle imports in source files"
fi
echo ""

# Check migrations for drizzle_migrations table creation
echo "5. Checking migrations for drizzle_migrations table..."
if grep -r "CREATE TABLE.*drizzle_migrations" migrations/ 2>/dev/null; then
  echo "❌ FOUND drizzle_migrations table creation in migrations"
  exit 1
else
  echo "✅ No drizzle_migrations table creation in migrations"
fi
echo ""

# Check .replit configuration
echo "6. Checking .replit configuration..."
if grep -q "enabled = false" .replit 2>/dev/null && grep -q "databaseMigrations" .replit 2>/dev/null; then
  echo "✅ Replit auto-migrations are disabled"
else
  echo "⚠️  WARNING: Replit auto-migrations might not be disabled"
fi
echo ""

echo "════════════════════════════════════════════════════"
echo "✅ All checks passed! No Drizzle references found."
echo "════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "1. Deploy to Replit"
echo "2. The migration system will automatically:"
echo "   - Drop the old drizzle_migrations table"
echo "   - Use app_migrations table instead"
echo "3. Replit should no longer detect any Drizzle schema"
echo ""
