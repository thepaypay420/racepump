/*
 * One-shot SQLite → Postgres migration for PumpRacer receipts/leaderboard
 * - Introspects SQLite schema via PRAGMA table_info
 * - Creates equivalent tables in Postgres (best-effort type mapping)
 * - Copies rows in chunks with ON CONFLICT DO NOTHING
 * - Recreates basic indexes (best-effort)
 * - Idempotent and safe to re-run
 */

import Database from 'better-sqlite3';
import { Pool } from 'pg';

const DB_PATH = (process.env.DB_PATH || '/data/pump-racers.db').trim();
const DATABASE_URL = process.env.DATABASE_URL as string;
const TABLES = (process.env.MIGRATE_TABLES || 'receipts,recent_receipts,leaderboard')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Column type mapping from SQLite affinity to Postgres
function mapSqliteTypeToPg(sqliteType: string): string {
  const t = (sqliteType || '').toUpperCase();
  if (t.includes('INT')) return 'BIGINT';
  if (t.includes('REAL') || t.includes('DOUBLE') || t.includes('FLOAT')) return 'DOUBLE PRECISION';
  if (t.includes('TEXT') || t.includes('CHAR') || t.includes('CLOB') || t === '') return 'TEXT';
  if (t.includes('BLOB')) return 'BYTEA';
  if (t.includes('NUM')) return 'NUMERIC';
  return 'TEXT';
}

function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

async function main() {
  if (!DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  console.log('🔗 Opening SQLite at', DB_PATH);
  const sqlite = new Database(DB_PATH, { readonly: true });
  const pg = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } } as any);

  try {
    for (const table of TABLES) {
      console.log(`\n=== Migrating table: ${table} ===`);

      // Read columns from SQLite
      const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: any; pk: number }>;
      if (!columns || columns.length === 0) {
        console.warn(`- Skipping: table not found or has no columns in SQLite -> ${table}`);
        continue;
      }

      // Determine primary key columns (in order)
      const pkCols = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);

      // Create table in Postgres if missing
      const colDefs = columns.map(c => `${quoteIdent(c.name)} ${mapSqliteTypeToPg(c.type)}${c.notnull ? ' NOT NULL' : ''}`).join(', ');
      const pkClause = pkCols.length > 0 ? `, PRIMARY KEY (${pkCols.map(quoteIdent).join(', ')})` : '';
      const createSql = `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (${colDefs}${pkClause});`;
      await pg.query(createSql);
      console.log('- Ensured table exists in Postgres');

      // Build INSERT with ON CONFLICT DO NOTHING
      const colNames = columns.map(c => c.name);
      const insertSql = `INSERT INTO ${quoteIdent(table)} (${colNames.map(quoteIdent).join(', ')}) VALUES `;

      // Count rows
      const countRow = sqlite.prepare(`SELECT COUNT(1) AS c FROM ${quoteIdent(table)}`).get() as any;
      const total = Number(countRow?.c || 0);
      console.log(`- Rows to migrate: ${total}`);

      const chunkSize = 1000;
      let migrated = 0;

      for (let offset = 0; offset < total; offset += chunkSize) {
        const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`).all(chunkSize, offset) as any[];
        if (!rows.length) break;

        // Build parameterized multi-row insert
        const params: any[] = [];
        const valuesSql: string[] = [];
        let paramIndex = 1;
        for (const row of rows) {
          const placeholders = colNames.map(() => `$${paramIndex++}`);
          valuesSql.push(`(${placeholders.join(',')})`);
          for (const name of colNames) {
            params.push((row as any)[name] ?? null);
          }
        }

        let sql = insertSql + valuesSql.join(', ');
        if (pkCols.length > 0) {
          sql += ` ON CONFLICT (${pkCols.map(quoteIdent).join(', ')}) DO NOTHING`;
        } else {
          sql += ' ON CONFLICT DO NOTHING'; // should be ignored if no unique indexes
        }

        await pg.query(sql, params);
        migrated += rows.length;
        console.log(`  - Migrated ${migrated}/${total}`);
      }

      // Best-effort: copy basic indexes from SQLite
      try {
        const indexes = sqlite.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as Array<{ name: string; unique: number }>;
        for (const idx of indexes || []) {
          const idxInfo = sqlite.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as Array<{ name: string; seqno: number }>;
          const cols = idxInfo.sort((a, b) => a.seqno - b.seqno).map(c => c.name);
          const idxNamePg = `${table}_${cols.join('_')}_${idx.unique ? 'uniq' : 'idx'}`.replace(/[^a-zA-Z0-9_]/g, '_');
          const createIdxSql = `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdent(idxNamePg)} ON ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')});`;
          await pg.query(createIdxSql);
        }
        console.log('- Indexes recreated (best-effort)');
      } catch (e) {
        console.warn('- Index recreation skipped:', (e as any)?.message || e);
      }

      console.log(`✅ Finished migrating ${table}`);
    }
  } finally {
    await pg.end();
    sqlite.close();
  }

  console.log('\n🎉 Migration complete');
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
