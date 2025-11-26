import NodeCache from "node-cache";
import { registerCache } from './cache-coordinator';
import { geckoGet } from './gecko-client';

// Price caching for GeckoTerminal API (unified with trending tokens)
const priceCache = new NodeCache({ stdTTL: 120 }); // 2 minutes to optimize rate limits

// Register price cache with the coordinator
registerCache('priceCache', priceCache);

const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || process.env.JUPITER_AUTH_TOKEN?.trim();
const JUPITER_AUTH_HEADERS = JUPITER_API_KEY
  ? {
      Authorization: `Bearer ${JUPITER_API_KEY}`,
      "x-api-key": JUPITER_API_KEY,
    }
  : undefined;
let loggedMissingJupiterKey = false;

function logMissingApiKeyOnce() {
  if (!JUPITER_AUTH_HEADERS && !loggedMissingJupiterKey) {
    console.warn("[raceswap] Jupiter Pro endpoints disabled - set JUPITER_API_KEY to enable");
    loggedMissingJupiterKey = true;
  }
}

export interface JupiterPrice {
  id: string;
  mintSymbol: string;
  vsToken: string;
  vsTokenSymbol: string;
  price: number;
  lastUpdate: number;
}

export interface PriceChange {
  mint: string;
  symbol: string;
  initialPrice: number;
  currentPrice: number;
  priceChange: number; // Percentage change
  lastUpdate: number;
}

/**
 * Fetch current prices for multiple tokens using GeckoTerminal API (unified source)
 */
export async function getTokenPrices(mints: string[]): Promise<JupiterPrice[]> {
  const sortedMints = mints.sort();
  const cacheKey = `prices-${sortedMints.join(',')}`;
  const cached = priceCache.get<JupiterPrice[]>(cacheKey);
  
  if (cached) {
    console.log(`📦 Using cached prices for ${mints.length} tokens`);
    return cached;
  }

  try {
    console.log(`🔄 Fetching GeckoTerminal prices for ${mints.length} tokens`);
    
    // Use centralized Gecko client for rate limiting/coalescing
    const promises = mints.map(async (mint) => {
      try {
        // Query GeckoTerminal for pools containing this token
        const response = await geckoGet<any>(`https://api.geckoterminal.com/api/v2/search/pools?query=${mint}`, { timeout: 8000, priority: 'low' });

        if (!response?.data || response.data.length === 0) {
          throw new Error(`No pools found for ${mint} in GeckoTerminal`);
        }

        // Find the best pool for this token (prefer pumpswap, then by volume)
        const pools = response.data.filter((pool: any) => 
          pool.relationships?.base_token?.data?.id?.includes(mint) ||
          pool.relationships?.quote_token?.data?.id?.includes(mint)
        );

        if (pools.length === 0) {
          throw new Error(`Token ${mint} not found in any pools`);
        }

        // Prioritize pumpswap pools, then by volume
        const selectedPool = pools.sort((a: any, b: any) => {
          if (a.relationships?.dex?.data?.id === 'pumpswap' && b.relationships?.dex?.data?.id !== 'pumpswap') return -1;
          if (b.relationships?.dex?.data?.id === 'pumpswap' && a.relationships?.dex?.data?.id !== 'pumpswap') return 1;
          return (parseFloat(b.attributes?.volume_usd?.h24 || '0')) - (parseFloat(a.attributes?.volume_usd?.h24 || '0'));
        })[0];

        // Determine if our token is base or quote
        const isBaseToken = selectedPool.relationships.base_token.data.id.includes(mint);
        const price = isBaseToken ? 
          parseFloat(selectedPool.attributes.base_token_price_usd || '0') :
          parseFloat(selectedPool.attributes.quote_token_price_usd || '0');

        const symbol = isBaseToken ?
          selectedPool.attributes.name?.split(' / ')[0] || 'TOKEN' :
          selectedPool.attributes.name?.split(' / ')[1] || 'TOKEN';

        if (price <= 0) {
          throw new Error(`Invalid price for ${mint}: ${price}`);
        }

        return {
          id: mint,
          mintSymbol: symbol,
          vsToken: 'USDC',
          vsTokenSymbol: 'USDC',
          price,
          lastUpdate: Date.now()
        };
        
      } catch (error) {
        console.log(`⚠️ Error fetching price for ${mint}:`, error);
        throw error; // No fallback prices - fail fast with real data only
      }
    });

    // Wait for all price fetches to complete
    const prices = await Promise.all(promises);

    // Cache for 2 minutes to respect rate limits (30 calls/min)
    priceCache.set(cacheKey, prices, 120);
    console.log(`✅ Cached GeckoTerminal prices for ${prices.length} tokens`);
    return prices;

  } catch (error) {
    console.error('❌ GeckoTerminal price fetch error:', error);
    
    // No fallback prices - fail completely if GeckoTerminal is unavailable
    throw new Error('GeckoTerminal API unavailable - cannot provide real market data');
  }
}

