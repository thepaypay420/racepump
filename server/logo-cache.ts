import axios from "axios";
import NodeCache from "node-cache";
import { registerCache } from './cache-coordinator';

// Logo cache - long-term storage (24 hours) since logos rarely change
const logoCache = new NodeCache({ stdTTL: 24 * 60 * 60 }); // 24 hours

// Register logo cache with the coordinator
registerCache('logoCache', logoCache);

export interface TokenLogo {
  mint: string;
  logoURI: string | null;
  lastUpdate: number;
}

/**
 * Fetch token logo from DexScreener (one-time fetch with long-term caching)
 * This is the ONLY remaining use of DexScreener - just for logos
 */
export async function getTokenLogo(mint: string): Promise<string | null> {
  const cacheKey = `logo-${mint}`;
  const cached = logoCache.get<string | null>(cacheKey);
  
  if (cached !== undefined) {
    console.log(`📦 Using cached logo for ${mint.slice(-8)}`);
    return cached;
  }

  try {
    console.log(`🖼️ Fetching logo for ${mint.slice(-8)} from DexScreener...`);
    
    // Use DexScreener ONLY for logo fetching - single API call per token
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      timeout: 8000,
      headers: {
        'User-Agent': 'PumpRacers/1.0'
      }
    });

    if (!response.data?.pairs || response.data.pairs.length === 0) {
      // Cache null result to avoid repeated failed requests
      logoCache.set(cacheKey, null);
      console.log(`❌ No pairs found for ${mint.slice(-8)} - cached null`);
      return null;
    }

    // Find the best pair and extract logo
    const pairs = response.data.pairs;
    const selectedPair = pairs.find((pair: any) => 
      pair.dexId === 'pumpswap' && pair.info?.imageUrl
    ) || pairs.find((pair: any) => pair.info?.imageUrl) || pairs[0];

    const logoURI = selectedPair?.info?.imageUrl || null;

    // Cache for 24 hours - logos don't change often
    logoCache.set(cacheKey, logoURI);
    console.log(`✅ Cached logo for ${mint.slice(-8)}: ${logoURI ? 'found' : 'none'}`);
    
    return logoURI;
    
  } catch (error) {
    console.log(`⚠️ Error fetching logo for ${mint.slice(-8)}:`, error);
    // Cache null to avoid repeated requests to failed tokens
    logoCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Batch fetch logos for multiple tokens (parallel processing)
 */
export async function getTokenLogos(mints: string[]): Promise<Map<string, string | null>> {
  const logoPromises = mints.map(async (mint) => {
    const logoURI = await getTokenLogo(mint);
    return { mint, logoURI };
  });

  const logoResults = await Promise.all(logoPromises);
  const logoMap = new Map<string, string | null>();
  
  logoResults.forEach(({ mint, logoURI }) => {
    logoMap.set(mint, logoURI);
  });

  return logoMap;
}

/**
 * Get cached logo without fetching (for performance)
 */
export function getCachedLogo(mint: string): string | null | undefined {
  const cacheKey = `logo-${mint}`;
  return logoCache.get<string | null>(cacheKey);
}