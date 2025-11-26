#!/usr/bin/env node

/**
 * Test script for race state transitions
 * This script tests the new race state machine and timing system
 */

import { RaceStateMachine } from './server/race-state-machine.js';
import { RaceTimer } from './server/race-timer.js';
import { sqliteDb } from './server/db.js';

// Test configuration
const TEST_CONFIG = {
  OPEN_DURATION_MS: 2 * 60 * 1000, // 2 minutes for testing
  PROGRESS_DURATION_MS: 2 * 60 * 1000, // 2 minutes for testing
  TRANSITION_GRACE_MS: 5000 // 5 seconds grace period
};

// Mock race data
const createTestRace = (status = 'OPEN', startOffset = 0) => ({
  id: `test_race_${Date.now()}_${startOffset}`, // Use offset as suffix instead of random
  startTs: Date.now() + startOffset,
  status,
  rakeBps: 300,
  jackpotFlag: false,
  jackpotAdded: 0,
  runners: [
    {
      mint: 'test_mint_1',
      symbol: 'TEST1',
      name: 'Test Token 1',
      initialPrice: 0.001,
      currentPrice: 0.001,
      priceChange: 0,
      marketCap: 10000
    },
    {
      mint: 'test_mint_2', 
      symbol: 'TEST2',
      name: 'Test Token 2',
      initialPrice: 0.002,
      currentPrice: 0.002,
      priceChange: 0,
      marketCap: 20000
    }
  ],
  createdAt: Date.now()
});