/**
 * Calculate price changes for prediction market settlement
 */
export function calculatePriceChanges(
  initialPrices: { mint: string; symbol: string; price: number }[],
  currentPrices: JupiterPrice[]
): PriceChange[] {
  return initialPrices.map(initial => {
    const current = currentPrices.find(p => p.id === initial.mint);
    const currentPrice = current?.price || initial.price;
    
    const priceChange = initial.price > 0 
      ? ((currentPrice - initial.price) / initial.price) * 100
      : 0;

    return {
      mint: initial.mint,
      symbol: initial.symbol,
      initialPrice: initial.price,
      currentPrice,
      priceChange,
      lastUpdate: current?.lastUpdate || Date.now()
    };
  });
}

/**
 * Determine winner based on highest price percentage gain
 */
export function determineWinner(priceChanges: PriceChange[]): {
  winner: PriceChange;
  winnerIndex: number;
} {
  let winnerIndex = 0;
  let maxGain = priceChanges[0]?.priceChange || -Infinity;

  priceChanges.forEach((change, index) => {
    if (change.priceChange > maxGain) {
      maxGain = change.priceChange;
      winnerIndex = index;
    }
  });

  return {
    winner: priceChanges[winnerIndex],
    winnerIndex
  };
}

/**
 * Format price change for display
 */
