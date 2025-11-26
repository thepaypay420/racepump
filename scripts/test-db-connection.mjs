#!/usr/bin/env node

/**
 * Quick test to verify database connection and table existence
 */

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

console.log('🔍 Testing Database Connection\n');

// Check DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ CRITICAL: DATABASE_URL is NOT set!\n');
  console.error('This is why you\'re getting "treasury does not exist" errors.\n');
  console.error('The server cannot connect to PostgreSQL without DATABASE_URL.\n');
  console.error('Set DATABASE_URL in Replit Secrets or .env file:\n');
  console.error('  DATABASE_URL=postgres://user:pass@host.neon.tech/dbname?sslmode=require\n');
  process.exit(1);
}

console.log('✅ DATABASE_URL is set\n');

// Test connection
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

try {
  console.log('🔌 Connecting to PostgreSQL...');
  await pool.query('SELECT 1');
  console.log('✅ Connection successful\n');
  
  // Check if treasury table exists
  console.log('🔍 Checking for treasury table...');
  const result = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'treasury'
    )
  `);
  
  const exists = result.rows[0].exists;
  
  if (!exists) {
    console.error('❌ Treasury table does NOT exist!\n');
    console.error('This is the root cause of your error.\n');
    console.error('Fix by running migrations:\n');
    console.error('  npm run db:migrate\n');
    console.error('Or start the server (migrations run automatically):\n');
    console.error('  npm start\n');
    process.exit(1);
  }
  
  console.log('✅ Treasury table exists\n');
  
  // Try to read treasury
  const treasuryResult = await pool.query('SELECT * FROM treasury WHERE state = $1', ['main']);
  
  if (treasuryResult.rows.length === 0) {
    console.log('⚠️  Treasury record empty - will be initialized on server start\n');
  } else {
    console.log('✅ Treasury initialized:');
    const t = treasuryResult.rows[0];
    console.log(`   Jackpot (RACE): ${t.jackpot_balance || '0'}`);
    console.log(`   Jackpot (SOL): ${t.jackpot_balance_sol || '0'}`);
    console.log(`   Race Mint: ${t.race_mint || '(not set)'}\n`);
  }
  
  console.log('✅ Database is ready! You can start the server.\n');
  
} catch (error) {
  console.error('❌ Database error:', error.message, '\n');
  
  if (error.message.includes('does not exist')) {
    console.error('Tables do not exist. Run migrations:\n');
    console.error('  npm run db:migrate\n');
  } else if (error.code === 'ENOTFOUND') {
    console.error('Database host not found. Check your DATABASE_URL.\n');
  } else if (error.code === '28P01') {
    console.error('Authentication failed. Check credentials in DATABASE_URL.\n');
  }
  
  process.exit(1);
} finally {
  await pool.end();
}
