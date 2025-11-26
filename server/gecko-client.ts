import NodeCache from "node-cache";

/**
 * Shared GeckoTerminal HTTP client with:
 * - Global rate limiting (token bucket, ~30 req/min default)
 * - Priority scheduling with request coalescing (dedupe identical in-flight URLs)
 * - Endpoint-aware response caching + per-mint price cache to dedupe across races
 * - Backoff on 429 with Retry-After support
 */

// Environment-configurable limits
const ENV: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
const MAX_REQUESTS_PER_MINUTE = Number(ENV.GECKO_RPM ?? 30);
const MIN_TIME_MS = Math.ceil(60000 / Math.max(1, MAX_REQUESTS_PER_MINUTE)); // gap between requests
const CONCURRENCY = Number(ENV.GECKO_CONCURRENCY ?? 1); // keep low to be polite
const GT_LOG = ENV.GT_LOG === "1";

// Global scheduling state
let inFlight = 0;
// Three priority queues: 0 = high, 1 = normal, 2 = low
const queues: Array<Array<() => void>> = [[], [], []];

// Backoff state when 429 seen
let backoffUntil = 0;

type Priority = 0 | 1 | 2; // 0=high 1=normal 2=low

// In-flight request coalescing by final URL
const inFlightRequests = new Map<string, Promise<any>>();

// Lightweight response cache for non-price endpoints (price caching handled separately below)
const responseCache = new NodeCache({ stdTTL: 10 });

// Stats for observability in tests and logs
const geckoStats = {
  cacheHits: 0,
  cacheMisses: 0,
  coalescedJoins: 0,
  networkRequests: 0
};

function schedule<T>(task: () => Promise<T>, priority: Priority = 1): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      // Honor 429 backoff gate
      const now = Date.now();
      if (now < backoffUntil) {
        const delay = backoffUntil - now + 10;
        setTimeout(() => queues[priority].push(run), delay);
        next();
        return;
      }

      inFlight++;
      try {
        const result = await task();
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        setTimeout(() => {
          inFlight--;
          next();
        }, MIN_TIME_MS);
      }
    };

    queues[priority].push(run);
    next();
  });
}

function next() {
  while (inFlight < CONCURRENCY) {
    const q = queues.find(q => q.length > 0);
    if (!q) break;
    const fn = q.shift();
    if (fn) fn(); else break;
  }
}

type GetConfig = {
  timeout?: number;
  headers?: Record<string, string>;
  params?: Record<string, any>;
  priority?: "high" | "normal" | "low";
  cacheTtlSeconds?: number; // override inferred TTL
  skipCache?: boolean; // force network (still coalesces)
};

function toPriority(p?: "high" | "normal" | "low"): Priority {
  if (p === "high") return 0;
  if (p === "low") return 2;
  return 1; // default normal
}

function inferCacheTtlSeconds(finalUrl: string): number {
  try {
    const u = new URL(finalUrl);
    const path = u.pathname;
    if (path.includes("/trending_pools")) return 20; // rotate often, but ok to cache briefly
    if (path.includes("/ohlcv/")) return 60; // minute bars fine for 60s
    if (path.includes("/search/pools")) return 300; // discovery/meta
    if (path.includes("/pools/")) return 10; // pool detail
  } catch {}
  return 0; // default: no responseCache unless specified
}

