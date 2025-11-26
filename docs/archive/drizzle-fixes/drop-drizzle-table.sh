#!/bin/bash

# Quick script to drop the drizzle_migrations table from Replit shell

echo "🔧 Dropping drizzle_migrations table from production database..."
echo ""

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ ERROR: DATABASE_URL environment variable is not set"
    echo ""
    echo "To fix this:"
    echo "1. Go to your Replit project"
    echo "2. Click on 'Secrets' (lock icon in sidebar)"
    echo "3. Find your DATABASE_URL"
    echo "4. Run this in shell:"
    echo "   export DATABASE_URL='your-connection-string-here'"
    echo "   ./drop-drizzle-table.sh"
    exit 1
fi

echo "✅ DATABASE_URL is set"
echo ""

# Drop the table using psql
echo "Running: DROP TABLE IF EXISTS drizzle_migrations CASCADE;"
echo ""

psql "$DATABASE_URL" -c "DROP TABLE IF EXISTS drizzle_migrations CASCADE;"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ SUCCESS! Table dropped (or didn't exist)"
    echo ""
    echo "Verifying..."
    echo ""
    
    # Verify it's gone
    psql "$DATABASE_URL" -c "SELECT tablename FROM pg_tables WHERE tablename = 'drizzle_migrations';"
    
    echo ""
    echo "✅ If you see '(0 rows)' above, the table is gone!"
    echo ""
    echo "🚀 You can now deploy without seeing the warning!"
else
    echo ""
    echo "❌ ERROR: Failed to drop table"
    echo ""
    echo "This might mean:"
    echo "1. DATABASE_URL is incorrect"
    echo "2. Database connection failed"
    echo "3. You don't have permission"
    echo ""
    echo "Try connecting manually:"
    echo "  psql \$DATABASE_URL"
fi
