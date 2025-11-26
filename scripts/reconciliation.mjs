#!/usr/bin/env node
// Simple reconciliation fetcher (devnet/staging): prints ledger vs on-chain balances

import fetch from 'node-fetch';

async function main() {
  const adminToken = process.env.ADMIN_TOKEN || 'dev-admin-token-123';
  const url = new URL('/api/admin/reconciliation', 'http://localhost:3000');
  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${adminToken}` } });
  if (!resp.ok) {
    console.error('Failed to fetch reconciliation:', await resp.text());
    process.exit(1);
  }
  const data = await resp.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
