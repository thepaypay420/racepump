import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a persistent, writable SQLite file path across deploy targets.
 * - Respects explicit DB_PATH if it points to a writable directory
 * - Otherwise tries known persistent mounts, then project-local fallback
 * - Prints a single boot log line for observability and sets process.env.DB_PATH
 */
let lastResolvedPath: string | null = null;

function sanitizeExplicitPath(p: string | undefined | null, appSlug: string): string | '' {
  const raw = (p || '').trim();
  if (!raw) return '';
  // If someone set DB_PATH to something like '/data/.db' or just '/data', rewrite to '/data/<slug>.db'
  try {
    const dir = raw.endsWith('/') ? raw.slice(0, -1) : path.dirname(raw);
    let base = raw.endsWith('/') ? '' : path.basename(raw);
    if (!base || base === '.db' || base === '.') {
      base = `${appSlug}.db`;
    } else if (!base.endsWith('.db')) {
      base = `${base}.db`;
    }
    return path.join(dir || '/data', base);
  } catch {
    return '';
  }
}

export function resolvePersistentSqlitePath(opts?: { silent?: boolean }): string {
  const silent = !!opts?.silent;
  const appSlug = process.env.REPL_SLUG || process.env.APP_NAME || 'pump-racers';

  // If already resolved in this process and env is set, return it
  const envExisting = (process.env.DB_PATH || '').trim();
  if (envExisting && lastResolvedPath === envExisting) {
    return envExisting;
  }

  // Respect explicit path if valid; sanitize obvious mistakes
  const explicitSanitized = sanitizeExplicitPath(envExisting, appSlug);

  const candidates = [
    explicitSanitized || undefined,
    `/mnt/data/pump-racers.db`,
    `/data/pump-racers.db`,
    `/mnt/data/${appSlug}.db`,
    `/data/${appSlug}.db`,
    // Project-local fallbacks
    path.join(process.cwd(), 'data', 'pump-racers.db'),
    path.join(process.cwd(), 'pump-racers.db')
  ].filter(Boolean) as string[];

  const pickWritablePath = (): string => {
    for (const candidate of candidates) {
      try {
        const dir = path.dirname(candidate);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        // Probe writability of the directory
        const probe = path.join(dir, `.db-write-probe-${Date.now()}`);
        fs.writeFileSync(probe, 'ok');
        try { fs.rmSync(probe); } catch {}
        return candidate;
      } catch {
        // try next candidate
        continue;
      }
    }
    // As a last resort, fall back to CWD
    const fallback = path.join(process.cwd(), 'pump-racers.db');
    try { fs.mkdirSync(path.dirname(fallback), { recursive: true }); } catch {}
    return fallback;
  };

  const resolved = pickWritablePath();

  // Best-effort: touch the file so it exists on disk for visibility
  try { if (!fs.existsSync(resolved)) { fs.writeFileSync(resolved, ''); } } catch {}

  // Only log when the resolved path changes to reduce duplicates
  const changed = resolved !== lastResolvedPath;
  lastResolvedPath = resolved;
  process.env.DB_PATH = resolved;
  if (!silent && changed) {
    try { console.log(`📁 Using persistent SQLite path: ${resolved}`); } catch {}
  }
  return resolved;
}
