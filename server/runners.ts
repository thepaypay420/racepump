import NodeCache from "node-cache";
import { geckoGet, getMintPriceUSD, invalidateMintPrice } from "./gecko-client";
import { getFastPrices } from "./fast-prices";
import { Token } from "@shared/schema";
import { getTokenLogos } from './logo-cache';
import { registerCache, clearTokenRelatedCaches } from './cache-coordinator';

// Using public APIs - no keys required
console.log("Using public APIs for token data");

// High-frequency cache: 30-second TTL for real-time trending data
const tokenCache = new NodeCache({ stdTTL: 30 }); // 30-second cache for fast updates
let rotationIndex = 0; // Track which batch we're showing

// Register this cache with the coordinator
registerCache('tokenCache', tokenCache);

// Function to clear token cache when races complete to get fresh tokens
export function clearTokenCache(): void {
  // Use coordinated cache clearing to ensure all related caches are cleared
  clearTokenRelatedCaches();
  console.log('🔄 Token cache cleared - fresh tokens will be fetched on next request');
}

// Maintain a rolling buffer of the last N vetted runners (with valid poolAddress)
const LAST_VALID_BUFFER_SIZE = 20;
const lastValidRunners: Array<any> = [];
const lastValidRunnerIndex = new Map<string, number>();

function isVettedRunner(token: any): boolean {
  return !!(token && typeof token.poolAddress === 'string' && token.poolAddress.length > 0);
}

export function recordValidRunners(tokens: Array<any>): void {
  for (const t of tokens) {
    if (!isVettedRunner(t)) continue;
    const key = t.mint;
    // If exists, remove old position to refresh recency
    const idx = lastValidRunnerIndex.get(key);
    if (idx !== undefined) {
      lastValidRunners.splice(idx, 1);
      // Rebuild index map after splice
      lastValidRunnerIndex.clear();
      lastValidRunners.forEach((r, i) => lastValidRunnerIndex.set(r.mint, i));
    }
    // Add to front
    lastValidRunners.unshift(t);
    lastValidRunnerIndex.set(key, 0);
    // Trim buffer and rebuild index map for correctness
    while (lastValidRunners.length > LAST_VALID_BUFFER_SIZE) {
      const removed = lastValidRunners.pop();
      if (removed) lastValidRunnerIndex.delete(removed.mint);
    }
    lastValidRunners.forEach((r, i) => lastValidRunnerIndex.set(r.mint, i));
  }
}

export function getLastValidRunners(): Array<any> {
  return [...lastValidRunners];
}

export async function getNewPumpfunTokens(limit: number = 12): Promise<Token[]> {
  // Aggressive caching: Check cache first, fetch fresh if expired
  const rotationCycle = Math.floor(Date.now() / (30 * 1000)); // Changes every 30 seconds
  const cacheKey = `pump-tokens-cycle-${rotationCycle}-${limit}`;
  const cached = tokenCache.get<Token[]>(cacheKey);
  
  if (cached) {
    console.log(`🔄 Serving cached tokens from cycle ${rotationCycle} (${cached.length} tokens, cache age: <30s)`);
    return cached;
  }
  
  console.log(`🔄 Fetching fresh tokens for cycle ${rotationCycle} - cache expired`);
  console.log("Fetching trending pump.fun tokens with GeckoTerminal API (mainnet)");

  try {
    // Try GeckoTerminal first for trending pump.fun tokens
    const geckoResult = await fetchFromGeckoTerminal(limit);
    if (geckoResult.length > 0) {
      // Cache for 30 seconds to get fresh trending data (still only 2 calls/min with 30 calls/min limit)
      tokenCache.set(cacheKey, geckoResult, 30); // 30-second cache for real-time updates
      console.log(`📦 Cached ${geckoResult.length} trending tokens for 30 seconds (all <2 days old)`);
      return geckoResult;
    }
  } catch (error) {
    console.error("GeckoTerminal API failed:", error);
  }

  // No mock/sample token fallback allowed. Fail fast so active races never show mock runners.

  throw new Error("GeckoTerminal API failed and no fallback tokens allowed");
}

