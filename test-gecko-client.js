#!/usr/bin/env node

// Simple integration test for Gecko client coalescing and rate limiting

import { geckoGet, getGeckoStats } from './server/gecko-client.js';

async function testCoalescing() {
  console.log('🧪 Testing Gecko client coalescing...');
  const url = 'https://api.geckoterminal.com/api/v2/search/pools?query=So11111111111111111111111111111111111111112';

  const N = 10;
  const tasks = Array.from({ length: N }, () => geckoGet(url, { timeout: 10000, priority: 'low' }));
  const results = await Promise.allSettled(tasks);

  const successes = results.filter(r => r.status === 'fulfilled');
  const failures = results.filter(r => r.status === 'rejected');
  const stats = getGeckoStats();

  console.log('  results:', { successes: successes.length, failures: failures.length });
  console.log('  stats:', stats);

  if (successes.length === 0) {
    throw new Error('All requests failed');
  }
  if (stats.networkRequests > 3) {
    throw new Error(`Expected coalescing to reduce networkRequests (got ${stats.networkRequests})`);
  }
  console.log('✅ Coalescing appears to work (few network requests for many callers)');
}

async function run() {
  try {
    await testCoalescing();
    console.log('🎉 Gecko client tests passed');
  } catch (e) {
    console.error('💥 Gecko client tests failed:', e?.message || e);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}

