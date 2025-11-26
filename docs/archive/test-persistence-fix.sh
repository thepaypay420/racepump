#!/bin/bash
# Test script to verify Postgres-SQLite hydration is working

echo "🔍 Testing Persistence Hydration Fix"
echo "===================================="
echo ""

# Check if API is reachable
echo "1. Checking API endpoint..."
if curl -s -f https://racepump.fun/api/persistence > /dev/null 2>&1; then
    echo "   ✅ API is reachable"
else
    echo "   ❌ API is not reachable"
    exit 1
fi

echo ""
echo "2. Fetching persistence status..."
RESPONSE=$(curl -s https://racepump.fun/api/persistence)

echo ""
echo "3. Analyzing results..."
echo "   Raw response:"
echo "   $RESPONSE" | jq . 2>/dev/null || echo "   $RESPONSE"

echo ""
echo "4. Checking SQLite hydration..."

# Extract counts using jq if available, otherwise use grep
if command -v jq &> /dev/null; then
    PG_RECEIPTS=$(echo "$RESPONSE" | jq -r '.postgres.receipts // 0')
    PG_STATS=$(echo "$RESPONSE" | jq -r '.postgres.leaderboard_stats // 0')
    PG_RESULTS=$(echo "$RESPONSE" | jq -r '.postgres.leaderboard_results // 0')
    
    SQLITE_RECEIPTS=$(echo "$RESPONSE" | jq -r '.sqlite.receipts // 0')
    SQLITE_STATS=$(echo "$RESPONSE" | jq -r '.sqlite.leaderboard_stats // 0')
    SQLITE_RESULTS=$(echo "$RESPONSE" | jq -r '.sqlite.leaderboard_results // 0')
    
    echo ""
    echo "   📊 Postgres counts:"
    echo "      - Receipts: $PG_RECEIPTS"
    echo "      - Leaderboard stats: $PG_STATS"
    echo "      - Leaderboard results: $PG_RESULTS"
    
    echo ""
    echo "   💾 SQLite counts:"
    echo "      - Receipts: $SQLITE_RECEIPTS"
    echo "      - Leaderboard stats: $SQLITE_STATS"
    echo "      - Leaderboard results: $SQLITE_RESULTS"
    
    echo ""
    echo "5. Verification:"
    
    if [ "$SQLITE_RECEIPTS" -gt 0 ] && [ "$SQLITE_STATS" -gt 0 ] && [ "$SQLITE_RESULTS" -gt 0 ]; then
        echo "   ✅ SUCCESS: SQLite is properly hydrated from Postgres!"
        echo "   ✅ Users will see their bets, receipts, and leaderboard data"
        exit 0
    elif [ "$PG_RECEIPTS" -eq 0 ] && [ "$PG_STATS" -eq 0 ] && [ "$PG_RESULTS" -eq 0 ]; then
        echo "   ⚠️  Both Postgres and SQLite are empty (no data yet)"
        echo "   ℹ️  This is expected for a fresh deployment"
        exit 0
    else
        echo "   ❌ PROBLEM: Postgres has data but SQLite is empty"
        echo "   ❌ Hydration may not have completed yet"
        echo "   ℹ️  Wait 30 seconds and try again (hydration may still be running)"
        exit 1
    fi
else
    echo "   ⚠️  jq not installed, showing raw response only"
    echo "   Manual verification needed:"
    echo "   - Check that sqlite.receipts > 0"
    echo "   - Check that sqlite.leaderboard_stats > 0"
    echo "   - Check that sqlite.leaderboard_results > 0"
fi