// Page rotation for more diverse token selection
let currentPage = 1;
const MAX_PAGES = 5; // Rotate through pages 1-5 for variety

async function fetchFromGeckoTerminal(limit: number): Promise<Token[]> {
  try {
    console.log(`🚀 Fetching trending pump.fun tokens from GeckoTerminal (page ${currentPage})...`);
    
    // Step 1: Get trending pools from GeckoTerminal (30 calls/min limit)
    const trendingUrl = `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=pumpswap&page=${currentPage}`;
    
    // Rotate to next page for next fetch (gives more diverse tokens)
    currentPage = currentPage >= MAX_PAGES ? 1 : currentPage + 1;
    const data = await geckoGet<any>(trendingUrl, { timeout: 15000 });
    
    if (!data?.data) {
      throw new Error('No trending pools data returned from GeckoTerminal');
    }
    
    const pools = data.data;
    const pageUsed = currentPage === 1 ? MAX_PAGES : currentPage - 1; // Show the page that was actually used
    console.log(`📋 Found ${pools.length} trending pools from GeckoTerminal (page ${pageUsed})`);
    console.log(`🔄 Next fetch will use page ${currentPage} for token diversity`);
    
    // Step 2: Filter for recent pump.fun tokens (2-day window as requested)
    const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000);
    const pumpPools = pools.filter((pool: any) => {
      // Must be pumpswap dex (pump.fun tokens)
      if (pool.relationships?.dex?.data?.id !== 'pumpswap') {
        return false;
      }
      
      // Check pool creation timestamp
      if (pool.attributes?.pool_created_at) {
        const createdAt = new Date(pool.attributes.pool_created_at).getTime();
        if (createdAt <= twoDaysAgo) {
          console.log(`⏰ Skipping old pool ${pool.attributes.name} (created ${new Date(createdAt).toLocaleString()})`);
          return false;
        }
      }
      
      // Must have valid base token address ending in 'pump'
      const baseTokenId = pool.relationships?.base_token?.data?.id;
      if (!baseTokenId || !baseTokenId.includes('pump')) {
        return false;
      }
      
      // Market cap validation: Must be above $20k to ensure legitimate trading
      const marketCap = parseFloat(pool.attributes?.fdv_usd || '0');
      if (marketCap < 20000) {
        return false;
      }
      
      return true;
    });
    
    console.log(`📋 Found ${pumpPools.length} trending pump.fun pools (created in last 2 days, $20k+ FDV)`);
    
    // Step 3: Map to our Token format and fetch logos from DexScreener
    const baseTokens = pumpPools
      .slice(0, limit) // Take only what we need for rate limit efficiency
      .map((pool: any) => {
        const baseTokenId = pool.relationships.base_token.data.id;
        const mint = baseTokenId.replace('solana_', '');
        const price = parseFloat(pool.attributes.base_token_price_usd || '0');
        const priceChange = parseFloat(pool.attributes.price_change_percentage?.h24 || '0');
        const priceChangeH1 = parseFloat(pool.attributes.price_change_percentage?.h1 || '0');
        const volume24h = parseFloat(pool.attributes.volume_usd?.h24 || '0');
        const marketCap = parseFloat(pool.attributes.fdv_usd || '0');
        
        // Extract symbol from pool name (e.g., "Troll / SOL" -> "Troll")
        const poolName = pool.attributes.name || '';
        const symbol = poolName.split(' / ')[0] || mint.slice(-8).toUpperCase();
        
        return {
          mint,
          symbol,
          name: symbol, // Use symbol as name for simplicity
          initialPrice: price,
          currentPrice: price,
          priceChange,
          priceChangeH1,
          volume24h,
          marketCap: Math.round(marketCap),
          createdAt: pool.attributes.pool_created_at ? new Date(pool.attributes.pool_created_at).getTime() : Date.now(),
          poolAddress: pool.attributes.address, // Pool address for GeckoTerminal API verification
          geckoTerminalUrl: `https://www.geckoterminal.com/solana/pools/${pool.attributes.address}`
        };
      });

    // Step 4: Fetch logos from DexScreener (smart caching)
    const mints = baseTokens.map((token: any) => token.mint as string);
    const logoMap = await getTokenLogos(mints);
    
    const tokens = baseTokens.map((token: any) => ({
      ...token,
      logoURI: logoMap.get(token.mint) || `https://via.placeholder.com/64/00ff88/ffffff?text=${token.symbol.charAt(0)}`
    }));
    
    if (tokens.length > 0) {
      console.log(`Successfully fetched ${tokens.length} trending pump.fun tokens from GeckoTerminal`);
      // Record vetted runners for future fallback selection
      recordValidRunners(tokens);
      return tokens;
    }
    
    throw new Error('No valid trending pump.fun tokens found');

  } catch (error) {
    console.error('GeckoTerminal API error:', error);
    throw error;
  }
}

