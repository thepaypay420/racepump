#!/usr/bin/env node

/**
 * Manual script to rebuild the leaderboard by triggering backfill.
 * 
 * This will:
 * 1. Read all RACE bets and settlement_transfers from Postgres
 * 2. Reconstruct user_race_results for each wallet
 * 3. Rebuild user_stats table (the leaderboard source)
 * 
 * Usage:
 *   node scripts/rebuild-leaderboard.mjs
 * 
 * Or from Replit shell:
 *   npx tsx scripts/rebuild-leaderboard.mjs
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '../.env') });

console.log('🏗️ Starting leaderboard rebuild...\n');

// Import the backfill function
const { backfillUserResultsFromHistory } = await import('../server/backfill.ts');

// Wait for database to be ready
console.log('⏳ Waiting for database initialization...');
const { hydrationPromise } = await import('../server/db.ts');
await hydrationPromise;
console.log('✅ Database ready\n');

// Run backfill
console.log('🔄 Running backfill from Postgres...');
const result = await backfillUserResultsFromHistory({
  logger: (msg) => console.log(`   ${msg}`)
});

console.log('\n📊 Backfill Results:');
console.log(`   Races processed: ${result.racesProcessed}`);
console.log(`   Wallet entries updated: ${result.walletsUpdated}`);

// Show leaderboard summary
const { sqliteDb } = await import('../server/db.ts');
const summary = sqliteDb.getUserStatsSummary();
const count = sqliteDb.getUserStatsRowCount();

console.log('\n📈 Leaderboard Summary:');
console.log(`   Total wallets in user_stats: ${count}`);
console.log(`   Unique wallets: ${summary.walletCount}`);
console.log(`   Last updated: ${summary.lastUpdated ? new Date(summary.lastUpdated).toISOString() : 'N/A'}`);

// Show top 5
console.log('\n🏆 Top 5 Leaderboard:');
const top5 = sqliteDb.getLeaderboard(5);
if (top5 && top5.length > 0) {
  top5.forEach((entry, i) => {
    console.log(`   ${i + 1}. ${entry.wallet.substring(0, 8)}... - Edge Points: ${entry.edgePoints}, Wins: ${entry.wins}, Races: ${entry.totalRaces}`);
  });
} else {
  console.log('   (No leaderboard data)');
}

console.log('\n✅ Leaderboard rebuild complete!');
process.exit(0);
