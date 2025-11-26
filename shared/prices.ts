// Shared price calculation utilities for consistent baseline handling

/**
 * Calculates percentage gain using consistent baseline logic
 * Returns decimal value (e.g. 0.132 for 13.2% gain)
 */
export function pctGain(initial: number | undefined | null, current: number | undefined | null): number {
  const i = Number(initial ?? 0);
  const c = Number(current ?? 0);
  if (!(i > 0 && isFinite(i) && c > 0 && isFinite(c))) return 0;
  return (c - i) / i;
}

/**
 * Live price data by mint address (USD only)
 */
export type LivePriceByMint = Record<string /*mint*/, number /*priceUsd*/>;

/**
 * Formats percentage for display
 */
export function formatPercent(pct: number, decimals: number = 1): string {
  return `${(pct * 100).toFixed(decimals)}%`;
}