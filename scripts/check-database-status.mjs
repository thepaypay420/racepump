#!/usr/bin/env node

/**
 * Database Status Checker
 * Verifies DATABASE_URL is set and that all tables exist
 */

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

async function checkDatabaseStatus() {
  console.log('🔍 Checking Database Status...\n');
  
  // Check if DATABASE_URL is set
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL is NOT set!');
    console.error('');
    console.error('Please set DATABASE_URL in one of these ways:');
    console.error('1. Replit Secrets: Tools → Secrets → Add DATABASE_URL');
    console.error('2. .env file: DATABASE_URL=postgres://...');
    console.error('3. Environment variable: export DATABASE_URL=postgres://...');
    console.error('');
    process.exit(1);
  }
  
  console.log('✅ DATABASE_URL is set');
  
  // Redact password for display
  try {
    const url = new URL(DATABASE_URL);
    url.password = '***';
    console.log(`   Connection: ${url.toString()}`);
  } catch {}
  
  console.log('');
  
  // Try to connect
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log('🔌 Testing connection...');
    await pool.query('SELECT 1');
    console.log('✅ Connection successful\n');
    
    // Check for required tables
    const requiredTables = [
      'treasury',
      'races',
      'bets',
      'user_stats',
      'user_race_results',
      'recent_winners',
      'settlement_transfers',
      'referral_users',
      'referral_attributions',
      'referral_rewards',
      'referral_settings',
      'seen_tx'
    ];
    
    console.log('📋 Checking tables...\n');
    
    let allTablesExist = true;
    for (const table of requiredTables) {
      const result = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        )`,
        [table]
      );
      
      const exists = result.rows[0].exists;
      const status = exists ? '✅' : '❌';
      console.log(`${status} ${table}`);
      
      if (!exists) {
        allTablesExist = false;
      }
    }
    
    console.log('');
    
    if (!allTablesExist) {
      console.error('⚠️  Some tables are missing!');
      console.error('');
      console.error('To create missing tables, run:');
      console.error('  npm run db:migrate');
      console.error('');
      console.error('Or if that fails, run:');
      console.error('  npx tsx scripts/sql-migrations.ts');
      console.error('');
      process.exit(1);
    }
    
    // Check treasury contents
    console.log('🏦 Checking treasury...\n');
    const treasuryResult = await pool.query('SELECT * FROM treasury WHERE state = $1', ['main']);
    
    if (treasuryResult.rows.length === 0) {
      console.log('⚠️  Treasury record does not exist - will be created on first server start');
    } else {
      const treasury = treasuryResult.rows[0];
      console.log('✅ Treasury initialized');
      console.log(`   RACE Jackpot: ${treasury.jackpot_balance || '0'}`);
      console.log(`   SOL Jackpot: ${treasury.jackpot_balance_sol || '0'}`);
      console.log(`   Race Mint: ${treasury.race_mint || '(not set)'}`);
      console.log(`   Maintenance Mode: ${treasury.maintenance_mode ? 'ON' : 'OFF'}`);
    }
    
    console.log('');
    
    // Count records
    console.log('📊 Record counts:\n');
    const counts = await Promise.all([
      pool.query('SELECT COUNT(*) FROM races'),
      pool.query('SELECT COUNT(*) FROM bets'),
      pool.query('SELECT COUNT(*) FROM user_stats'),
      pool.query('SELECT COUNT(*) FROM user_race_results'),
      pool.query('SELECT COUNT(*) FROM recent_winners')
    ]);
    
    console.log(`   Races: ${counts[0].rows[0].count}`);
    console.log(`   Bets: ${counts[1].rows[0].count}`);
    console.log(`   Users: ${counts[2].rows[0].count}`);
    console.log(`   Results: ${counts[3].rows[0].count}`);
    console.log(`   Recent Winners: ${counts[4].rows[0].count}`);
    
    console.log('');
    console.log('✅ Database is fully configured and ready!');
    console.log('');
    console.log('You can now start the server:');
    console.log('  npm start      (production)');
    console.log('  npm run dev    (development)');
    console.log('');
    
  } catch (error) {
    console.error('❌ Database error:', error.message);
    console.error('');
    
    if (error.code === 'ENOTFOUND') {
      console.error('The database host could not be found.');
      console.error('Please check your DATABASE_URL.');
    } else if (error.code === '28P01') {
      console.error('Authentication failed.');
      console.error('Please check your username and password in DATABASE_URL.');
    } else if (error.message.includes('does not exist')) {
      console.error('One or more tables do not exist.');
      console.error('Run migrations with: npm run db:migrate');
    }
    
    console.error('');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

checkDatabaseStatus();
