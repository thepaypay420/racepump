// Consistent USD price source for baseline calculations
import { LivePriceByMint } from "@shared/prices";
import { Runner } from "@shared/schema";

/**
 * Get live USD prices for race runners from a single consistent source
 * Returns only USD prices, never falls back to SOL or other quotes
 */
export async function getLivePricesForRunners(runners: Runner[]): Promise<LivePriceByMint> {
  try {
    // Use fast live prices with fallback to GeckoTerminal
    const { getLivePrices } = await import('./runners');
    
    const raceRunners = runners.map(runner => ({
      mint: runner.mint,
      poolAddress: runner.poolAddress
    }));
    
    const priceData = await getLivePrices(raceRunners);
    
    // Map strictly by mint to USD price, no fallbacks
    const priceByMint: LivePriceByMint = {};
    priceData.forEach(data => {
      if (data.mint && data.price > 0) {
        priceByMint[data.mint] = data.price; // Already in USD from GeckoTerminal
      }
    });
    
    return priceByMint;
  } catch (error) {
    console.error('Failed to fetch live USD prices:', error);
    return {};
  }
}