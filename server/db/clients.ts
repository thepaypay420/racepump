import { Pool } from 'pg';

// Postgres pool using DATABASE_URL (Neon)
export const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } } as any);

// Feature flag for receipts/leaderboard backend
const backend = (process.env.RECEIPTS_BACKEND || '').toLowerCase();
export const usePgForReceipts = backend === 'pg' || backend === 'postgres' || backend === 'postgresql';

if (usePgForReceipts) {
  console.log('Using Postgres for receipts/leaderboard');
}
