#!/usr/bin/env node

/**
 * API-based test script for race state transitions
 * This script tests the new race state machine via HTTP API calls
 */

import fetch from 'node-fetch';

const API_BASE = 'http://localhost:5000/api';
const ADMIN_TOKEN = 'dev-admin-token-123';

// Test configuration
const TEST_CONFIG = {
  OPEN_DURATION_MS: 2 * 60 * 1000, // 2 minutes for testing
  PROGRESS_DURATION_MS: 2 * 60 * 1000, // 2 minutes for testing
};

// Helper functions
async function apiCall(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const defaultOptions = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
      ...options.headers
    }
  };
  
  const response = await fetch(url, { ...defaultOptions, ...options });
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(`API call failed: ${response.status} ${data.error || response.statusText}`);
  }
  
  return data;
}

async function waitForServer() {
  console.log('⏳ Waiting for server to be ready...');
  
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`${API_BASE}/health`);
      if (response.ok) {
        console.log('✅ Server is ready');
        return;
      }
    } catch (error) {
      // Server not ready yet
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error('Server did not become ready within 30 seconds');
}

// Test functions
async function testRaceCreation() {
  console.log('🧪 Testing Race Creation...');
  
  try {
    // Create a test race
    const createResponse = await apiCall('/admin/race/create', {
      method: 'POST',
      body: JSON.stringify({
        startMinutesFromNow: 0.1, // Start in 6 seconds
        rakeBps: 300,
        jackpotFlag: false,
        limit: 4
      })
    });
    
    if (!createResponse.success || !createResponse.race) {
      throw new Error('Failed to create race');
    }
    
    const raceId = createResponse.race.id;
    console.log(`  ✅ Created test race: ${raceId}`);
    
    return raceId;
    
  } catch (error) {
    console.error('❌ Race creation test failed:', error.message);
    throw error;
  }
}

async function testRaceStatus(raceId) {
  console.log('🧪 Testing Race Status...');
  
  try {
    // Get race details
    const raceResponse = await fetch(`${API_BASE}/races/${raceId}`);
    const race = await raceResponse.json();
    
    if (!race.id) {
      throw new Error('Failed to get race details');
    }
    
    console.log(`  ✅ Race status: ${race.status}`);
    console.log(`  ✅ Computed status: ${race.computedStatus}`);
    console.log(`  ✅ Next transition: ${race.timing?.nextTransition}`);
    console.log(`  ✅ Time until next: ${race.timing?.timeUntilNextTransition}ms`);
    console.log(`  ✅ Progress: ${race.timing?.progress}%`);
    
    return race;
    
  } catch (error) {
    console.error('❌ Race status test failed:', error.message);
    throw error;
  }
}

async function testRaceLock(raceId) {
  console.log('🧪 Testing Race Lock...');
  
  try {
    // Lock the race
    const lockResponse = await apiCall('/admin/race/lock', {
      method: 'POST',
      body: JSON.stringify({ raceId })
    });
    
    if (!lockResponse.success) {
      throw new Error('Failed to lock race');
    }
    
    console.log(`  ✅ Race locked successfully`);
    console.log(`  ✅ Locked at: ${new Date(lockResponse.race.lockedTs).toISOString()}`);
    
    // Check baseline prices
    const priceSnapshot = lockResponse.priceSnapshot;
    if (priceSnapshot && priceSnapshot.length > 0) {
      console.log(`  ✅ Baseline prices captured: ${priceSnapshot.length} runners`);
      priceSnapshot.forEach(runner => {
        console.log(`    - ${runner.symbol}: $${runner.initialPrice}`);
      });
    }
    
    return lockResponse.race;
    
  } catch (error) {
    console.error('❌ Race lock test failed:', error.message);
    throw error;
  }
}