async function fetchFromBitquery(limit: number): Promise<Token[]> {
  // Fallback data with authentic pump.fun style tokens ending in "pump"
  const sampleTokens: Token[] = [
    {
      mint: "2cUSDJhQ7hYPTXFNh2kW4ePvKGS7Zs46qAT8vTYhpump",
      symbol: "DEEPUMP",
      name: "DeepSeek Pump",
      logoURI: "https://arweave.net/M8zT5QYs4rQQ5rvqpCyL6xwXxFJN0MCEPl2YP2H4yUg",
      initialPrice: 0.000001,
      currentPrice: 0.000001,
      priceChange: 0,
      volume24h: 50000,
      marketCap: 15000,
      createdAt: Date.now() - 3600000, // 1 hour ago
      geckoTerminalUrl: "https://www.geckoterminal.com/solana/pools/2cUSDJhQ7hYPTXFNh2kW4ePvKGS7Zs46qAT8vTYhpump"
    },
    {
      mint: "3S8qX1MsMqRbiwKg2cQyx7nis1oHMgaCuc9c4VfvVdPN",
      symbol: "MOONPUMP",
      name: "Moon Pump",
      logoURI: "https://arweave.net/E9GfyAvqn4tTYC8THF4mHj7K1y_g5YXTj1YzKJk4FBU",
      initialPrice: 0.000002,
      currentPrice: 0.000002,
      priceChange: 0,
      volume24h: 35000,
      marketCap: 8500,
      createdAt: Date.now() - 7200000, // 2 hours ago
      geckoTerminalUrl: "https://www.geckoterminal.com/solana/pools/3S8qX1MsMqRbiwKg2cQyx7nis1oHMgaCuc9c4VfvVdPN"
    },
    {
      mint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
      symbol: "GIGAPUMP", 
      name: "Giga Pump",
      logoURI: "https://arweave.net/tRiDJbjo9p_FM5-LwGL4Zx5GbcI_xGlNMbhQTJ6bRc8",
      initialPrice: 0.000003,
      currentPrice: 0.000003,
      priceChange: 0,
      volume24h: 28000,
      createdAt: Date.now() - 10800000 // 3 hours ago
    },
    {
      mint: "8Ki8DpuWNxu9VsS3kQbarsCWMcFGWkzzA8pUPto9zBd5",
      symbol: "RACEPUMP",
      name: "Race Pump",
      logoURI: "https://arweave.net/rE5hsEVBr7l_6kw2l9uF0NfEwdVNQ4MjJjY0_9R3_Ig",
      initialPrice: 0.000005,
      currentPrice: 0.000005,
      priceChange: 0,
      volume24h: 42000,
      createdAt: Date.now() - 14400000 // 4 hours ago
    },
    {
      mint: "BCD8VfmmwQqppwtcsWGykE6vBE157TLrWmMMPGQXgZdc",
      symbol: "SPEEDPUMP",
      name: "Speed Pump",
      logoURI: "https://arweave.net/M8zT5QYs4rQQ5rvqpCyL6xwXxFJN0MCEPl2YP2H4yUg",
      initialPrice: 0.000004,
      currentPrice: 0.000004,
      priceChange: 0,
      volume24h: 31000,
      createdAt: Date.now() - 18000000 // 5 hours ago
    },
    {
      mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963vgcg",
      symbol: "FASTPUMP",
      name: "Fast Pump",
      logoURI: "https://arweave.net/8GdcMa3jymehYv3162oxpSfkKtVdjmWc9Dy8p34FaFaX",
      initialPrice: 0.000006,
      currentPrice: 0.000006,
      priceChange: 0,
      volume24h: 25000,
      createdAt: Date.now() - 21600000 // 6 hours ago
    },
    {
      mint: "4k7ODHSqGFpjGLhXDuW1zbQdd2sJLB82fE23DJNpump",
      symbol: "TURBOPUMP",
      name: "Turbo Pump",
      logoURI: "https://arweave.net/5yXX5h5V9kVeF2BfvZdXcRqPlXnHRTc31nT4oTi6Pump",
      initialPrice: 0.000007,
      currentPrice: 0.000007,
      priceChange: 0,
      volume24h: 38000,
      createdAt: Date.now() - 25200000 // 7 hours ago
    },
    {
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB263pump",
      symbol: "MEGAPUMP",
      name: "Mega Pump",
      logoURI: "https://arweave.net/M8zT5QYs4rQQ5rvqpCyL6xwXxFJN0MCEPl2YP2H4yUg",
      initialPrice: 0.000008,
      currentPrice: 0.000008,
      priceChange: 0,
      volume24h: 44000,
      createdAt: Date.now() - 28800000 // 8 hours ago
    },
    {
      mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxpump",
      symbol: "NITROPUMP",
      name: "Nitro Pump",
      logoURI: "https://arweave.net/rE5hsEVBr7l_6kw2l9uF0NfEwdVNQ4MjJjY0_9R3_Ig",
      initialPrice: 0.000009,
      currentPrice: 0.000009,
      priceChange: 0,
      volume24h: 29000,
      createdAt: Date.now() - 32400000 // 9 hours ago
    },
    {
      mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPpump",
      symbol: "HYPERPUMP",
      name: "Hyper Pump",
      logoURI: "https://arweave.net/tRiDJbjo9p_FM5-LwGL4Zx5GbcI_xGlNMbhQTJ6bRc8",
      initialPrice: 0.00001,
      currentPrice: 0.00001,
      priceChange: 0,
      volume24h: 33000,
      createdAt: Date.now() - 36000000 // 10 hours ago
    },
    {
      mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJmppump",
      symbol: "SUPERPUMP",
      name: "Super Pump",
      logoURI: "https://arweave.net/E9GfyAvqn4tTYC8THF4mHj7K1y_g5YXTj1YzKJk4FBU",
      initialPrice: 0.000012,
      currentPrice: 0.000012,
      priceChange: 0,
      volume24h: 27000,
      createdAt: Date.now() - 39600000 // 11 hours ago
    },
    {
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwPump",
      symbol: "ULTRAPUMP",
      name: "Ultra Pump",
      logoURI: "https://arweave.net/8GdcMa3jymehYv3162oxpSfkKtVdjmWc9Dy8p34FaFaX",
      initialPrice: 0.000015,
      currentPrice: 0.000015,
      priceChange: 0,
      volume24h: 31000,
      createdAt: Date.now() - 43200000 // 12 hours ago
    }
  ];

  // Use the sample token data
  const runners = sampleTokens.slice(0, limit).map(token => ({
    ...token,
    currentPrice: token.initialPrice, // Use initial price
    priceChange: 0, // No change
    marketCap: token.marketCap || 10000, // Fixed default market cap
    geckoTerminalUrl: token.geckoTerminalUrl || `https://www.geckoterminal.com/solana/pools/${token.mint}`
  }));

  return runners;
}

