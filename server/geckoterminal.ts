/**
 * GeckoTerminal API integration for OHLCV data verification
 * Provides minute-level candlestick data to verify race settlement fairness
 */

import { geckoGet } from './gecko-client';
import NodeCache from 'node-cache';
import { registerCache } from './cache-coordinator';

// Cache for 5 minutes since OHLCV data doesn't change rapidly
const ohlcvCache = new NodeCache({ stdTTL: 300 });

// Register OHLCV cache with the coordinator
registerCache('ohlcvCache', ohlcvCache);

// Lightweight cache for per-token stats (price, 1h change, 24h volume, FDV)
const tokenStatsCache = new NodeCache({ stdTTL: 60 });
registerCache('tokenStatsCache', tokenStatsCache);

interface GeckoTerminalOHLCV {
  data: {
    id: string;
    type: string;
    attributes: {
      ohlcv_list: [number, number, number, number, number, number][];
    };
  };
  meta: {
    base: {
      address: string;
      name: string;
      symbol: string;
    };
  };
}

interface OHLCVCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TokenStats {
  mint: string;
  poolAddress?: string;
  currentPriceUsd: number;
  priceChangeH1Pct: number;
  volumeUsd24h: number;
  fdvUsd: number;
  symbol?: string;
  name?: string;
  lastUpdated: number;
}

/**
 * Find pool address for a Solana token mint using GeckoTerminal token-to-pools endpoint
 */
async function findPoolAddress(tokenMint: string): Promise<string | null> {
  try {
    console.log(`🔍 Looking for pools for token: ${tokenMint}`);
    
    // Use the token-specific endpoint to find all pools trading this token
    const response: any = await geckoGet(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenMint}/pools`, { params: { include: 'top_pools' }, timeout: 10000 });

    console.log(`📊 Found ${response?.data?.length || 0} pools for token ${tokenMint}`);

    if (response?.data?.length > 0) {
      const pools = response.data;
      
      // Sort by volume and liquidity to find the best pool
      const bestPool = pools.sort((a: any, b: any) => {
        const volumeA = parseFloat(a.attributes?.volume_usd?.h24 || '0');
        const volumeB = parseFloat(b.attributes?.volume_usd?.h24 || '0');
        const liquidityA = parseFloat(a.attributes?.reserve_in_usd || '0');
        const liquidityB = parseFloat(b.attributes?.reserve_in_usd || '0');
        
        // Prioritize by volume, then by liquidity
        const scoreA = volumeA + (liquidityA * 0.1);
        const scoreB = volumeB + (liquidityB * 0.1);
        return scoreB - scoreA;
      })[0];
      
      // Extract pool address from the id field (format: "solana_POOLADDRESS")
      const poolId = bestPool.id;
      const poolAddress = poolId ? poolId.split('_')[1] : null;
      
      console.log(`✅ Using best pool: ${poolAddress} (ID: ${poolId}) with $${bestPool.attributes?.volume_usd?.h24 || 0} 24h volume, $${bestPool.attributes?.reserve_in_usd || 0} liquidity`);
      return poolAddress || null;
    }
    
    console.log(`❌ No pools found for token ${tokenMint}`);
    return null;
  } catch (error: any) {
    console.error(`❌ Error finding pool for ${tokenMint}:`, (error && (error.message || error.toString())));
    return null;
  }
}

/**
 * Get quick token stats from GeckoTerminal pools endpoint
 * - currentPriceUsd, priceChangeH1Pct, volumeUsd24h, fdvUsd
 * - Uses pool address if provided, otherwise discovers best pool by volume/liquidity
 * - Cached for 60s to respect public API limits
 */
export async function getTokenStats(mint: string, explicitPoolAddress?: string): Promise<TokenStats> {
  const cacheKey = `token-stats:${mint}:${explicitPoolAddress || 'auto'}`;
  const cached = tokenStatsCache.get<TokenStats>(cacheKey);
  if (cached) return cached;

  try {
    const poolAddress = explicitPoolAddress || (await findPoolAddress(mint));
    if (!poolAddress) {
      const empty: TokenStats = {
        mint,
        poolAddress: undefined,
        currentPriceUsd: 0,
        priceChangeH1Pct: 0,
        volumeUsd24h: 0,
        fdvUsd: 0,
        lastUpdated: Date.now(),
      };
      tokenStatsCache.set(cacheKey, empty);
      return empty;
    }

    const pool = await geckoGet<any>(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}`, { timeout: 10000 });
    const attrs = (pool as any)?.data?.attributes || {};
    const currentPriceUsd = Number(attrs.base_token_price_usd || 0) || 0;
    const priceChangeH1Pct = Number((attrs.price_change_percentage?.h1) || 0) || 0;
    const volumeUsd24h = Number((attrs.volume_usd?.h24) || 0) || 0;
    const fdvUsd = Number(attrs.fdv_usd || 0) || 0;
    const name = attrs.name || undefined;

    const out: TokenStats = {
      mint,
      poolAddress,
      currentPriceUsd,
      priceChangeH1Pct,
      volumeUsd24h,
      fdvUsd,
      name,
      lastUpdated: Date.now(),
    };

    tokenStatsCache.set(cacheKey, out, 60);
    return out;
  } catch (e) {
    const fallback: TokenStats = {
      mint,
      poolAddress: explicitPoolAddress,
      currentPriceUsd: 0,
      priceChangeH1Pct: 0,
      volumeUsd24h: 0,
      fdvUsd: 0,
      lastUpdated: Date.now(),
    };
    tokenStatsCache.set(cacheKey, fallback, 30);
    return fallback;
  }
}

