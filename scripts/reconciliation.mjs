#!/usr/bin/env node
// Simple reconciliation fetcher (devnet/staging): prints ledger vs on-chain balances

import fetch from 'node-fetch';

async function main() {
  // SECURITY: Require ADMIN_TOKEN from environment; only allow dev default for localhost
  const isLocalhost = process.env.API_URL?.includes('localhost') || process.env.API_URL?.includes('127.0.0.1') || !process.env.API_URL;
  const adminToken = process.env.ADMIN_TOKEN || (isLocalhost ? 'dev-admin-token-123' : null);
  
  if (!adminToken) {
    console.error('❌ ERROR: ADMIN_TOKEN environment variable is required');
    console.error('   Set ADMIN_TOKEN in your environment or use API_URL=http://localhost:3000 for dev');
    process.exit(1);
  }
  
  const url = new URL('/api/admin/reconciliation', process.env.API_URL || 'http://localhost:3000');
  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${adminToken}` } });
  if (!resp.ok) {
    console.error('Failed to fetch reconciliation:', await resp.text());
    process.exit(1);
  }
  const data = await resp.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