async function fetchFromBirdeye(limit: number): Promise<Token[]> {
  // Return empty array as fallback - primary data comes from fetchFromBitquery
  return [];
}

// GeckoTerminal-only price fetching for race updates
export async function getGeckoTerminalPrices(
  raceRunners: Array<{mint: string, poolAddress?: string}>, 
  opts: {force?: boolean, priority?: 'high'|'normal'|'low'} = {}
): Promise<Array<{mint: string, price: number}>> {
  try {
    console.log(`🔍 Fetching GeckoTerminal prices for ${raceRunners.length} tokens${opts.force ? ' (force refresh)' : ''}`);
    
    // If forcing, invalidate individual mint caches so we really refetch
    if (opts.force) {
      for (const r of raceRunners) {
        invalidateMintPrice?.(r.mint);
      }
    }

    const results = await Promise.all(
      raceRunners.map(async (runner) => {
        const price = await getMintPriceUSD(runner.mint, runner.poolAddress, opts.priority || (opts.force ? 'high' : 'normal'));
        if (price == null) return null;
        return { mint: runner.mint, price };
      })
    );

    const validPrices = results.filter(Boolean) as Array<{ mint: string; price: number }>;
    console.log(`✅ Cached GeckoTerminal prices for ${validPrices.length}/${raceRunners.length} tokens (TTL via shared client)`);
    return validPrices;
    
  } catch (error) {
    console.error('❌ GeckoTerminal price fetch error:', error);
    return []; // Return empty array rather than throwing - graceful degradation
  }
}

