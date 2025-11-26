#!/usr/bin/env node

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

function resolvePersistentDbPath() {
  const explicit = process.env.DB_PATH && process.env.DB_PATH.trim();
  const appSlug = process.env.REPL_SLUG || process.env.APP_NAME || 'pump-racers';
  const candidates = [
    explicit,
    `/data/${appSlug}.db`,
    `/data/pump-racers.db`,
    `/mnt/data/${appSlug}.db`,
    `/mnt/data/pump-racers.db`,
    path.join(process.cwd(), 'data', 'pump-racers.db'),
    `/home/runner/${appSlug}.db`,
    path.join(process.cwd(), 'pump-racers.db'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const dir = path.dirname(candidate);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const test = new Database(candidate);
      test.close();
      return candidate;
    } catch {}
  }
  return path.join(process.cwd(), 'pump-racers.db');
}

// Use the same path resolution as the main app
const dbPath = resolvePersistentDbPath();

console.log('🔍 Testing database persistence...');
console.log(`Database path: ${dbPath}`);

// Ensure directory exists
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

try {
  // Open database
  const db = new Database(dbPath);
  
  // Set pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  
  // Create a test table
  db.exec(`
    CREATE TABLE IF NOT EXISTS persistence_test (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  
  // Insert test data
  const stmt = db.prepare('INSERT INTO persistence_test (test_value, created_at) VALUES (?, ?)');
  const testValue = `Test at ${new Date().toISOString()}`;
  stmt.run(testValue, Date.now());
  
  console.log(`✅ Inserted test value: ${testValue}`);
  
  // Read back data
  const data = db.prepare('SELECT * FROM persistence_test ORDER BY created_at DESC LIMIT 5').all();
  console.log(`📊 Current test records: ${data.length}`);
  data.forEach(row => {
    console.log(`  - ID: ${row.id}, Value: ${row.test_value}, Created: ${new Date(row.created_at).toISOString()}`);
  });
  
  // Force checkpoint
  console.log('\n💾 Forcing checkpoint...');
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('Checkpoint result:', checkpoint);
  
  // Check table count
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  console.log(`\n📋 Tables in database: ${tables.length}`);
  tables.forEach(t => console.log(`  - ${t.name}`));
  
  // Close database
  db.close();
  
  // Check file sizes
  console.log('\n📏 File sizes after checkpoint:');
  const stats = fs.statSync(dbPath);
  console.log(`Main DB: ${(stats.size / 1024).toFixed(2)} KB`);
  
  if (fs.existsSync(dbPath + '-wal')) {
    const walStats = fs.statSync(dbPath + '-wal');
    console.log(`WAL: ${(walStats.size / 1024).toFixed(2)} KB`);
  }
  
  console.log('\n✅ Database persistence test completed!');
  
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}