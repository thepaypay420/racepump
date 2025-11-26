import { apiRequest } from "./queryClient";
import type {
  RaceswapPlanRequest,
  RaceswapPlanResponse,
  RaceswapPublicConfig,
  ReflectionTokenMeta,
  RaceswapTokenInfo,
} from "@shared/raceswap";

export interface Runner {
  mint: string;
  symbol: string;
  name: string;
  logoURI?: string;
  marketCap: number;
  volume24h?: number;
  initialPrice?: number;
  // Baseline price captured at LOCK
  initialPriceUsd?: number;
  initialPriceTs?: number;
  currentPrice?: number;
  priceChange?: number;
  // 1h percentage change from GeckoTerminal for display only
  priceChangeH1?: number;
  geckoTerminalUrl?: string;
  // GeckoTerminal pool address to fetch prices efficiently
  poolAddress?: string;
}

export interface Race {
  id: string;
  startTs: number;
  status: "OPEN" | "LOCKED" | "IN_PROGRESS" | "SETTLED" | "CANCELLED";
  rakeBps: number;
  jackpotFlag: boolean;
  jackpotAdded: number;
  winnerIndex?: number;
  drandRound?: number;
  drandRandomness?: string;
  drandSignature?: string;
  runners: Runner[];
  totalPot?: string;
  betCount?: number;
  computedStatus?: "OPEN" | "LOCKED" | "IN_PROGRESS" | "SETTLED" | "CANCELLED";
  timing?: {
    timeUntilNextTransition: number;
    nextTransition: string;
    progress: number;
    uiTimeUntilNextTransition?: number;
    uiLabel?: string;
    targetTs?: number;
    uiTargetTs?: number;
  };
  memeRewardEnabled?: boolean;
  memeRewardRecipient?: string;
  memeRewardTokenAmount?: string;
  memeRewardSolSpent?: string;
  memeRewardTxSig?: string;
}

export interface Bet {
  id: string;
  raceId: string;
  wallet: string;
  runnerIdx: number;
  amount: string;
  sig: string;
  ts: number;
  runner?: Runner;
}

export interface RaceTotals {
  totalPot: string;
  runnerTotals: string[];
  impliedOdds: string[];
  betCount: number;
}

export interface UserBets {
  bets: Bet[];
  totalWagered: string;
  count: number;
}

export interface PlaceBetRequest {
  raceId: string;
  runnerIdx: number;
  amount: string;
  fromPubkey: string;
  txSig: string;
  clientId?: string;
  memo?: string;
  currency?: 'SOL' | 'RACE';
}

export interface ClaimRequest {
  raceId: string;
  wallet: string;
}

export interface CreateRaceRequest {
  startTs: number;
  rakeBps?: number;
  jackpotFlag?: boolean;
  limit?: number;
}

export interface FaucetRequest {
  toPubkey: string;
  amount: string;
}

export interface PriceChange {
  mint: string;
  symbol: string;
  initialPrice: number;
  currentPrice: number;
  priceChange: number;
  lastUpdate: number;
}

export interface ProgressData {
  currentLeader: {
    symbol: string;
    priceChange: number;
    logoURI?: string;
  } | null;
  priceChanges: PriceChange[];
}

// Historical series for race chart preloading
export interface RaceHistoryPoint { t: number; v: number }
export interface RaceHistoryRunner { runnerIndex: number; mint: string; points: RaceHistoryPoint[] }
export interface RaceHistoryResponse {
  raceId: string;
  startTs: number;
  durationSec: number;
  runners: RaceHistoryRunner[];
  source?: string;
}

export interface TokenStatsResponse {
  mint: string;
  poolAddress?: string;
  currentPriceUsd: number;
  priceChangeH1Pct: number;
  volumeUsd24h: number;
  fdvUsd: number;
  name?: string;
  lastUpdated: number;
}

export interface LeaderboardRow {
  wallet: string;
  totalRaces: number;
  wins: number;
  losses: number;
  totalWagered: string;
  totalAwarded: string;
  edgePoints: string;
  lastUpdated: number;
}

export interface LeaderboardResponse {
  top: LeaderboardRow[];
  you?: LeaderboardRow;
  rank: number | null;
}

export interface UserReceiptRow {
  raceId: string;
  betAmount: string;
  payoutAmount: string;
  win: number | boolean;
  ts: number;
  txSig?: string;
  edgePoints?: string;
  currency?: 'SOL' | 'RACE';
}

