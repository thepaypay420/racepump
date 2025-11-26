import NodeCache from "node-cache";
import type { RaceswapTokenInfo } from "@shared/raceswap";
import { registerCache } from "./cache-coordinator";
import { raceMintAddress } from "./solana";

interface JupiterTokenRecord {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  chainId?: number;
  tags?: string[];
  extensions?: Record<string, any>;
  daily_volume?: number | string;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERZr5C9ms4P4Ey4ZEz7XkMqwhZzZDG2Y6m";
const TOKEN_LIST_URL = "https://token.jup.ag/all";
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

registerCache("raceswapTokenList", cache);

const SOL_LOGO_URI = "/sol.svg";
const USDC_LOGO_URI =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png";
const USDT_LOGO_URI =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERZr5C9ms4P4Ey4ZEz7XkMqwhZzZDG2Y6m/logo.png";
const RACE_LOGO_URI = process.env.RACESWAP_RACE_LOGO?.trim() || "/racepump.svg";

export async function getRaceswapTokenList(limit: number = 250): Promise<RaceswapTokenInfo[]> {
  const cappedLimit = Math.max(1, Math.min(Math.trunc(limit) || 250, 500));
  const universe = await loadTokenUniverse();
  if (universe.length <= cappedLimit) {
    return universe.slice();
  }
  return universe.slice(0, cappedLimit);
}

export function getFallbackRaceswapTokens(): RaceswapTokenInfo[] {
  return buildPriorityTokens();
}

function buildPriorityTokens(): RaceswapTokenInfo[] {
  const base: RaceswapTokenInfo[] = [
    {
      address: SOL_MINT,
      symbol: "SOL",
      name: "Wrapped SOL",
      decimals: 9,
      priorityScore: 1_000_000_000,
      logoURI: SOL_LOGO_URI,
    },
    {
      address: USDC_MINT,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      priorityScore: 900_000_000,
      logoURI: USDC_LOGO_URI,
    },
    {
      address: USDT_MINT,
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
      priorityScore: 850_000_000,
      logoURI: USDT_LOGO_URI,
    },
  ];
  if (raceMintAddress && !base.find((token) => token.address === raceMintAddress)) {
    base.push({
      address: raceMintAddress,
      symbol: "RACE",
      name: "Pump Racers",
      decimals: 6,
      priorityScore: 800_000_000,
      logoURI: RACE_LOGO_URI,
    });
  }
  return base;
}

async function loadTokenUniverse(): Promise<RaceswapTokenInfo[]> {
  const cached = cache.get<RaceswapTokenInfo[]>("universe");
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(TOKEN_LIST_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as JupiterTokenRecord[] | { tokens?: JupiterTokenRecord[] };
    const rawList = Array.isArray(payload) ? payload : Array.isArray(payload?.tokens) ? payload.tokens! : [];
    if (!rawList.length) {
      throw new Error("Empty Jupiter token list");
    }
    const curated = curateTokenList(rawList);
    cache.set("universe", curated, 300);
    return curated;
  } catch (error) {
    console.warn("[raceswap] token list fetch failed:", error);
    const fallback = buildPriorityTokens();
    cache.set("universe", fallback, 60);
    return fallback;
  }
}

function curateTokenList(tokens: JupiterTokenRecord[]): RaceswapTokenInfo[] {
  const priority = buildPriorityTokens();
  const dedup = new Map<string, RaceswapTokenInfo>();
  for (const token of priority) {
    dedup.set(token.address, token);
  }
  const scored = tokens
    .filter((token) => (token.chainId ?? 101) === 101 && token.address)
    .map(mapJupiterToken)
    .filter((token): token is RaceswapTokenInfo => Boolean(token));

  scored.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
  for (const token of scored) {
    if (!dedup.has(token.address)) {
      dedup.set(token.address, token);
    }
  }
  return Array.from(dedup.values());
}

function mapJupiterToken(token: JupiterTokenRecord): RaceswapTokenInfo | null {
  const symbol = token.symbol?.trim() || token.name?.trim();
  if (!symbol) return null;
  const decimals = Number.isFinite(token.decimals) ? Number(token.decimals) : 9;
  const dailyVolumeUsd = parseDailyVolume(token);
  const priorityScore =
    (dailyVolumeUsd ?? 0) +
    (token.tags?.includes("verified") ? 100_000 : 0) +
    (token.tags?.includes("community") ? 10_000 : 0);

  return {
    address: token.address,
    symbol,
    name: token.name || symbol,
    logoURI: token.logoURI,
    decimals,
    dailyVolumeUsd,
    priorityScore,
  };
}

function parseDailyVolume(token: JupiterTokenRecord): number | undefined {
  const candidates = [
    token.daily_volume,
    token.extensions?.daily_volume,
    token.extensions?.dailyVolume,
    token.extensions?.volume24h,
    token.extensions?.volume24hr,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const numeric = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0) {
      return numeric;
    }
  }
  return undefined;
}
