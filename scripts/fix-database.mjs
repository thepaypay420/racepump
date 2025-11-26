#!/usr/bin/env node

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Database path
const dbPath = path.join(process.cwd(), 'data', 'pump-racers.db');
const walPath = dbPath + '-wal';
const shmPath = dbPath + '-shm';

console.log('🔍 Checking database files...');
console.log(`Database path: ${dbPath}`);
console.log(`WAL exists: ${fs.existsSync(walPath)}`);
console.log(`SHM exists: ${fs.existsSync(shmPath)}`);
console.log(`Main DB exists: ${fs.existsSync(dbPath)}`);

// Ensure directory exists
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
  console.log(`✅ Created directory: ${dir}`);
}

try {
  // Open database (this will create it if it doesn't exist)
  console.log('\n📂 Opening database...');
  const db = new Database(dbPath);
  
  // Set pragmas for better persistence
  console.log('\n⚙️ Setting database pragmas...');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 1000'); // Checkpoint every 1000 pages
  
  // Force a checkpoint to ensure data is written to main database file
  console.log('\n💾 Forcing WAL checkpoint...');
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('Checkpoint result:', checkpoint);
  
  // Get some stats
  const tableCount = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'").get();
  console.log(`\n📊 Database has ${tableCount.count} tables`);
  
  // List tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log('Tables:', tables.map(t => t.name).join(', '));
  
  // Check some row counts
  for (const table of tables) {
    try {
      const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
      console.log(`- ${table.name}: ${count.count} rows`);
    } catch (e) {
      console.log(`- ${table.name}: Error counting rows`);
    }
  }
  
  // Close properly
  db.close();
  console.log('\n✅ Database closed properly');
  
  // Check file sizes after
  console.log('\n📏 Final file sizes:');
  if (fs.existsSync(dbPath)) {
    const stats = fs.statSync(dbPath);
    console.log(`Main DB: ${(stats.size / 1024).toFixed(2)} KB`);
  }
  if (fs.existsSync(walPath)) {
    const stats = fs.statSync(walPath);
    console.log(`WAL: ${(stats.size / 1024).toFixed(2)} KB`);
  }
  if (fs.existsSync(shmPath)) {
    const stats = fs.statSync(shmPath);
    console.log(`SHM: ${(stats.size / 1024).toFixed(2)} KB`);
  }
  
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}

console.log('\n✅ Database fix completed successfully!');