// API functions
export const api = {
  // Public endpoints
  getRunners: async (limit: number = 12): Promise<Runner[]> => {
    const response = await apiRequest("GET", `/api/runners/top?limit=${limit}`);
    return response.json();
  },

  // Referrals
  getReferralSettings: async () => {
    const res = await apiRequest('GET', '/api/referrals/settings');
    return res.json();
  },
  getReferralCode: async (wallet: string) => {
    const res = await apiRequest('GET', `/api/referrals/code/${wallet}`);
    return res.json();
  },
  setReferralCode: async (wallet: string, desired?: string) => {
    const res = await apiRequest('POST', '/api/referrals/code', { wallet, desired });
    return res.json();
  },
  trackReferral: async (wallet: string, code: string, source?: string) => {
    const res = await apiRequest('POST', '/api/referrals/track', { wallet, code, source });
    return res.json();
  },

  getRaces: async (status?: string): Promise<Race[]> => {
    const url = status ? `/api/races?status=${status}` : "/api/races";
    const response = await apiRequest("GET", url);
    return response.json();
  },

  getRace: async (raceId: string): Promise<Race> => {
    const response = await apiRequest("GET", `/api/races/${raceId}`);
    return response.json();
  },

  getRaceTotals: async (raceId: string): Promise<RaceTotals> => {
    const response = await apiRequest("GET", `/api/races/${raceId}/totals`);
    return response.json();
  },

  // Per-wallet result for a race (win/loss) used for notification fallback
  getRaceResult: async (raceId: string, wallet: string, currency?: 'SOL' | 'RACE'): Promise<{
    raceId: string;
    wallet: string;
    participated: boolean;
    win?: boolean;
    payoutAmount?: string;
    lostAmount?: string;
    txSig?: string;
  }> => {
    const url = new URL(`/api/races/${raceId}/result`, window.location.origin);
    url.searchParams.set('wallet', wallet);
    if (currency) url.searchParams.set('currency', currency);
    const response = await apiRequest('GET', url.pathname + url.search);
    return response.json();
  },

  getRaceHistory: async (raceId: string): Promise<RaceHistoryResponse> => {
    const response = await apiRequest("GET", `/api/races/${raceId}/history`);
    return response.json();
  },

  // Token stats (GeckoTerminal-backed, cached server-side)
  getTokenStats: async (mint: string, poolAddress?: string): Promise<TokenStatsResponse> => {
    const url = new URL('/api/token-stats', window.location.origin);
    url.searchParams.set('mint', mint);
    if (poolAddress) url.searchParams.set('pool', poolAddress);
    const response = await apiRequest('GET', url.pathname + url.search);
    return response.json();
  },

  getUserBets: async (raceId: string, wallet: string): Promise<UserBets> => {
    const response = await apiRequest("GET", `/api/races/${raceId}/bets?wallet=${wallet}`);
    return response.json();
  },

  placeBet: async (data: PlaceBetRequest) => {
    const response = await apiRequest("POST", "/api/bet", data);
    return response.json();
  },

  rescanBets: async (wallet: string, raceId?: string) => {
    const response = await apiRequest("POST", "/api/bet/rescan", { wallet, raceId });
    return response.json();
  },

  claimWinnings: async (data: ClaimRequest) => {
    const response = await apiRequest("POST", "/api/claim", data);
    return response.json();
  },

  getWalletBalances: async (address: string) => {
    const response = await apiRequest("GET", `/api/wallet/${address}/balances`);
    return response.json();
  },

    // RACESwap endpoints
    getRaceswapConfig: async (): Promise<RaceswapPublicConfig> => {
      const response = await apiRequest("GET", "/api/raceswap/config");
      return response.json();
    },

      getRaceswapTokens: async (limit?: number): Promise<RaceswapTokenInfo[]> => {
        const url = new URL("/api/raceswap/tokens", window.location.origin);
        if (limit) {
          url.searchParams.set("limit", String(limit));
        }
        const response = await apiRequest("GET", url.pathname + url.search);
        return response.json();
      },

    getRaceswapReflection: async (): Promise<ReflectionTokenMeta> => {
      const response = await apiRequest("GET", "/api/raceswap/reflection");
      return response.json();
    },

    createRaceswapPlan: async (payload: RaceswapPlanRequest): Promise<RaceswapPlanResponse> => {
      const response = await apiRequest("POST", "/api/raceswap/plan", payload);
      return response.json();
    },

  // User receipts and summary
  getUserReceipts: async (wallet: string, limit: number = 20): Promise<UserReceiptRow[]> => {
    const url = new URL(`/api/user/${wallet}/receipts`, window.location.origin);
    url.searchParams.set('limit', String(limit));
    const response = await apiRequest('GET', url.pathname + url.search);
    return response.json();
  },
  getUserSummary: async (wallet: string): Promise<LeaderboardRow> => {
    const response = await apiRequest('GET', `/api/user/${wallet}/summary`);
    return response.json();
  },

  // Admin endpoints
  admin: {
    createRace: async (data: CreateRaceRequest, adminToken: string) => {
      const response = await apiRequest("POST", "/api/admin/race/create", data, {
        Authorization: `Bearer ${adminToken}`
      });
      return response.json();
    },

    lockRace: async (raceId: string, adminToken: string) => {
      const response = await apiRequest("POST", "/api/admin/race/lock", 
        { raceId }, 
        { Authorization: `Bearer ${adminToken}` }
      );
      return response.json();
    },

    cancelRace: async (raceId: string, adminToken: string) => {
      const response = await apiRequest("POST", "/api/admin/race/cancel", 
        { raceId }, 
        { Authorization: `Bearer ${adminToken}` }
      );
      return response.json();
    },

    faucet: async (data: FaucetRequest, adminToken: string) => {
      const response = await apiRequest("POST", "/api/admin/faucet", data, {
        Authorization: `Bearer ${adminToken}`
      });
      return response.json();
    },

    getStats: async (adminToken: string) => {
      const response = await apiRequest("GET", "/api/admin/stats", undefined, {
        Authorization: `Bearer ${adminToken}`
      });
      return response.json();
    },

    setMaintenance: async (mode: boolean, message: string | undefined, adminToken: string) => {
      const response = await apiRequest("POST", "/api/admin/maintenance", { mode, message }, {
        Authorization: `Bearer ${adminToken}`
      });
      return response.json();
    },

    restartRaces: async (adminToken: string) => {
      const response = await apiRequest("POST", "/api/admin/restart-races", {}, {
        Authorization: `Bearer ${adminToken}`
      });
      return response.json();
    },

    resetJackpots: async (adminToken: string) => {
      const response = await apiRequest("POST", "/api/admin/reset-jackpots", {}, {
        Authorization: `Bearer ${adminToken}`
      });
      return response.json();
    }
  },

  // Treasury endpoints
  getTreasury: async () => {
    const response = await apiRequest("GET", "/api/treasury");
    return response.json();
  },

  // Emergency endpoints
  emergency: {
    clearRaces: async () => {
      const response = await apiRequest("POST", "/api/emergency/clear-races");
      return response.json();
    }
  },

  // Public faucet endpoint (no auth required)
  publicFaucet: async (data: FaucetRequest) => {
    const response = await apiRequest("POST", "/api/faucet", data);
    return response.json();
  }
};

