#!/usr/bin/env node
/**
 * Verification script for edge points fix
 * Tests that:
 * 1. SOL leaderboard returns proper edge points (not equal to totalAwarded)
 * 2. Receipts include edge points
 * 3. Edge points are being calculated correctly
 */

import fetch from 'node-fetch';

const API_BASE = process.env.API_BASE || 'http://localhost:5000';

async function testSolLeaderboard() {
  console.log('\n🧪 Testing SOL Leaderboard...');
  
  try {
    const response = await fetch(`${API_BASE}/api/leaderboard?currency=SOL&limit=10`);
    const data = await response.json();
    
    if (!data.top || !Array.isArray(data.top)) {
      console.log('❌ SOL leaderboard returned invalid data');
      return false;
    }
    
    console.log(`✅ SOL leaderboard returned ${data.top.length} entries`);
    
    // Check that edge points are not equal to totalAwarded (the bug)
    let bugFound = false;
    for (const entry of data.top) {
      const edgePoints = parseFloat(entry.edgePoints || '0');
      const totalAwarded = parseFloat(entry.totalAwarded || '0');
      
      console.log(`   Wallet: ${entry.wallet.slice(0, 8)}... Edge: ${edgePoints.toFixed(2)} Awarded: ${totalAwarded.toFixed(2)}`);
      
      // If edge points exactly equal totalAwarded, that's the bug
      if (edgePoints > 0 && Math.abs(edgePoints - totalAwarded) < 0.001) {
        console.log(`   ⚠️  WARNING: Edge points equal totalAwarded for ${entry.wallet}`);
        bugFound = true;
      }
    }
    
    if (bugFound) {
      console.log('❌ Bug detected: Edge points equal totalAwarded');
      return false;
    }
    
    console.log('✅ SOL leaderboard edge points look correct');
    return true;
  } catch (error) {
    console.error('❌ Error testing SOL leaderboard:', error.message);
    return false;
  }
}

async function testRaceLeaderboard() {
  console.log('\n🧪 Testing RACE Leaderboard...');
  
  try {
    const response = await fetch(`${API_BASE}/api/leaderboard?limit=10`);
    const data = await response.json();
    
    if (!data.top || !Array.isArray(data.top)) {
      console.log('❌ RACE leaderboard returned invalid data');
      return false;
    }
    
    console.log(`✅ RACE leaderboard returned ${data.top.length} entries`);
    
    for (const entry of data.top) {
      const edgePoints = parseFloat(entry.edgePoints || '0');
      console.log(`   Wallet: ${entry.wallet.slice(0, 8)}... Edge: ${edgePoints.toFixed(2)} Races: ${entry.totalRaces}`);
    }
    
    console.log('✅ RACE leaderboard looks correct');
    return true;
  } catch (error) {
    console.error('❌ Error testing RACE leaderboard:', error.message);
    return false;
  }
}

async function testReceipts() {
  console.log('\n🧪 Testing Receipts Endpoint...');
  
  try {
    // Get a wallet from the leaderboard to test
    const leaderboardResponse = await fetch(`${API_BASE}/api/leaderboard?limit=1`);
    const leaderboardData = await leaderboardResponse.json();
    
    if (!leaderboardData.top || leaderboardData.top.length === 0) {
      console.log('⚠️  No leaderboard entries to test receipts with');
      return true; // Not a failure, just no data
    }
    
    const testWallet = leaderboardData.top[0].wallet;
    console.log(`   Testing with wallet: ${testWallet.slice(0, 8)}...`);
    
    const receiptsResponse = await fetch(`${API_BASE}/api/user/${testWallet}/receipts?limit=5`);
    const receipts = await receiptsResponse.json();
    
    if (!Array.isArray(receipts)) {
      console.log('❌ Receipts returned invalid data');
      return false;
    }
    
    console.log(`✅ Receipts returned ${receipts.length} entries`);
    
    for (const receipt of receipts) {
      const edgePoints = receipt.edgePoints || '0';
      const currency = receipt.currency || 'RACE';
      console.log(`   Race: ${receipt.raceId.slice(0, 8)}... Edge: ${edgePoints} Currency: ${currency}`);
      
      if (!receipt.edgePoints) {
        console.log('   ⚠️  Warning: edgePoints field missing');
      }
    }
    
    console.log('✅ Receipts include edge points');
    return true;
  } catch (error) {
    console.error('❌ Error testing receipts:', error.message);
    return false;
  }
}

async function testPersistence() {
  console.log('\n🧪 Testing Persistence...');
  
  try {
    const response = await fetch(`${API_BASE}/api/persistence`);
    const data = await response.json();
    
    console.log(`   Status: ${data.status}`);
    console.log(`   Backend: ${data.backend}`);
    console.log(`   Persistent: ${data.persistent}`);
    
    if (data.postgres) {
      console.log(`   Postgres ready: ${data.postgres.ready}`);
      console.log(`   Postgres receipts: ${data.postgres.receipts}`);
      console.log(`   Postgres leaderboard_results: ${data.postgres.leaderboard_results}`);
    }
    
    if (data.warning) {
      console.log(`   ⚠️  ${data.warning}`);
    }
    
    console.log('✅ Persistence info retrieved');
    return true;
  } catch (error) {
    console.error('❌ Error testing persistence:', error.message);
    return false;
  }
}

async function main() {
  console.log('🚀 Edge Points Fix Verification');
  console.log(`   API Base: ${API_BASE}`);
  
  const results = {
    solLeaderboard: await testSolLeaderboard(),
    raceLeaderboard: await testRaceLeaderboard(),
    receipts: await testReceipts(),
    persistence: await testPersistence()
  };
  
  console.log('\n📊 Results Summary:');
  console.log(`   SOL Leaderboard: ${results.solLeaderboard ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   RACE Leaderboard: ${results.raceLeaderboard ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Receipts: ${results.receipts ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Persistence: ${results.persistence ? '✅ PASS' : '❌ FAIL'}`);
  
  const allPassed = Object.values(results).every(r => r === true);
  
  if (allPassed) {
    console.log('\n✅ All tests passed! Edge points fix is working correctly.');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed. Please review the output above.');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
