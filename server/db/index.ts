import { Pool } from 'pg';

function isTruthy(v: string | undefined | null): boolean {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^@]*@/, '//***@');
  }
}

export function selectedDatabase(): 'postgres' | 'sqlite' {
  const forcePg = isTruthy(process.env.FORCE_PG);
  const hasDbUrl = !!(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  return (forcePg || isProd || hasDbUrl) ? 'postgres' : 'sqlite';
}

export async function getDbDiagnostics(): Promise<{
  selected: 'postgres' | 'sqlite';
  postgres?: { ready: boolean; usedKey: string | null; connection: string | null; user_stats_count?: number; user_race_results_count?: number; recent_winners_count?: number; bets_count?: number };
  sqlite?: { path?: string; user_stats_count?: number; user_race_results_count?: number; recent_winners_count?: number; bets_count?: number };
  env?: { DATABASE_URL: boolean; PGHOST: boolean };
}> {
  const sel = selectedDatabase();

  if (sel === 'postgres') {
    // Create a one-off PG pool (no SQLite import here)
    let usedKey: string | null = null;
    let connection: string | null = null;
    const url = (process.env.DATABASE_URL || '').trim();
    if (url) {
      usedKey = 'DATABASE_URL';
      connection = redactConnectionString(url.includes('sslmode=') ? url : `${url}${url.includes('?') ? '&' : '?'}sslmode=require`);
    }
    const pool = new Pool({ connectionString: url || undefined, ssl: { rejectUnauthorized: false } } as any);
    const diag: any = { 
      selected: 'postgres' as const, 
      postgres: { ready: false, usedKey, connection }, 
      sqlite: { path: '', user_stats_count: 0, user_race_results_count: 0, recent_winners_count: 0, bets_count: 0 },
      env: { DATABASE_URL: !!process.env.DATABASE_URL, PGHOST: !!process.env.PGHOST } 
    };
    
    // Query Postgres counts
    try {
      await pool.query('SELECT 1');
      diag.postgres.ready = true;
      try {
        const r1 = await pool.query('SELECT COUNT(1) AS count FROM user_stats');
        diag.postgres.user_stats_count = Number(r1.rows?.[0]?.count || 0);
      } catch {}
      try {
        const r2 = await pool.query('SELECT COUNT(1) AS count FROM user_race_results');
        diag.postgres.user_race_results_count = Number(r2.rows?.[0]?.count || 0);
      } catch {}
      try {
        const r3 = await pool.query('SELECT COUNT(1) AS count FROM recent_winners');
        diag.postgres.recent_winners_count = Number(r3.rows?.[0]?.count || 0);
      } catch {}
      try {
        const r4 = await pool.query('SELECT COUNT(1) AS count FROM bets');
        diag.postgres.bets_count = Number(r4.rows?.[0]?.count || 0);
      } catch {}
    } catch (e) {
      console.error('❌ Postgres connection failed:', e);
      // Note: Do NOT exit here - this is just diagnostics
      // Actual connection enforcement happens in db.ts initPostgres
    } finally {
      try { await pool.end(); } catch {}
    }
    
    // ALSO query SQLite counts (dual-storage architecture - SQLite is hydrated cache)
    try {
      const mod: any = await import('../db');
      const sqliteDiag = await mod.getDbDiagnostics();
      if (sqliteDiag.sqlite) {
        diag.sqlite = sqliteDiag.sqlite;
      }
    } catch (e) {
      console.warn('⚠️ Failed to read SQLite diagnostics in Postgres mode:', e);
      // Keep default zero counts
    }
    
    return diag;
  }

  // Development SQLite: delegate to legacy db implementation
  try {
    const mod: any = await import('../db');
    const base = await mod.getDbDiagnostics();
    return { selected: 'sqlite', ...base };
  } catch {
    return { selected: 'sqlite', sqlite: { path: '', user_stats_count: 0, user_race_results_count: 0, recent_winners_count: 0, bets_count: 0 } } as any;
  }
}
