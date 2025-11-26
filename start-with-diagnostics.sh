#!/bin/bash

echo "🔍 Server Startup Diagnostics"
echo "=============================="
echo ""

# Check if DATABASE_URL is available
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL is NOT available in environment!"
    echo ""
    echo "Possible causes:"
    echo "1. Replit Secret not set (check Tools → Secrets)"
    echo "2. Running in wrong environment (not in Replit deployment)"
    echo "3. Secret name misspelled (should be exactly: DATABASE_URL)"
    echo ""
    echo "To fix:"
    echo "1. Go to Replit interface"
    echo "2. Click 'Tools' → 'Secrets'"
    echo "3. Verify 'DATABASE_URL' exists"
    echo "4. Click 'Run' button (not terminal command)"
    echo ""
    exit 1
else
    echo "✅ DATABASE_URL is available"
    # Show redacted version
    DB_REDACTED=$(echo "$DATABASE_URL" | sed 's/:[^@]*@/:****@/')
    echo "   Connection: $DB_REDACTED"
    echo ""
fi

# Check Node version
echo "📦 Node version: $(node --version)"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "⚠️  node_modules not found - running npm install..."
    npm install
    echo ""
fi

echo "🚀 Starting server with full database logging..."
echo ""
echo "Watch for these lines:"
echo "  ✅ '📦 Using Postgres connection string'"
echo "  ✅ '✅ Postgres connection verified'"
echo "  ✅ '🔄 Running migrations...'"
echo "  ✅ '✅ Postgres initialized and ready'"
echo ""
echo "If you see errors, they will appear below:"
echo "----------------------------------------"
echo ""

# Start server with environment variable tracing
NODE_ENV=production npm start