export async function geckoGet<T = any>(url: string, config: GetConfig = {}): Promise<T> {
  // Build final URL (used for coalescing and response caching)
  let finalUrl = url;
  if (config.params && Object.keys(config.params).length > 0) {
    const u = new URL(url);
    Object.entries(config.params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    });
    finalUrl = u.toString();
  }

  // Response cache layer (non-price endpoints)
  const ttlOverride = config.cacheTtlSeconds;
  const inferredTtl = ttlOverride ?? inferCacheTtlSeconds(finalUrl);
  if (!config.skipCache && inferredTtl > 0) {
    const cached = responseCache.get<T>(finalUrl);
    if (cached !== undefined) {
      geckoStats.cacheHits++;
      if (GT_LOG) console.log(`[GT] cache HIT ${finalUrl}`);
      return cached;
    }
    geckoStats.cacheMisses++;
    if (GT_LOG) console.log(`[GT] cache MISS ${finalUrl}`);
  }

  // Coalesce identical in-flight requests
  const inFlightExisting = inFlightRequests.get(finalUrl);
  if (inFlightExisting) {
    geckoStats.coalescedJoins++;
    if (GT_LOG) console.log(`[GT] coalesce JOIN ${finalUrl}`);
    return inFlightExisting as Promise<T>;
  }

  const exec = async () => {
    try {
      const controller = new AbortController();
      const timeoutMs = config.timeout ?? 15000;
      const to = setTimeout(() => controller.abort(), timeoutMs);
      geckoStats.networkRequests++;
      if (GT_LOG) console.log(`[GT] GET ${finalUrl}`);
      const resp = await fetch(finalUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "PumpRacers/1.0",
          ...(config.headers || {})
        },
        signal: controller.signal
      });
      clearTimeout(to);
      if (resp.status === 429) {
        const retryAfterHeader = resp.headers.get("retry-after");
        const now = Date.now();
        let retryMs = 5000;
        if (retryAfterHeader) {
          const parsed = Number(retryAfterHeader);
          if (!Number.isNaN(parsed)) retryMs = Math.max(2000, parsed * 1000);
        }
        backoffUntil = Math.max(backoffUntil, now + retryMs + 500); // Fixed 500ms extra instead of random
        if (GT_LOG) console.log(`[GT] 429 rate limited. Backing off for ~${retryMs}ms`);
        throw new Error("429 Too Many Requests");
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${resp.statusText} ${body}`);
      }
      const data = (await resp.json()) as T;
      if (!config.skipCache && inferredTtl > 0) {
        responseCache.set(finalUrl, data, inferredTtl);
      }
      return data;
    } catch (err: any) {
      throw err;
    }
  };

  const p = schedule(exec, toPriority(config.priority));
  inFlightRequests.set(finalUrl, p);
  try {
    const res = await p;
    return res;
  } finally {
    // Ensure cleanup regardless of success/failure
    inFlightRequests.delete(finalUrl);
  }
}

// Per-mint price cache (dedupe across all races and sets)
const priceCache = new NodeCache({ stdTTL: Number(ENV.PRICE_CACHE_TTL_SECONDS ?? ((ENV.NODE_ENV !== "production") ? 5 : 30)) });

export async function getMintPriceUSD(mint: string, poolAddress?: string, priority: "high" | "normal" | "low" = "normal"): Promise<number | null> {
  const cacheKey = `price_${mint}`;
  const cached = priceCache.get<number>(cacheKey);
  if (typeof cached === "number") {
    if (GT_LOG) console.log(`[GT] price cache HIT ${mint}`);
    return cached;
  }

  try {
    let poolsUrl: string;
    if (poolAddress) {
      poolsUrl = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}`;
    } else {
      // query pumpswap pool for base token
      const searchUrl = `https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?include=base_token&base_token=${mint}&limit=1`;
      const search = await geckoGet<any>(searchUrl, { timeout: 10000, priority });
      const data = (search as any)?.data;
      if (!data || data.length === 0) return null;
      poolsUrl = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${data[0].id}`;
    }

    const pool = await geckoGet<any>(poolsUrl, { timeout: 10000, priority });
    const priceStr = (pool as any)?.data?.attributes?.base_token_price_usd;
    if (!priceStr) return null;
    const price = Number(priceStr);
    if (!Number.isFinite(price)) return null;
    priceCache.set(cacheKey, price);
    if (GT_LOG) console.log(`[GT] price cache SET ${mint}`);
    return price;
  } catch {
    return null;
  }
}

export function setPriceForMint(mint: string, price: number, ttlSeconds?: number) {
  const key = `price_${mint}`;
  priceCache.set(key, price, ttlSeconds);
}

export function invalidateMintPrice(mint: string) {
  const key = `price_${mint}`;
  priceCache.del(key);
}

export function getBackoffUntil() {
  return backoffUntil;
}

export function getGeckoStats() {
  return { ...geckoStats };
}

