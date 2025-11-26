#!/usr/bin/env node
// Tests maintenance mode and feature flags behavior (devnet-only)
import fetch from 'node-fetch';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token-123';

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body || {})
  });
  return res;
}

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  return res;
}

async function main() {
  console.log('== Maintenance tests ==');

  // 1) Enable maintenance
  let res = await post('/api/admin/maintenance', { mode: true, message: 'Upgrading' }, { Authorization: `Bearer ${ADMIN_TOKEN}` });
  console.log('enable maintenance:', res.status);
  if (!res.ok) throw new Error(`Failed to enable maintenance: ${res.status}`);

  // 2) Attempt to create a race (should be blocked)
  res = await post('/api/admin/race/create', { startTs: Date.now() + 2*60*1000, rakeBps: 300, jackpotFlag: false, limit: 6 }, { Authorization: `Bearer ${ADMIN_TOKEN}` });
  if (res.status !== 503) {
    console.warn('Expected 503 when creating race under maintenance, got', res.status);
  } else {
    console.log('  ✓ Creating race blocked under maintenance');
  }

  // 3) Optional BLOCK_NEW_BETS env gate check (if server enabled)
  res = await post('/api/bet', { }, {});
  if (process.env.EXPECT_BLOCK_NEW_BETS === '1') {
    if (res.status === 503) console.log('  ✓ BLOCK_NEW_BETS gate active');
    else console.warn('  ⚠️ Expected /api/bet 503 when BLOCK_NEW_BETS=1; got', res.status);
  } else {
    console.log('  (skip bet gate assertion; EXPECT_BLOCK_NEW_BETS not set)');
  }

  // 4) Disable maintenance
  res = await post('/api/admin/maintenance', { mode: false }, { Authorization: `Bearer ${ADMIN_TOKEN}` });
  console.log('disable maintenance:', res.status);
  if (!res.ok) throw new Error(`Failed to disable maintenance: ${res.status}`);

  console.log('Done');
}

main().catch((e) => { console.error(e); process.exit(1); });