export function formatPriceChange(change: number): string {
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

/**
 * Format price for display with appropriate decimal places
 */
export function formatPrice(price: number): string {
  if (price === 0) return '$0.00';
  
  if (price < 0.000001) {
    return price.toExponential(2);
  } else if (price < 0.01) {
    return price.toFixed(6);
  } else if (price < 1) {
    return price.toFixed(4);
  } else {
    return price.toFixed(2);
  }
}

/**
 * Retry fetch with exponential backoff for network reliability
 */
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Fetch attempt ${attempt}/${maxRetries} for ${url}`);
      const response = await fetch(url, options);
      
      if (response.ok || response.status >= 400) {
        return response;
      }
      
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      console.warn(`❌ Fetch attempt ${attempt} failed:`, error instanceof Error ? error.message : error);
      
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Jupiter Swap API integration
 * Swap SOL for SPL tokens using Jupiter aggregator
 */

export interface JupiterSwapParams {
  inputMint: string; // Token to sell (SOL = 'So11111111111111111111111111111111111111112')
  outputMint: string; // Token to buy
  amount: bigint; // Amount in smallest units (lamports for SOL)
  slippageBps: number; // Slippage tolerance in basis points (50 = 0.5%)
  maxAccounts?: number; // Max accounts for transaction size optimization (default 28)
  onlyDirectRoutes?: boolean; // Force single-hop routes for small swaps (default false)
  restrictIntermediateTokens?: boolean; // Hint to reduce hop explosion
  isReflectionSwap?: boolean; // Flag for reflection swaps to apply special optimizations
}

export interface JupiterSwapQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
}

export interface JupiterSwapResult {
  swapTransaction: string; // Base64 encoded transaction
  lastValidBlockHeight: number;
}

export interface JupiterSwapOptions {
  useLegacyTransaction?: boolean;
}

/**
 * Get a swap quote from Jupiter
 * Using both v6 (legacy) and v1 (new) APIs with fallback
 * Supports Jupiter V6 features like instructionVersion: 'V2' for better routing
 */
export async function getJupiterQuote(params: JupiterSwapParams): Promise<JupiterSwapQuote> {
  const endpoints = [
    { url: 'https://lite-api.jup.ag/swap/v1/quote', requiresAuth: false },
    { url: 'https://api.jup.ag/swap/v1/quote', requiresAuth: true },
  ] as const;

  let lastError: any;

  for (const endpoint of endpoints) {
    if (endpoint.requiresAuth && !JUPITER_AUTH_HEADERS) {
      logMissingApiKeyOnce();
      continue;
    }

    try {
      const url = new URL(endpoint.url);
      url.searchParams.set('inputMint', params.inputMint);
      url.searchParams.set('outputMint', params.outputMint);
      url.searchParams.set('amount', params.amount.toString());
      url.searchParams.set('slippageBps', params.slippageBps.toString());
      
      // OPTIMIZATION: Adaptive routing based on swap type
      // Default maxAccounts should allow Jupiter to find routes while staying under tx limits
      const maxAccounts = params.maxAccounts ?? (params.isReflectionSwap ? 28 : 40);
      const onlyDirectRoutes = params.onlyDirectRoutes ?? false; // Let Jupiter find the best route
      const restrictIntermediateTokens = params.restrictIntermediateTokens ?? false;
      
      url.searchParams.set('maxAccounts', maxAccounts.toString());
      url.searchParams.set('onlyDirectRoutes', onlyDirectRoutes.toString());
      if (restrictIntermediateTokens) {
        // Jupiter Lite rejects explicit false on free tier; omit param unless enabled
        url.searchParams.set('restrictIntermediateTokens', 'true');
      }
      
      // JUPITER V6 FEATURE: Use instructionVersion V2 for better routing (as of 2025)
      // This enables more efficient route construction and tx optimization
      url.searchParams.set('instructionVersion', 'V2');
      
      console.log(`🔄 Trying Jupiter quote from: ${endpoint.url}`);
      console.log(`   ${params.amount.toString()} lamports ${params.inputMint.slice(0,8)}... -> ${params.outputMint.slice(0,8)}...`);
      console.log(`   Params: maxAccounts=${maxAccounts}, onlyDirectRoutes=${onlyDirectRoutes}, restrictIntermediateTokens=${restrictIntermediateTokens}, isReflection=${params.isReflectionSwap || false}`);
      
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          ...(endpoint.requiresAuth ? JUPITER_AUTH_HEADERS : {}),
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const quote = await response.json();
      console.log(`✅ Jupiter quote received from ${endpoint.url}`);
      console.log(`   Input: ${quote.inAmount} Output: ${quote.outAmount} (impact: ${quote.priceImpactPct}%)`);
      console.log(`   Route plan: ${quote.routePlan?.length || 0} steps`);
      
      return quote as JupiterSwapQuote;

    } catch (error) {
      lastError = error;
      console.warn(`❌ Failed to fetch from ${endpoint.url}:`, error instanceof Error ? error.message : error);
    }
  }
  
  console.error('❌ All Jupiter quote endpoints failed');
  throw lastError;
}

/**
 * Get swap transaction from Jupiter
 * Returns a serialized transaction that needs to be signed and sent
 */
export async function getJupiterSwapTransaction(
  quote: JupiterSwapQuote,
  userPublicKey: string,
  wrapUnwrapSOL: boolean = true,
  prioritizationFeeLamports?: number,
  options?: JupiterSwapOptions & { isReflectionSwap?: boolean }
): Promise<JupiterSwapResult> {
  const endpoints = [
    {
      url: 'https://lite-api.jup.ag/swap/v1/swap',
      version: 'v1',
      requiresAuth: false,
    },
    {
      url: 'https://api.jup.ag/swap/v1/swap',
      version: 'v1',
      requiresAuth: true,
    },
  ] as const;
  
  let lastError: any;
  
  for (const endpoint of endpoints) {
    if (endpoint.requiresAuth && !JUPITER_AUTH_HEADERS) {
      logMissingApiKeyOnce();
      continue;
    }
    try {
      console.log(`🔄 Requesting swap transaction from: ${endpoint.url} (${endpoint.version})`);
      
      let requestBody: any;
      const legacyRequested = Boolean(options?.useLegacyTransaction);
      
      if (endpoint.version === 'v1') {
        requestBody = {
          userPublicKey,
          quoteResponse: quote,
          wrapAndUnwrapSol: wrapUnwrapSOL,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: true, // Enable to handle volatile meme coin price movements
          // JUPITER V6 FEATURE: Use instructionVersion V2 in swap-instructions for better tx efficiency
          instructionVersion: 'V2',
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: prioritizationFeeLamports || 100000, // Reduce max lamports to minimize overhead
              priorityLevel: 'high' // Reduce from veryHigh to minimize transaction size
            }
          },
          ...(legacyRequested ? { useLegacyTransaction: true, asLegacyTransaction: true } : {})
        };
      } else {
        requestBody = {
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: wrapUnwrapSOL,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: prioritizationFeeLamports || 'auto',
          ...(legacyRequested ? { asLegacyTransaction: true } : {})
        };
      }

      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(endpoint.requiresAuth ? JUPITER_AUTH_HEADERS : {}),
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      console.log(`✅ Jupiter swap transaction received from ${endpoint.url}`);
      
      // Log transaction size info by deserializing and counting accounts
      if (result.swapTransaction) {
        try {
          const txBuffer = Buffer.from(result.swapTransaction, 'base64');
          console.log(`   Transaction size: ${txBuffer.length} bytes (${result.swapTransaction.length} base64 chars)`);
        } catch (e) {
          // Ignore errors in logging
        }
      }
      
      return result as JupiterSwapResult;

    } catch (error) {
      lastError = error;
      console.warn(`❌ Failed to get swap from ${endpoint.url}:`, error instanceof Error ? error.message : error);
    }
  }
  
  console.error('❌ All Jupiter swap endpoints failed');
  throw lastError;
}