#!/usr/bin/env node

/**
 * Diagnostic script to check race states and force settlement if needed
 */

import { sqliteDb } from './server/db.js';
import { RaceStateMachine } from './server/race-state-machine.js';
import { RaceTimer } from './server/race-timer.js';
import { chainTime } from './server/chain-time.js';

console.log('🔍 Diagnosing race states...\n');

// Initialize chain time
await chainTime.initialize();

// Get all races
const allRaces = sqliteDb.getRaces();
console.log(`Total races in database: ${allRaces.length}`);

// Group races by status
const racesByStatus = {};
allRaces.forEach(race => {
  if (!racesByStatus[race.status]) {
    racesByStatus[race.status] = [];
  }
  racesByStatus[race.status].push(race);
});

// Display race counts by status
console.log('\nRaces by status:');
Object.entries(racesByStatus).forEach(([status, races]) => {
  console.log(`  ${status}: ${races.length}`);
});

// Check for stuck races
console.log('\n🚨 Checking for stuck races...\n');

const now = Date.now();
let stuckCount = 0;

// Check IN_PROGRESS races
const inProgressRaces = racesByStatus['IN_PROGRESS'] || [];
for (const race of inProgressRaces) {
  const lockedAge = race.lockedTs ? now - race.lockedTs : 0;
  const progressDuration = 20 * 60 * 1000; // 20 minutes
  
  if (lockedAge > progressDuration) {
    stuckCount++;
    console.log(`⚠️  Race ${race.id} is stuck in IN_PROGRESS`);
    console.log(`   - Status: ${race.status}`);
    console.log(`   - Locked ${Math.floor(lockedAge / 60000)} minutes ago`);
    console.log(`   - Should have settled ${Math.floor((lockedAge - progressDuration) / 60000)} minutes ago`);
    
    // Get expected status
    const expectedStatus = RaceStateMachine.getExpectedStatus(race);
    console.log(`   - Expected status: ${expectedStatus}`);
    
    if (expectedStatus === 'SETTLED') {
      console.log(`   - 🔧 Attempting to force settle...`);
      try {
        const settledRace = await RaceStateMachine.transitionRace(race.id, 'SETTLED', 'diagnostic-force');
        console.log(`   - ✅ Successfully settled race with winner index: ${settledRace.winnerIndex}`);
      } catch (error) {
        console.log(`   - ❌ Failed to settle: ${error.message}`);
      }
    }
    console.log('');
  }
}

// Check LOCKED races
const lockedRaces = racesByStatus['LOCKED'] || [];
for (const race of lockedRaces) {
  const lockedAge = race.lockedTs ? now - race.lockedTs : 0;
  
  if (lockedAge > 10000) { // More than 10 seconds
    stuckCount++;
    console.log(`⚠️  Race ${race.id} is stuck in LOCKED`);
    console.log(`   - Locked ${Math.floor(lockedAge / 1000)} seconds ago`);
    console.log(`   - Should be IN_PROGRESS by now`);
    
    const expectedStatus = RaceStateMachine.getExpectedStatus(race);
    console.log(`   - Expected status: ${expectedStatus}`);
    console.log('');
  }
}

// Check OPEN races
const openRaces = racesByStatus['OPEN'] || [];
for (const race of openRaces) {
  const raceAge = now - race.startTs;
  const openDuration = 20.5 * 60 * 1000; // 20.5 minutes
  
  if (raceAge > openDuration) {
    stuckCount++;
    console.log(`⚠️  Race ${race.id} is stuck in OPEN`);
    console.log(`   - Started ${Math.floor(raceAge / 60000)} minutes ago`);
    console.log(`   - Should have locked ${Math.floor((raceAge - openDuration) / 60000)} minutes ago`);
    
    const expectedStatus = RaceStateMachine.getExpectedStatus(race);
    console.log(`   - Expected status: ${expectedStatus}`);
    console.log('');
  }
}

// Check recent winners
console.log('\n📊 Recent winners check:');
const recentWinners = sqliteDb.getRecentWinners(10);
console.log(`Found ${recentWinners.length} recent winners`);

if (recentWinners.length > 0) {
  console.log('\nLast 5 winners:');
  recentWinners.slice(0, 5).forEach(race => {
    const winner = race.runners[race.winnerIndex];
    console.log(`  - Race ${race.id.slice(-8)}: ${winner?.symbol || 'Unknown'} won`);
  });
} else {
  console.log('❌ No recent winners found!');
}

// Check if RaceTimer is functioning
console.log('\n⏰ Race Timer Status:');
const timerStats = RaceTimer.getStats();
console.log(`  - Is running: ${timerStats.isRunning}`);
console.log(`  - Active timers: ${timerStats.activeTimers}`);
console.log(`  - Active races: ${timerStats.activeRaces}`);

if (!timerStats.isRunning) {
  console.log('\n🚨 Race Timer is not running! Starting it now...');
  RaceTimer.start();
  console.log('✅ Race Timer started');
}

// Summary
console.log('\n📋 Summary:');
console.log(`  - Total races: ${allRaces.length}`);
console.log(`  - Stuck races found: ${stuckCount}`);
console.log(`  - Recent winners: ${recentWinners.length}`);
console.log(`  - Timer running: ${timerStats.isRunning}`);

if (stuckCount > 0) {
  console.log('\n⚠️  Found stuck races. The system may need manual intervention.');
  console.log('Consider restarting the server or running maintenance commands.');
}

// Check leaderboard
console.log('\n🏆 Leaderboard check:');
const leaderboard = sqliteDb.getLeaderboard(5);
console.log(`Top ${leaderboard.length} players:`);
leaderboard.forEach((player, index) => {
  console.log(`  ${index + 1}. ${player.wallet.slice(0, 8)}... - ${player.wins} wins, ${player.edgePoints} points`);
});

process.exit(0);