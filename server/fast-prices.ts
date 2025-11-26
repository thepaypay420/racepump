import NodeCache from 'node-cache';

type RunnerRef = { mint: string; poolAddress?: string };

// Environment-configurable knobs
const ENV: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
const FAST_TTL_SECONDS = Number(ENV.FAST_PRICE_TTL_SECONDS ?? 10); // slightly longer cache to reduce call volume
const DS_CONCURRENCY = Number(ENV.DS_CONCURRENCY ?? 4);
const DS_LOG = ENV.DS_LOG === '1';
// Default to using the pairs API when pool addresses are available, unless explicitly disabled
const FAST_USE_PAIRS = (() => {
  if (ENV.FAST_USE_PAIRS == null) return true; // default ON
  const v = (ENV.FAST_USE_PAIRS || '').toString().toLowerCase();
  return v === '1' || v === 'true';
})();

// Lightweight in-flight coalescing by key (mint)
const inflightByMint = new Map<string, Promise<number | null>>();

// Global concurrency gate
let inflightCount = 0;
const queue: Array<() => void> = [];
function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      inflightCount++;
      try {
        const res = await task();
        resolve(res);
      } catch (e) {
        reject(e);
      } finally {
        inflightCount--;
        next();
      }
    };
    queue.push(run);
    next();
  });
}
function next() {
  while (inflightCount < DS_CONCURRENCY && queue.length > 0) {
    const fn = queue.shift();
    if (fn) fn(); else break;
  }
}

// Per-key ultra-short cache (keys for mint or pair)
const priceCache = new NodeCache({ stdTTL: FAST_TTL_SECONDS });

// Fetch best USD price for a mint from DexScreener (reliable path)
async function fetchDexScreenerPriceUsd(mint: string, timeoutMs: number = 6000): Promise<number | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    if (DS_LOG) console.log(`[DS] GET ${url}`);
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'PumpRacers/fast-prices' } });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const pairs: any[] = Array.isArray(data?.pairs) ? data.pairs : [];
    if (pairs.length === 0) return null;
    // Prefer pumpswap; else highest liquidity in USD
    const best = pairs
      .slice()
      .sort((a, b) => {
        const aPump = (a.dexId || '').toLowerCase() === 'pumpswap' ? 1 : 0;
        const bPump = (b.dexId || '').toLowerCase() === 'pumpswap' ? 1 : 0;
        if (aPump !== bPump) return bPump - aPump;
        const liqA = Number(a?.liquidity?.usd || 0);
        const liqB = Number(b?.liquidity?.usd || 0);
        return liqB - liqA;
      })[0];
    const price = Number(best?.priceUsd || 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (e) {
    if (DS_LOG) console.warn(`[DS] token price miss for mint ${mint.slice(-6)}:`, (e as any)?.message || 'error');
    return null;
  } finally {
    clearTimeout(to);
  }
}

export async function getFastPriceForMint(mint: string): Promise<number | null> {
  const cacheKey = `fast_${mint}`;
  const cached = priceCache.get<number>(cacheKey);
  if (typeof cached === 'number') return cached;

  const existing = inflightByMint.get(mint);
  if (existing) return existing;

  const task = schedule(async () => {
    const price = await fetchDexScreenerPriceUsd(mint);
    if (typeof price === 'number') priceCache.set(cacheKey, price);
    return price;
  });

  inflightByMint.set(mint, task);
  try {
    const res = await task;
    return res;
  } finally {
    inflightByMint.delete(mint);
  }
}

// Optional: Batch fetch by pools (pair addresses). Some ecosystems align poolAddress==pairAddress, but not all.
async function fetchDexScreenerPairsPrices(poolAddresses: string[], timeoutMs: number = 6000): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (poolAddresses.length === 0) return out;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const unique = Array.from(new Set(poolAddresses.map(s => s.trim()).filter(Boolean)));
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${unique.join(',')}`;
    if (DS_LOG) console.log(`[DS] GET ${url}`);
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'PumpRacers/fast-prices' } });
    if (!resp.ok) return out;
    const data: any = await resp.json();
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    for (const p of pairs) {
      const pairAddr = String(p?.pairAddress || '').trim();
      const price = Number(p?.priceUsd || 0);
      if (pairAddr && Number.isFinite(price) && price > 0) out.set(pairAddr, price);
    }
    return out;
  } catch {
    return out;
  } finally {
    clearTimeout(to);
  }
}

export async function getFastPrices(
  raceRunners: RunnerRef[],
): Promise<Array<{ mint: string; price: number }>> {
  const results: Array<{ mint: string; price: number } | null> = new Array(raceRunners.length).fill(null);

  // Prefer pairs API first when pool addresses are available (faster/more reliable for brand-new pools)
  if (FAST_USE_PAIRS) {
    const withPool = raceRunners.map((r, i) => ({ r, i })).filter(x => !!x.r.poolAddress);
    if (withPool.length > 0) {
      const poolMap = new Map<string, number>();
      withPool.forEach(x => x.r.poolAddress && poolMap.set(x.r.poolAddress!, x.i));
      try {
        const poolPrices = await fetchDexScreenerPairsPrices(Array.from(poolMap.keys()));
        let filledFromPairs = 0;
        poolMap.forEach((idx, poolAddr) => {
          const p = poolPrices.get(poolAddr);
          if (typeof p === 'number' && p > 0) {
            const mint = raceRunners[idx].mint;
            priceCache.set(`fast_${mint}`, p);
            results[idx] = { mint, price: p };
            filledFromPairs++;
          }
        });
        if (DS_LOG) console.log(`[DS] pairs filled ${filledFromPairs}/${withPool.length}`);
      } catch (e) {
        if (DS_LOG) console.warn('[DS] pairs path failed, will try per-mint', e);
      }
    }
  }

  // Fill gaps with per-mint reliable path
  const fillTasks: Array<Promise<void>> = [];
  raceRunners.forEach((r, i) => {
    if (results[i]) return;
    fillTasks.push(schedule(async () => {
      const p = await getFastPriceForMint(r.mint);
      if (typeof p === 'number' && p > 0) results[i] = { mint: r.mint, price: p };
    }));
  });
  if (fillTasks.length > 0) await Promise.allSettled(fillTasks);

  const final = results.filter(Boolean) as Array<{ mint: string; price: number }>;
  if (DS_LOG) console.log(`[DS] fast price results ${final.length}/${raceRunners.length}`);
  return final;
}