/**
 * Get minute-level OHLCV data for a token around race time
 */
export async function getTokenOHLCV(
  tokenMint: string,
  raceStartTime: number,
  raceDurationMinutes: number = 1,
  explicitPoolAddress?: string
): Promise<OHLCVCandle[]> {
  const cacheKey = `ohlcv-${tokenMint}-${explicitPoolAddress || 'auto'}-${raceStartTime}-${raceDurationMinutes}`;
  const cached = ohlcvCache.get<OHLCVCandle[]>(cacheKey);
  
  if (cached) {
    return cached;
  }

  try {
    // Find the pool address for this token (prefer explicit to avoid pool mismatches)
    const poolAddress = explicitPoolAddress || (await findPoolAddress(tokenMint));
    if (!poolAddress) {
      console.warn(`No pool found for token ${tokenMint}`);
      return [];
    }

    // Get minute-level OHLCV data with a window that safely covers the race period
    const raceEndTime = raceStartTime + (raceDurationMinutes * 60000);
    const beforeTimestamp = Math.floor(raceEndTime / 1000) + 300; // Add 5 minutes buffer
    const afterTimestamp = Math.floor(raceStartTime / 1000) - 300; // Start 5 minutes before race
    
    console.log(`📊 Fetching OHLCV for pool ${poolAddress}, race window: ${new Date(raceStartTime).toISOString()} to ${new Date(raceEndTime).toISOString()}`);
    
    // Request enough candles: raceDurationMinutes + buffer, minimum 10, max 200
    const desiredCandles = Math.min(200, Math.max(10, raceDurationMinutes + 10));
    const response = await geckoGet<GeckoTerminalOHLCV>(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute`,
      { params: { aggregate: 1, before_timestamp: beforeTimestamp, after_timestamp: afterTimestamp, limit: desiredCandles }, timeout: 10000 }
    );

    if (!(response as any)?.data?.attributes?.ohlcv_list) {
      return [];
    }

    const candles: OHLCVCandle[] = (response as any).data.attributes.ohlcv_list
      .map((candle: any) => ({
        timestamp: candle[0] * 1000, // Convert to milliseconds
        open: candle[1],
        high: candle[2], 
        low: candle[3],
        close: candle[4],
        volume: candle[5]
      }))
      .filter((candle: any) => {
        // Filter to race timeframe ±2 minutes for context
        const raceEnd = raceStartTime + (raceDurationMinutes * 60000);
        return candle.timestamp >= (raceStartTime - 120000) && 
               candle.timestamp <= (raceEnd + 120000);
      })
      .sort((a: any, b: any) => a.timestamp - b.timestamp);

    ohlcvCache.set(cacheKey, candles);
    return candles;

  } catch (error) {
    console.error(`GeckoTerminal OHLCV error for ${tokenMint}:`, error);
    return [];
  }
}

/**
 * Calculate price change from OHLCV data during race period
 */
export function calculateOHLCVPriceChange(
  candles: OHLCVCandle[], 
  raceStartTime: number, 
  raceDurationMinutes: number
): {
  startPrice: number;
  endPrice: number;
  priceChange: number;
  verified: boolean;
} {
  if (candles.length === 0) {
    return { startPrice: 0, endPrice: 0, priceChange: 0, verified: false };
  }

  const raceEndTime = raceStartTime + (raceDurationMinutes * 60000);
  
  // Find candles closest to race start and end times
  const startCandle = candles.find(c => c.timestamp >= raceStartTime) || candles[0];
  const endCandles = candles.filter(c => c.timestamp <= raceEndTime);
  const endCandle = endCandles[endCandles.length - 1] || candles[candles.length - 1];
  
  const startPrice = startCandle.open;
  const endPrice = endCandle.close;
  const priceChange = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
  
  return {
    startPrice,
    endPrice,
    priceChange,
    verified: candles.length >= 2 // At least 2 data points for verification
  };
}

/**
 * Get verification URL for GeckoTerminal pool chart
 */
export async function getGeckoTerminalChartUrl(tokenMint: string): Promise<string> {
  try {
    const poolAddress = await findPoolAddress(tokenMint);
    if (poolAddress) {
      return `https://www.geckoterminal.com/solana/pools/${poolAddress}`;
    }
  } catch (error) {
    console.error(`Error getting chart URL for ${tokenMint}:`, error);
  }
  // Fallback to search
  return `https://www.geckoterminal.com/solana/pools?search=${tokenMint}`;
}