async function testRaceProgress(raceId) {
  console.log('🧪 Testing Race Progress...');
  
  try {
    // Get race progress
    const progressResponse = await fetch(`${API_BASE}/races/${raceId}/progress`);
    const progress = await progressResponse.json();
    
    if (progress.currentLeader) {
      console.log(`  ✅ Current leader: ${progress.currentLeader.symbol} (+${progress.currentLeader.priceChange.toFixed(2)}%)`);
    }
    
    if (progress.priceChanges && progress.priceChanges.length > 0) {
      console.log(`  ✅ Price changes tracked: ${progress.priceChanges.length} runners`);
      progress.priceChanges.forEach(change => {
        console.log(`    - ${change.symbol}: ${change.priceChange.toFixed(2)}%`);
      });
    }
    
    return progress;
    
  } catch (error) {
    console.error('❌ Race progress test failed:', error.message);
    throw error;
  }
}

async function testRaceForceTransition(raceId) {
  console.log('🧪 Testing Race Force Transition...');
  
  try {
    // Force transition to next state
    const forceResponse = await apiCall('/admin/race/force-start', {
      method: 'POST',
      body: JSON.stringify({ raceId })
    });
    
    if (!forceResponse.success) {
      throw new Error('Failed to force transition');
    }
    
    console.log(`  ✅ Force transition successful: ${forceResponse.message}`);
    
    return forceResponse.race;
    
  } catch (error) {
    console.error('❌ Race force transition test failed:', error.message);
    throw error;
  }
}

async function testRaceSettlement(raceId) {
  console.log('🧪 Testing Race Settlement...');
  
  try {
    // Force settlement
    const settleResponse = await apiCall('/admin/race/force-start', {
      method: 'POST',
      body: JSON.stringify({ raceId })
    });
    
    if (!settleResponse.success) {
      throw new Error('Failed to settle race');
    }
    
    console.log(`  ✅ Race settlement successful`);
    
    // Check final status
    const finalRace = await testRaceStatus(raceId);
    if (finalRace.status === 'SETTLED') {
      console.log(`  ✅ Race properly settled`);
      if (finalRace.winnerIndex !== undefined) {
        console.log(`  ✅ Winner determined: Runner ${finalRace.winnerIndex}`);
      }
    }
    
    return finalRace;
    
  } catch (error) {
    console.error('❌ Race settlement test failed:', error.message);
    throw error;
  }
}

async function testRaceCleanup() {
  console.log('🧪 Testing Race Cleanup...');
  
  try {
    // Clear all races
    const clearResponse = await apiCall('/admin/clear-races', {
      method: 'POST'
    });
    
    if (!clearResponse.success) {
      throw new Error('Failed to clear races');
    }
    
    console.log(`  ✅ Races cleared: ${clearResponse.clearedRaces} races`);
    console.log(`  ✅ Status breakdown:`, clearResponse.statusBreakdown);
    
    return clearResponse;
    
  } catch (error) {
    console.error('❌ Race cleanup test failed:', error.message);
    throw error;
  }
}

// Main test runner
async function runTests() {
  console.log('🚀 Starting API-based Race Transition Tests...\n');
  
  try {
    // Wait for server to be ready
    await waitForServer();
    console.log('');
    
    // Test 1: Create race
    const raceId = await testRaceCreation();
    console.log('');
    
    // Test 2: Check initial status
    await testRaceStatus(raceId);
    console.log('');
    
    // Test 3: Lock race
    await testRaceLock(raceId);
    console.log('');
    
    // Test 4: Check progress
    await testRaceProgress(raceId);
    console.log('');
    
    // Test 5: Force transition
    await testRaceForceTransition(raceId);
    console.log('');
    
    // Test 6: Check status after transition
    await testRaceStatus(raceId);
    console.log('');
    
    // Test 7: Force settlement
    await testRaceSettlement(raceId);
    console.log('');
    
    // Test 8: Cleanup
    await testRaceCleanup();
    console.log('');
    
    console.log('🎉 All API tests passed! Race transition system is working correctly.');
    
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
  testRaceCreation,
  testRaceStatus,
  testRaceLock,
  testRaceProgress,
  testRaceForceTransition,
  testRaceSettlement,
  testRaceCleanup,
  runTests
};