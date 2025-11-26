import NodeCache from 'node-cache';

interface CacheRegistry {
  tokenCache: NodeCache;
  priceCache: NodeCache;
  ohlcvCache: NodeCache;
}

let cacheRegistry: CacheRegistry | null = null;

export function registerCache(name: keyof CacheRegistry, cache: NodeCache) {
  if (!cacheRegistry) {
    cacheRegistry = {
      tokenCache: new NodeCache(),
      priceCache: new NodeCache(),
      ohlcvCache: new NodeCache()
    };
  }
  cacheRegistry[name] = cache;
}

export function clearAllCaches() {
  if (cacheRegistry) {
    console.log('🧹 Clearing all coordinated caches...');
    cacheRegistry.tokenCache.flushAll();
    cacheRegistry.priceCache.flushAll();
    cacheRegistry.ohlcvCache.flushAll();
    console.log('✅ All caches cleared - fresh data guaranteed');
  }
}

export function clearTokenRelatedCaches() {
  if (cacheRegistry) {
    console.log('🧹 Clearing token-related caches...');
    cacheRegistry.tokenCache.flushAll();
    cacheRegistry.priceCache.flushAll();
    console.log('✅ Token caches cleared');
  }
}

export function getCacheStatus() {
  if (!cacheRegistry) return null;
  
  return {
    tokenCache: {
      keys: cacheRegistry.tokenCache.keys().length,
      stats: cacheRegistry.tokenCache.getStats()
    },
    priceCache: {
      keys: cacheRegistry.priceCache.keys().length,
      stats: cacheRegistry.priceCache.getStats()
    },
    ohlcvCache: {
      keys: cacheRegistry.ohlcvCache.keys().length,
      stats: cacheRegistry.ohlcvCache.getStats()
    }
  };
}