// Primary fast price provider with fallback to GeckoTerminal
export async function getLivePrices(
  raceRunners: Array<{ mint: string; poolAddress?: string }>,
  opts: { force?: boolean; priority?: 'high' | 'normal' | 'low' } = {}
): Promise<Array<{ mint: string; price: number }>> {
  try {
    // First try ultra-fast provider (DexScreener). Merge with Gecko fallback for any missing tokens.
    const fast = await getFastPrices(raceRunners);
    const haveByMint = new Set<string>((fast || []).map(p => p.mint));
    const missing = raceRunners.filter(r => !haveByMint.has(r.mint));
    if (missing.length === 0) {
      // Always surface a concise summary so ops can verify fast path usage
      console.log(`⚡ DexScreener fast prices ${fast.length}/${raceRunners.length}`);
      return fast;
    }
    // Partially covered by fast provider; fill gaps via GeckoTerminal
    const geckoMissing = await getGeckoTerminalPrices(missing, opts);
    const merged = [...(fast || []), ...geckoMissing];
    if (merged.length > 0) {
      console.log(
        `⚡ DexScreener covered ${fast.length}; fetched ${geckoMissing.length} from GeckoTerminal → ${merged.length}/${raceRunners.length}`
      );
      return merged;
    }
  } catch (e) {
    console.warn('[prices] DexScreener fast provider failed; using GeckoTerminal only', e);
  }
  // Fallback preserves current behavior
  console.log(`↩️ Using GeckoTerminal for all ${raceRunners.length} tokens`);
  return await getGeckoTerminalPrices(raceRunners, opts);
}

// Route handler
export async function handleGetTokens(limit: number): Promise<{ success: boolean; data?: Token[]; error?: string }> {
  try {
    const tokens = await getNewPumpfunTokens(limit);
    return { success: true, data: tokens };
  } catch (error) {
    console.error("Failed to fetch tokens:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred"
    };
  }
}