// Test functions
async function testStateMachine() {
  console.log('🧪 Testing Race State Machine...');
  
  try {
    // Test 1: Valid transitions
    console.log('  ✓ Testing valid transitions...');
    const validTransitions = [
      ['OPEN', 'LOCKED'],
      ['LOCKED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'SETTLED'],
      ['OPEN', 'CANCELLED'],
      ['LOCKED', 'CANCELLED'],
      ['IN_PROGRESS', 'CANCELLED']
    ];
    
    for (const [from, to] of validTransitions) {
      const canTransition = RaceStateMachine.canTransition(from, to);
      if (!canTransition) {
        throw new Error(`Invalid transition: ${from} → ${to}`);
      }
    }
    console.log('    ✅ All valid transitions work');
    
    // Test 2: Invalid transitions
    console.log('  ✓ Testing invalid transitions...');
    const invalidTransitions = [
      ['SETTLED', 'OPEN'],
      ['CANCELLED', 'LOCKED'],
      ['LOCKED', 'OPEN'],
      ['IN_PROGRESS', 'LOCKED']
    ];
    
    for (const [from, to] of invalidTransitions) {
      const canTransition = RaceStateMachine.canTransition(from, to);
      if (canTransition) {
        throw new Error(`Should not allow transition: ${from} → ${to}`);
      }
    }
    console.log('    ✅ All invalid transitions properly rejected');
    
    // Test 3: Status computation
    console.log('  ✓ Testing status computation...');
    const now = Date.now();
    
    // OPEN race that should be LOCKED
    const oldOpenRace = createTestRace('OPEN', -TEST_CONFIG.OPEN_DURATION_MS - 1000);
    const expectedStatus1 = RaceStateMachine.getExpectedStatus(oldOpenRace);
    if (expectedStatus1 !== 'LOCKED') {
      throw new Error(`Expected LOCKED, got ${expectedStatus1}`);
    }
    
    // LOCKED race that should be IN_PROGRESS
    const lockedRace = createTestRace('LOCKED', -TEST_CONFIG.OPEN_DURATION_MS);
    lockedRace.lockedTs = now - 3000; // 3 seconds ago
    const expectedStatus2 = RaceStateMachine.getExpectedStatus(lockedRace);
    if (expectedStatus2 !== 'IN_PROGRESS') {
      throw new Error(`Expected IN_PROGRESS, got ${expectedStatus2}`);
    }
    
    console.log('    ✅ Status computation works correctly');
    
    console.log('✅ Race State Machine tests passed!');
    
  } catch (error) {
    console.error('❌ Race State Machine tests failed:', error.message);
    throw error;
  }
}

async function testRaceTiming() {
  console.log('🧪 Testing Race Timing System...');
  
  try {
    // Test timing calculations
    console.log('  ✓ Testing timing calculations...');
    
    const race = createTestRace('OPEN');
    const timing = RaceStateMachine.getRaceTiming(race);
    
    if (timing.status !== 'OPEN') {
      throw new Error(`Expected OPEN status, got ${timing.status}`);
    }
    
    if (timing.nextTransition !== 'LOCKED') {
      throw new Error(`Expected next transition LOCKED, got ${timing.nextTransition}`);
    }
    
    if (timing.progress < 0 || timing.progress > 100) {
      throw new Error(`Invalid progress: ${timing.progress}`);
    }
    
    console.log('    ✅ Timing calculations work correctly');
    
    // Test timer stats
    console.log('  ✓ Testing timer stats...');
    const stats = RaceTimer.getStats();
    
    if (typeof stats.isRunning !== 'boolean') {
      throw new Error('Invalid isRunning value');
    }
    
    if (!Array.isArray(stats.races)) {
      throw new Error('Invalid races array');
    }
    
    console.log('    ✅ Timer stats work correctly');
    
    console.log('✅ Race Timing System tests passed!');
    
  } catch (error) {
    console.error('❌ Race Timing System tests failed:', error.message);
    throw error;
  }
}

async function testRaceTransitions() {
  console.log('🧪 Testing Race Transitions...');
  
  try {
    // Create a test race
    const testRace = createTestRace('OPEN');
    sqliteDb.createRace(testRace);
    
    console.log(`  ✓ Created test race: ${testRace.id}`);
    
    // Test OPEN → LOCKED transition
    console.log('  ✓ Testing OPEN → LOCKED transition...');
    const lockedRace = await RaceStateMachine.transitionRace(testRace.id, 'LOCKED', 'test');
    
    if (lockedRace.status !== 'LOCKED') {
      throw new Error(`Expected LOCKED status, got ${lockedRace.status}`);
    }
    
    if (!lockedRace.lockedTs) {
      throw new Error('Missing lockedTs timestamp');
    }
    
    if (!lockedRace.runners.every(r => r.initialPriceUsd > 0)) {
      throw new Error('Missing baseline prices');
    }
    
    console.log('    ✅ OPEN → LOCKED transition successful');
    
    // Test LOCKED → IN_PROGRESS transition
    console.log('  ✓ Testing LOCKED → IN_PROGRESS transition...');
    const inProgressRace = await RaceStateMachine.transitionRace(testRace.id, 'IN_PROGRESS', 'test');
    
    if (inProgressRace.status !== 'IN_PROGRESS') {
      throw new Error(`Expected IN_PROGRESS status, got ${inProgressRace.status}`);
    }
    
    if (!inProgressRace.inProgressTs) {
      throw new Error('Missing inProgressTs timestamp');
    }
    
    console.log('    ✅ LOCKED → IN_PROGRESS transition successful');
    
    // Test IN_PROGRESS → SETTLED transition
    console.log('  ✓ Testing IN_PROGRESS → SETTLED transition...');
    const settledRace = await RaceStateMachine.transitionRace(testRace.id, 'SETTLED', 'test');
    
    if (settledRace.status !== 'SETTLED') {
      throw new Error(`Expected SETTLED status, got ${settledRace.status}`);
    }
    
    if (settledRace.winnerIndex === undefined) {
      throw new Error('Missing winner index');
    }
    
    console.log('    ✅ IN_PROGRESS → SETTLED transition successful');
    
    // Clean up
    sqliteDb.clearRaces();
    console.log('    ✅ Test race cleaned up');
    
    console.log('✅ Race Transitions tests passed!');
    
  } catch (error) {
    console.error('❌ Race Transitions tests failed:', error.message);
    throw error;
  }
}

async function testErrorRecovery() {
  console.log('🧪 Testing Error Recovery...');
  
  try {
    // Test reconciliation
    console.log('  ✓ Testing race reconciliation...');
    
    const stuckRace = createTestRace('OPEN', -TEST_CONFIG.OPEN_DURATION_MS - 1000);
    sqliteDb.createRace(stuckRace);
    
    const reconciledRace = await RaceStateMachine.reconcileRace(stuckRace);
    
    if (reconciledRace && reconciledRace.status !== stuckRace.status) {
      console.log(`    ✅ Reconciled race: ${stuckRace.status} → ${reconciledRace.status}`);
    } else {
      console.log('    ✅ No reconciliation needed');
    }
    
    // Clean up
    sqliteDb.clearRaces();
    
    console.log('✅ Error Recovery tests passed!');
    
  } catch (error) {
    console.error('❌ Error Recovery tests failed:', error.message);
    throw error;
  }
}

// Main test runner
async function runTests() {
  console.log('🚀 Starting Race Transition Tests...\n');
  
  try {
    await testStateMachine();
    console.log('');
    
    await testRaceTiming();
    console.log('');
    
    await testRaceTransitions();
    console.log('');
    
    await testErrorRecovery();
    console.log('');
    
    console.log('🎉 All tests passed! Race transition system is working correctly.');
    
  } catch (error) {
    console.error('💥 Tests failed:', error.message);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}

export {
  testStateMachine,
  testRaceTiming,
  testRaceTransitions,
  testErrorRecovery,
  runTests
};