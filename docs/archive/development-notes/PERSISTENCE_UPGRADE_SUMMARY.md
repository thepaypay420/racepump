# Persistence Upgrade Summary

## Problem Solved
When deploying from Replit or when the app runs for extended periods, the recent winners data and global leaderboard were being lost due to:
1. In-memory storage fallback when database wasn't available
2. No dedicated persistence for recent winners

## Changes Made

### 1. Database Schema Enhancement
- Added `recent_winners` table to persist the last 6 winning races separately
- This table stores:
  - `raceId` (unique)
  - `raceData` (full race JSON)
  - `settledAt` timestamp
  - Auto-cleanup to keep only the last 6 winners

### 2. Server Updates
- **db.ts**: Added methods to manage recent winners:
  - `addRecentWinner(race)`: Adds a settled race to recent winners
  - `getRecentWinners(limit)`: Retrieves recent winners
  - Automatic cleanup to maintain only 6 most recent winners

- **race-state-machine.ts**: Updated to automatically add winners when races settle
  - After transitioning to SETTLED status, winners are added to the dedicated table

- **routes.ts**: Added new endpoint `/api/recent-winners`
  - Returns up to 6 most recent winning races
  - Includes all race details and computed fields

- **index.ts**: Added migration on server startup
  - Automatically populates recent winners from existing settled races
  - Ensures data continuity when upgrading

### 3. Client Updates
- **Lobby.tsx**: Updated to use dedicated recent winners endpoint
  - Fetches from `/api/recent-winners` instead of filtering all races
  - More efficient and ensures data persistence

## Benefits
1. **Data Persistence**: Recent winners survive server restarts and redeployments
2. **Performance**: Dedicated table and endpoint for faster queries
3. **Reliability**: No dependency on in-memory storage
4. **Smart Pruning**: Automatically maintains last 6 winners

## Testing
Run the test script to verify persistence:
```bash
node test-recent-winners.js
```

The global leaderboard already uses the persistent `user_stats` table, so it was already surviving restarts.

## No Breaking Changes
- Existing functionality remains intact
- Migration handles existing data automatically
- Graceful fallback if recent winners table is empty