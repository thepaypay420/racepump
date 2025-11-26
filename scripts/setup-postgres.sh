#!/bin/bash

# PostgreSQL Setup and Verification Script
# This ensures the database is properly initialized with all tables

set -e

echo "🔧 PostgreSQL Setup Script"
echo "=========================="
echo ""

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ ERROR: DATABASE_URL is not set!"
    echo ""
    echo "To fix this:"
    echo "1. If using Replit, add DATABASE_URL to Secrets:"
    echo "   - Click 'Tools' → 'Secrets'"
    echo "   - Add key: DATABASE_URL"
    echo "   - Add value: postgres://user:pass@host.neon.tech/dbname?sslmode=require"
    echo ""
    echo "2. If using local development, create a .env file:"
    echo "   DATABASE_URL=postgres://user:pass@localhost:5432/dbname"
    echo ""
    echo "3. Get a free PostgreSQL database from:"
    echo "   - Neon: https://neon.tech"
    echo "   - Supabase: https://supabase.com"
    echo "   - Railway: https://railway.app"
    echo ""
    exit 1
fi

echo "✅ DATABASE_URL is set"
echo ""

# Run migrations
echo "🔄 Running database migrations..."
echo ""

if command -v npx &> /dev/null; then
    npx tsx scripts/sql-migrations.ts
else
    echo "⚠️  npx not found, trying npm..."
    npm run db:migrate
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Start the server: npm start (or npm run dev for development)"
echo "2. The server will automatically connect to PostgreSQL"
echo "3. All data will persist across restarts"
echo ""
