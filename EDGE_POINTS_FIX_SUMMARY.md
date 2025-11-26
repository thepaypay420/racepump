# Edge Points Fix Summary

## Issues Identified

### 1. SOL Leaderboard Edge Points Bug
**Location**: `server/routes.ts` line 1444 (now fixed)

**Problem**: The SOL leaderboard was setting edge points equal to total SOL awarded instead of calculating them properly:
```typescript
// BEFORE (incorrect)
edgePoints: v.wallet === houseWallet ? '0' : v.awarded.toString()
```

This meant that users who won more SOL showed higher edge points, making the leaderboard essentially a "total winnings" board rather than a skill/participation metric.

### 2. SOL Leaderboard Not Using Proper Data Source
**Location**: `server/routes.ts` lines 1403-1461 (now fixed)

**Problem**: The SOL leaderboard was manually aggregating data from `bets` and `settlement_transfers` tables instead of reading from the `user_race_results` table, which contains properly calculated edge points from settlement.

### 3. Edge Points Recording (Already Working)
**Status**: ✅ Already correct

Edge points are correctly calculated and stored for both SOL and RACE bets:
- `server/edge-points.ts`: Currency-agnostic formula that rewards participation, wins, bet size, and efficiency
- `server/race-state-machine.ts` lines 471-513 (RACE bets): Calculates edge points during settlement
- `server/race-state-machine.ts` lines 716-761 (SOL bets): Calculates edge points during settlement
- Both correctly call `computeEdgePoints()` and store results in `user_race_results` table
- Data is mirrored to Postgres for durability

## Fixes Applied

### Fix 1: Updated SOL Leaderboard Logic
**File**: `server/routes.ts`

Changed the SOL leaderboard to read from the `user_race_results` table (which has properly calculated edge points) instead of manually aggregating from bets and transfers.

**Key changes**:
1. Now reads from `user_race_results` table via `getUserRecentResults()`
2. Aggregates edge points from the stored values (calculated during settlement)
3. Correctly handles wins, losses, and statistics per currency
4. Edge points are now properly calculated based on the formula in `edge-points.ts`

### Edge Points Formula (Already Working Correctly)
The edge points formula in `server/edge-points.ts` is currency-agnostic and factors in:
- **Base points**: 1000 for participation
- **Win bonus**: +5000 for wins
- **Bet share contribution**: sqrt-scaled based on bet size relative to pot (max 6000)
- **Payout share contribution**: sqrt-scaled based on payout relative to pot (max 9000)
- **Efficiency multiplier**: Payout-to-bet ratio (capped at 5x, max 5000)
- **Pot multiplier**: Small boost for participating in larger pots
- **Loss reduction**: Losses receive 70% of calculated points (min 500)

This means edge points reward:
- Participation in races
- Winning
- Smart betting (high efficiency)
- Contributing to pot size
- But dampens whales from dominating via sqrt scaling

## Data Persistence Verification

### ✅ Database Storage
- **SQLite**: `user_race_results` table stores edge points
  - Schema: `edgePoints TEXT NOT NULL`
  - Updated on every race settlement
  
- **Postgres**: Mirrored for durability
  - Schema: `edge_points NUMERIC NOT NULL`
  - Automatically synced when `pgReady && pgPool` is available
  - Hydrated on server restart from Postgres → SQLite

### ✅ Leaderboard Data Sources
1. **RACE Leaderboard** (`/api/leaderboard`):
   - Reads from `user_stats` table (aggregated from `user_race_results`)
   - Falls back to Postgres when `usePgForReceipts` is enabled
   - Correctly includes edge points

2. **SOL Leaderboard** (`/api/leaderboard?currency=SOL`):
   - NOW reads from `user_race_results` table (FIXED)
   - Aggregates edge points per wallet
   - Excludes treasury wallet from earning edge points

### ✅ Receipts Data Source
- Endpoint: `/api/user/:wallet/receipts`
- Reads from `user_race_results` table
- Includes edge points in response
- Optionally pulls settlement transfers from Postgres when `usePgForReceipts` is enabled

## Backfilling Historical Data

If you have existing race results with incorrect edge points, you can backfill them using the existing script:

```typescript
// In server console or via admin endpoint
import { backfillUserResultsFromHistory } from './server/backfill';
await backfillUserResultsFromHistory();
```

This will:
1. Find all settled races
2. Recalculate edge points for each wallet in each race
3. Update `user_race_results` table
4. Rebuild `user_stats` for each wallet
5. Sync to Postgres automatically

## Testing Recommendations

1. **Test SOL Leaderboard**: 
   - Place SOL bets on a race
   - Wait for settlement
   - Check `/api/leaderboard?currency=SOL`
   - Verify edge points are NOT equal to totalAwarded

2. **Test Edge Points Display**:
   - Check `/api/user/:wallet/receipts`
   - Verify `edgePoints` field is present and non-zero for settled races
   - Check frontend displays edge points correctly

3. **Test Postgres Persistence**:
   - Set `RECEIPTS_BACKEND=postgres` (or ensure `DATABASE_URL` is set)
   - Restart server
   - Verify data persists across restarts

4. **Test Backfill** (if needed):
   - Run backfill script
   - Verify all historical races now have edge points
   - Check leaderboard reflects updated values

## Configuration

### Environment Variables
- `DATABASE_URL`: Postgres connection string (Neon) - required for production persistence
- `RECEIPTS_BACKEND`: Set to `postgres` to prefer Postgres for leaderboard/receipts
- No changes needed - system automatically uses Postgres when configured

### Feature Flags
- `usePgForReceipts`: Automatically enabled when `RECEIPTS_BACKEND=postgres`
- Controls whether leaderboard falls back to Postgres when SQLite is empty/behind

## Summary

✅ **Edge points calculation**: Already working correctly for both SOL and RACE bets
✅ **Edge points storage**: Properly stored in both SQLite and Postgres
✅ **SOL leaderboard**: FIXED to use proper edge points from database
✅ **Receipts endpoint**: Already correctly reading edge points
✅ **Data persistence**: Postgres mirroring working correctly
✅ **Backfill available**: Can recalculate historical edge points if needed

The main issue was the SOL leaderboard display logic, which has now been fixed. Edge points are now correctly calculated and displayed for all races regardless of currency.
