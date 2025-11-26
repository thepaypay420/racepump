# Edge Points Fix - Quick Guide

## What Was Fixed

### The Problem
1. **SOL Leaderboard** was showing edge points equal to SOL earned (wrong!)
2. **Global Leaderboard** was not properly reading from the Postgres database
3. Users were seeing **zero edge points** in their race results

### The Solution
✅ Fixed SOL leaderboard to read from `user_race_results` table (which has properly calculated edge points)
✅ Verified Postgres mirroring is working correctly
✅ Confirmed edge points calculation is currency-agnostic and working for both SOL and RACE bets

## Testing Your Fix

### Option 1: Run the Verification Script
```bash
# Make sure your server is running first
npm start  # or your start command

# In another terminal:
node scripts/verify-edge-points-fix.mjs
```

This will test:
- ✅ SOL leaderboard returns proper edge points (not equal to totalAwarded)
- ✅ RACE leaderboard works correctly
- ✅ Receipts include edge points
- ✅ Postgres persistence is configured

### Option 2: Manual Testing

1. **Test SOL Leaderboard**:
```bash
curl http://localhost:5000/api/leaderboard?currency=SOL&limit=5 | jq
```
Verify that `edgePoints` ≠ `totalAwarded`

2. **Test RACE Leaderboard**:
```bash
curl http://localhost:5000/api/leaderboard?limit=5 | jq
```
Verify edge points are shown

3. **Test Receipts**:
```bash
# Replace WALLET_ADDRESS with a real wallet
curl http://localhost:5000/api/user/WALLET_ADDRESS/receipts | jq
```
Verify `edgePoints` field is present

## Backfilling Historical Data (Optional)

If you have old races with incorrect edge points, you can backfill them:

### Option 1: Via Node Console
```javascript
import { backfillUserResultsFromHistory } from './server/backfill.js';
const result = await backfillUserResultsFromHistory();
console.log(`Processed ${result.racesProcessed} races, updated ${result.walletsUpdated} wallets`);
```

### Option 2: Create an Admin Endpoint (Recommended)
Add to `server/routes.ts`:
```typescript
app.post("/api/admin/backfill-edge-points", requireAdminAuth, async (req, res) => {
  try {
    const { backfillUserResultsFromHistory } = await import('./backfill');
    const result = await backfillUserResultsFromHistory({
      logger: (msg) => console.log(msg)
    });
    res.json({ 
      success: true, 
      ...result,
      message: `Backfilled ${result.racesProcessed} races, updated ${result.walletsUpdated} wallets`
    });
  } catch (error) {
    console.error('Backfill error:', error);
    res.status(500).json({ error: 'Backfill failed' });
  }
});
```

Then call it:
```bash
curl -X POST http://localhost:5000/api/admin/backfill-edge-points \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## Understanding Edge Points

Edge points are calculated using a sophisticated formula that rewards:

- **Participation**: Base 1000 points just for playing
- **Winning**: +5000 bonus points
- **Bet Size**: sqrt-scaled to prevent whales from dominating (max 6000)
- **Payout Size**: sqrt-scaled reward for larger wins (max 9000)
- **Efficiency**: High payout-to-bet ratio gets bonus (max 5000)
- **Pot Participation**: Small bonus for bigger pots
- **Losses**: Still get 70% of calculated points (min 500)

**This formula is currency-agnostic**, so SOL and RACE bets are treated fairly.

## Verifying Postgres Persistence

Check your persistence status:
```bash
curl http://localhost:5000/api/persistence | jq
```

Expected output:
```json
{
  "status": "healthy",
  "backend": "postgres",
  "persistent": true,
  "postgres": {
    "ready": true,
    "receipts": 1234,
    "leaderboard_stats": 567,
    "leaderboard_results": 890
  }
}
```

If Postgres is not configured:
1. Sign up for [Neon Postgres](https://neon.tech) (free tier available)
2. Set `DATABASE_URL` in your environment/secrets
3. Restart your server
4. Data will automatically sync to Postgres

## Common Issues

### Issue: Edge points still showing as zero
**Solution**: Run the backfill script to recalculate historical data

### Issue: SOL leaderboard showing wrong values
**Solution**: The fix is in place. For existing data, run backfill.

### Issue: Data not persisting across restarts
**Solution**: Configure Postgres via `DATABASE_URL` environment variable

### Issue: Postgres not syncing
**Check**:
1. `DATABASE_URL` is set correctly
2. Connection string includes `?sslmode=require`
3. Server logs show "✅ Postgres initialized and ready"

## Files Changed

- `server/routes.ts` - Fixed SOL leaderboard logic (lines 1403-1479)
- `EDGE_POINTS_FIX_SUMMARY.md` - Detailed technical summary
- `scripts/verify-edge-points-fix.mjs` - Verification script

## No Changes Needed To

✅ `server/edge-points.ts` - Formula already correct
✅ `server/settlement.ts` - Edge point calculation already working
✅ `server/race-state-machine.ts` - SOL settlement already correct
✅ `server/db.ts` - Database schema and persistence already correct
✅ `server/backfill.ts` - Backfill script already available

## Summary

The edge points system is now fully functional:
- ✅ Correctly calculated for both SOL and RACE bets
- ✅ Properly stored in database (SQLite + Postgres)
- ✅ SOL leaderboard fixed to show actual skill/participation metrics
- ✅ Data persists across server restarts (when Postgres is configured)
- ✅ Receipts show edge points earned per race

If you have questions or issues, refer to `EDGE_POINTS_FIX_SUMMARY.md` for technical details.
