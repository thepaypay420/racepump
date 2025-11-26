#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// Reuse same resolution logic as server/db.ts
function resolvePersistentDbPath() {
  const explicit = process.env.DB_PATH && process.env.DB_PATH.trim();
  const appSlug = process.env.REPL_SLUG || process.env.APP_NAME || 'pump-racers';
  const candidates = [
    explicit,
    `/data/${appSlug}.db`,
    `/data/pump-racers.db`,
    `/home/runner/${appSlug}.db`,
    path.join(process.cwd(), 'data', 'pump-racers.db'),
    path.join(process.cwd(), 'pump-racers.db'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return path.join(process.cwd(), 'pump-racers.db');
}

async function ensureDirOrFallback(preferredDir, fallbacks) {
  const candidates = [preferredDir, ...fallbacks].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (!dir) continue;
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (e) {
      // Permission denied or other error; try next
      continue;
    }
  }
  return null;
}

async function main() {
  try {
    const dbPath = resolvePersistentDbPath();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    const envDir = (process.env.BACKUP_DIR || '').trim() || null;
    const dbDir = dbPath ? path.dirname(dbPath) : null;
    const cwdDefault = path.join(process.cwd(), 'backups');
    const tmpDefault = path.join('/tmp', 'pump-racers', 'backups');

    const outDir = await ensureDirOrFallback(envDir, [cwdDefault, dbDir && path.join(dbDir, 'backups'), tmpDefault]);
    if (!outDir) {
      console.error('⚠️ Could not create any backup directory; skipping backup.');
      return;
    }

    // Raw file copy (best-effort)
    const copyPath = path.join(outDir, `sqlite-${ts}.db`);
    try {
      fs.copyFileSync(dbPath, copyPath);
      console.log(`✅ Copied SQLite file to ${copyPath}`);
    } catch (e) {
      console.error('⚠️ Failed to copy SQLite file:', e?.message || e);
    }

    // Lightweight JSON export for key tables (best-effort)
    try {
      const mod = await import('better-sqlite3');
      const Database = mod.default || mod;
      const db = new Database(dbPath, { readonly: true });
      const tables = ['races', 'bets', 'claims', 'user_race_results', 'user_stats', 'treasury', 'settlement_transfers', 'settlement_errors'];
      const dump = {};
      for (const t of tables) {
        try {
          dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
        } catch {
          dump[t] = [];
        }
      }
      db.close();
      const jsonPath = path.join(outDir, `export-${ts}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(dump, null, 2));
      console.log(`✅ Exported tables to ${jsonPath}`);
    } catch (e) {
      console.error('⚠️ JSON export failed:', e?.message || e);
    }
  } catch (e) {
    // Never fail the process due to backup issues
    console.error('⚠️ Backup script encountered an error:', e?.message || e);
  }
}

// Run
main();