export const leaderboardApi = {
  getLeaderboard: async (limit: number = 25, wallet?: string): Promise<LeaderboardResponse> => {
    const url = new URL('/api/leaderboard', window.location.origin);
    url.searchParams.set('limit', String(limit));
    if (wallet) url.searchParams.set('wallet', wallet);
    try {
      const curr = (window as any).__APP_CURRENCY__ || undefined;
      if (curr) url.searchParams.set('currency', curr);
    } catch {}
    const response = await apiRequest('GET', url.pathname + url.search);
    return response.json();
  }
};

// SSE connection for real-time updates
export function createSSEConnection(onMessage: (data: any) => void) {
  const eventSource = new EventSource("/api/events");
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch (error) {
      console.error("Failed to parse SSE message:", error);
    }
  };

  eventSource.onerror = (error) => {
    console.error("SSE connection error:", error);
  };

  return eventSource;
}

// Resilient SSE with auto-retry + heartbeat check
export function connectSSEWithRetry(
  url: string,
  onMessage: (payload: any) => void,
  opts?: { initialBackoffMs?: number; maxBackoffMs?: number }
) {
  const initial = opts?.initialBackoffMs ?? 1000;
  const ceiling = opts?.maxBackoffMs ?? 30000;

  let es: EventSource | null = null;
  let backoff = initial;
  let lastPing = Date.now();
  let closed = false;

  const open = () => {
    if (closed) return;
    try { es?.close(); } catch {}
    es = new EventSource(url, { withCredentials: false });

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data?.type === 'ping') {
          lastPing = Date.now();
          backoff = initial; // healthy again → reset backoff
        } else {
          onMessage(data);
        }
      } catch (e) {
        console.warn('SSE parse error', e);
      }
    };

    es.onerror = () => {
      try { es?.close(); } catch {}
      // exponential backoff + jitter
      const delay = Math.min(backoff, ceiling) + 150; // Fixed 150ms jitter instead of random
      setTimeout(open, delay);
      backoff = Math.min(backoff * 2, ceiling);
    };
  };

  // Heartbeat watchdog: if no ping for 45s, force reconnect
  const hb = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastPing > 45_000) {
      try { es?.close(); } catch {}
      open();
    }
  }, 10_000);

  // Handle online/offline and tab focus
  const onOnline = () => { try { es?.close(); } catch {}; open(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onOnline);

  // Start
  open();

  return {
    close() {
      closed = true;
      try { es?.close(); } catch {}
      clearInterval(hb);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onOnline);
    }
  };
}
