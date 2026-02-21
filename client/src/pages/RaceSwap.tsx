import { useState, useMemo, useEffect, useRef, useCallback, memo } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import Decimal from "decimal.js";
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createSyncNativeInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
// Slider removed - Lucky Buy feature disabled
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertTriangle, Loader2, Rocket, ShieldCheck, ArrowDownUp, RefreshCw, Info, Sparkles, ChevronDown, Trophy, Zap, Shield, Route, Eye } from "lucide-react";
import { RaceswapTokenSelector, TokenOption } from "@/components/RaceswapTokenSelector";
import { RaceswapCrate } from "@/components/RaceswapCrate";
import type { CrateCard } from "@/components/RaceswapCrate";
import { PokemonCardRail } from "@/components/PokemonCardRail";
import { MobileCardShowcase, formatOneInChance01 as formatOneInChanceMobile, calcCardWinProbability01 as calcCardWinProbMobile } from "@/components/MobileCardShowcase";
import { SwapStatsBar } from "@/components/SwapStatsBar";
import { SwapContestLeaderboard } from "@/components/SwapContestLeaderboard";
import { QuestsPanel } from "@/components/QuestsPanel";
import { FeaturedCards } from "@/components/FeaturedCards";
import { 
  executeSwapWithReflection, 
  getSwapPlan, 
  SwapPlan, 
  RACE_TOKEN_MINT, 
  getMintTokenProgramId, 
  SwapStage, 
  TREASURY_FEE_BPS,
  // PERFORMANCE: Blockhash prefetching for faster wallet popup
  startBlockhashPrefetch,
  stopBlockhashPrefetch,
} from "@/lib/jupiter-frontend";
import { getCustomTokens, saveCustomToken } from "@/lib/token-storage";
import { fetchOwnedTokens, clearOwnedTokensCache } from "@/lib/owned-tokens";
import { getPokemonCardsResult, type PokemonCardNft } from "@/lib/pokemon-cards";
import { preloadCrateImages } from "@/lib/image-preloader";
import { ProvablyFairVerifyDialog, type ProvablyFairDialogData } from "@/components/ProvablyFairVerifyDialog";
import raceclawVideoUrl from "@/assets/raceclaw.mp4";
import raceclawVideoUrl2 from "@/assets/raceclaw2.mp4";
import { useStore } from "@/lib/store";
import type {
  ReflectionTokenMeta,
  RaceswapPublicConfig,
  RaceswapTokenInfo,
} from "@shared/raceswap";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, Area, AreaChart } from "recharts";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_DEFAULT_OPTION: TokenOption = {
  address: SOL_MINT,
  symbol: "SOL",
  name: "Wrapped SOL",
  decimals: 9,
  logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png"
};

// MINIMUM BUY AMOUNT: Enforce minimum to ensure 1% reflection is meaningful
const MINIMUM_BUY_LAMPORTS = BigInt(
  process.env.RACESWAP_MIN_BUY_LAMPORTS || "10000000"
);
const MINIMUM_BUY_SOL = Number(MINIMUM_BUY_LAMPORTS) / 1e9; // For display

interface WinnerResponse {
  id: string;
  runners: Array<{ mint: string; symbol: string; logoURI?: string }>;
  winnerIndex?: number;
}

interface ReceiptData {
    spentAmount: string;
    spentSymbol?: string;
    spentLogo?: string;
    receivedAmount: string;
    receivedSymbol?: string;
    receivedLogo?: string;
    mainSignature?: string;
    holderBoost?: {
        raceBalanceUi: string;
        tier: "none" | "1m" | "5m" | "10m" | "20m";
        multiplier: number;
        nextTier: "1m" | "5m" | "10m" | "20m" | null;
        nextTierTargetUi: number | null;
        progressToNext: number | null;
    };
    boostedReward?: {
        won: boolean;
        rewardAmount?: string;
        rewardSignature?: string;
        blockhash?: string | null;
        seed?: string;
        slot?: number | null;
        recipient?: string;
        randomValue?: number;
        winProbability?: number;
        usdValue?: number;
        transactionSignature?: string;
        error?: string;
    };
    cardReward?: {
        won: boolean;
        mint?: string | null;
        rewardSignature?: string | null;
        blockhash?: string | null;
        seed?: string;
        slot?: number | null;
        recipient?: string;
        randomValue?: number;
        winProbability?: number;
        poolHash?: string | null;
        poolSize?: number;
        pickRoll?: number | null;
        pickIndex?: number | null;
        error?: string | null;
        enabled?: boolean;
        disabledReason?: string | null;
    };
    winningCard?: PokemonCardNft | null;
}

type AccountCategory = "user" | "program";

// Helper to format large numbers for taglines
function formatTaglineVolume(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  } else if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatTaglineValue(value: number): string {
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}k`;
  }
  return `$${value.toFixed(0)}`;
}

// Rotating tagline component with dynamic Pokémon card stats
function RotatingTagline() {
  const { connection } = useConnection();
  
  // Fetch swap stats for total volume
  const { data: swapStats } = useQuery({
    queryKey: ["swap-stats-tagline"],
    queryFn: async () => {
      const res = await fetch("/api/swap-stats");
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Fetch card allowlist
  const { data: allowlistData } = useQuery({
    queryKey: ["pokemon-card-allowlist-tagline"],
    queryFn: () => api.getPokemonCardAllowlist(),
    staleTime: 1000 * 60 * 5,
  });

  // Fetch card data for count + total value
  const { data: cardsData } = useQuery({
    queryKey: ["pokemon-cards-tagline", connection.rpcEndpoint, allowlistData?.droppableMints?.join(",") || ""],
    queryFn: () => {
      const mints = allowlistData?.droppableMints || allowlistData?.mints || [];
      return getPokemonCardsResult(connection, { allowlist: mints });
    },
    enabled: Boolean(allowlistData),
    staleTime: 1000 * 60 * 60 * 12,
  });

  // Calculate dynamic values
  const totalVolume = swapStats?.totalVolumeUSD ?? 0;
  const cardCount = cardsData?.items?.length ?? 0;
  const totalValueUsd = useMemo(() => {
    const items = cardsData?.items ?? [];
    return items.reduce((sum, nft) => {
      const v = nft.insuredValueUsd;
      return typeof v === "number" && Number.isFinite(v) ? sum + v : sum;
    }, 0);
  }, [cardsData]);

  // Build taglines - mix of static Pokémon-focused + dynamic stats
  const taglines = useMemo(() => {
    const lines: string[] = [
      // Static - Pokémon focused
      "Swap tokens. Win graded Pokémon cards. Simple.",
      "Every swap is a chance to win real graded Pokémon cards.",
      "On-chain graded cards. Provably fair drops.",
      "Trade any token. Win authenticated Pokémon cards.",
    ];

    // Dynamic - card pool stats (only if we have data)
    if (cardCount > 0 && totalValueUsd > 0) {
      lines.push(`${cardCount} graded cards worth ${formatTaglineValue(totalValueUsd)} in the drop pool.`);
    }

    // Dynamic - total volume (only if meaningful)
    if (totalVolume >= 1000) {
      lines.push(`💰 ${formatTaglineVolume(totalVolume)} swapped through SWAP&RIP.`);
    }

    // Card drop promotion
    lines.push("Instant swaps with card drop rewards.");

    return lines;
  }, [cardCount, totalValueUsd, totalVolume]);

  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % taglines.length);
    }, 5000); // Change every 5 seconds

    return () => clearInterval(interval);
  }, [taglines.length]);

  return (
    <p className="max-w-2xl text-sm sm:text-base mx-auto text-muted-foreground transition-opacity duration-500">
      {taglines[currentIndex]}
    </p>
  );
}

interface MissingAccountInfo {
  ata: PublicKey;
  mint: PublicKey;
  mintSymbol: string;
  label: string;
  owner: PublicKey;
  ownerLabel: string;
  tokenProgramId: PublicKey;
  category: AccountCategory;
}

interface AccountSetupState {
  open: boolean;
  accounts: MissingAccountInfo[];
  rentLamports: number;
  pairLabel: string;
  submitting: boolean;
  wsolTopUpLamports: bigint;
  wsolRequiredLamports: bigint;
  finalizing: boolean;
  statusMessage?: string;
  error?: string;
}

export default function RaceSwap() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const walletAddress = wallet.publicKey?.toBase58();
  const [location] = useLocation();
  const isTestSwapPage = location === "/raceswap-test";
  const theme = useStore((s) => s.theme);

  // Select video based on current theme
  const activeVideoUrl = theme === "light" ? raceclawVideoUrl2 : raceclawVideoUrl;

  // Decorative right-side video (desktop): use a manual loop to avoid a brief flash on reset
  const raceclawVideoRef = useRef<HTMLVideoElement | null>(null);

  const [inputToken, setInputToken] = useState<TokenOption | null>(null);
  const [outputToken, setOutputToken] = useState<TokenOption | null>(null);
  const [amount, setAmount] = useState("");
  const [debouncedAmount, setDebouncedAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(150);
  const [reflectionBps] = useState(0); // Lucky Buy disabled - base swap only
  
  const [crateKey, setCrateKey] = useState(0);
  const [crateSpinning, setCrateSpinning] = useState(false);
  const [swapSuccess, setSwapSuccess] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false);
  const [verifyDialogData, setVerifyDialogData] = useState<ProvablyFairDialogData | null>(null);
  const [showScrollIndicator, setShowScrollIndicator] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [swapStage, setSwapStage] = useState<SwapStage | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [accountSetupState, setAccountSetupState] = useState<AccountSetupState>({
    open: false,
    accounts: [],
    rentLamports: 0,
    pairLabel: "",
    submitting: false,
    wsolTopUpLamports: 0n,
    wsolRequiredLamports: 0n,
    finalizing: false,
    statusMessage: undefined,
  });
  const [isUnwrappingWsol, setIsUnwrappingWsol] = useState(false);
  const [persistedWsolOnLoad, setPersistedWsolOnLoad] = useState<boolean | null>(null);
  const treasuryFeeLabel = `${(TREASURY_FEE_BPS / 100).toFixed(1)}%`;

  const { data: raceswapConfig } = useQuery<RaceswapPublicConfig>({
    queryKey: ["raceswap-config"],
    queryFn: api.getRaceswapConfig,
    staleTime: 60000,
  });

  const holderBoostPreviewQuery = useQuery({
    queryKey: ["raceswap-holder-boost-preview", walletAddress],
    queryFn: () => api.getRaceswapHolderBoost(walletAddress!),
    enabled: Boolean(walletAddress),
    staleTime: 60_000,
  });

  const { data: reflectionMeta } = useQuery<ReflectionTokenMeta>({
    queryKey: ["raceswap-reflection"],
    queryFn: api.getRaceswapReflection,
    refetchInterval: 20000,
  });

  const { data: tokenList } = useQuery<RaceswapTokenInfo[]>({
    queryKey: ["raceswap-token-list"],
    queryFn: () => api.getRaceswapTokens(250),
    staleTime: 300000,
  });

  // Fetch owned tokens when wallet is connected
  const { data: ownedTokens, refetch: refetchOwnedTokens } = useQuery<TokenOption[]>({
    queryKey: ["owned-tokens", walletAddress],
    queryFn: async () => {
      if (!wallet.publicKey || !wallet.connected) return [];
      return fetchOwnedTokens(connection, wallet.publicKey);
    },
    enabled: Boolean(wallet.publicKey && wallet.connected),
    staleTime: 60000, // 1 minute
    refetchInterval: 120000, // Refetch every 2 minutes
  });

  // State to trigger re-render when custom tokens change
  const [customTokensVersion, setCustomTokensVersion] = useState(0);
  
  // State to track temporarily pasted tokens (not yet saved)
  const [tempTokens, setTempTokens] = useState<TokenOption[]>([]);
  
  // Load custom tokens from localStorage
  const customTokens = useMemo(() => {
    return getCustomTokens(walletAddress);
  }, [walletAddress, customTokensVersion]);

  const { data: recentWinners } = useQuery<WinnerResponse[]>({
    queryKey: ["recent-winners", 12],
    queryFn: async () => {
      const res = await fetch("/api/recent-winners?limit=12");
      return res.json();
    },
    staleTime: 60000,
  });

  // Card reel inventory (for the swap success "crate reveal" even if you don't win)
  const pokemonAllowlistQuery = useQuery({
    queryKey: ["pokemon-card-allowlist"],
    queryFn: () => api.getPokemonCardAllowlist(),
    staleTime: 1000 * 60 * 5,
  });

  // Use droppableMints (cards that are enabled AND not yet sent/won) for the card reel
  const cardReelAllowlist = useMemo(() => {
    const droppable = pokemonAllowlistQuery.data?.droppableMints;
    const mints = pokemonAllowlistQuery.data?.mints;
    return Array.isArray(droppable) && droppable.length > 0 ? droppable : (mints || []);
  }, [pokemonAllowlistQuery.data]);

  const pokemonCardsForReelQuery = useQuery({
    queryKey: ["pokemon-cards-reel", connection.rpcEndpoint, cardReelAllowlist.join(",")],
    queryFn: () => getPokemonCardsResult(connection, { allowlist: cardReelAllowlist }),
    staleTime: 1000 * 60 * 60 * 12,
  });

  const cardReelItems: CrateCard[] = useMemo(() => {
    const items = pokemonCardsForReelQuery.data?.items || [];
    return items.slice(0, 40).map((i) => ({ mint: i.mint, name: i.name, image: i.image }));
  }, [pokemonCardsForReelQuery.data]);

  // PERFORMANCE: Preload crate images at startup for smoother mobile experience
  // This runs once when cards/tokens are loaded and caches images in advance
  useEffect(() => {
    const cardImages = cardReelItems
      .map((c) => c.image)
      .filter((url): url is string => Boolean(url));
    
    const tokenLogos = (recentWinners ?? [])
      .map((race) => race.runners?.[race.winnerIndex ?? 0]?.logoURI)
      .filter((url): url is string => Boolean(url));
    
    // Also preload RACE token logo
    tokenLogos.push("/racepump.svg");
    
    if (cardImages.length > 0 || tokenLogos.length > 0) {
      void preloadCrateImages(tokenLogos, cardImages);
    }
  }, [cardReelItems, recentWinners]);

  // Merge Jupiter tokens + custom tokens + owned tokens + temp tokens (pasted but not saved)
  const tokenOptions = useMemo(() => {
    const jupiterTokens = mapTokens(tokenList);
    const dedup = new Map<string, TokenOption>();
    
    // Add Jupiter tokens first (they have priority for metadata)
    for (const token of jupiterTokens) {
      dedup.set(token.address, token);
    }
    
    // Add owned tokens (only if not already in list)
    for (const token of ownedTokens || []) {
      if (!dedup.has(token.address)) {
        dedup.set(token.address, token);
      }
    }
    
    // Add custom tokens (only if not already in list)
    for (const token of customTokens) {
      if (!dedup.has(token.address)) {
        dedup.set(token.address, token);
      }
    }
    
    // Add temp tokens (pasted but not yet saved - only save on successful swap)
    for (const token of tempTokens) {
      if (!dedup.has(token.address)) {
        dedup.set(token.address, token);
      }
    }
    
    return Array.from(dedup.values());
  }, [tokenList, ownedTokens, customTokens, tempTokens]);
  const sameTokenSwap = useMemo(
    () => Boolean(inputToken && outputToken && inputToken.address === outputToken.address),
    [inputToken, outputToken]
  );

  useEffect(() => {
    if (!tokenOptions.length) return;
    if (!inputToken) {
      const solDefault = tokenOptions.find((token) => token.address === SOL_MINT) ?? SOL_DEFAULT_OPTION;
      setInputToken(solDefault);
    }
    if (!outputToken) {
      const raceToken = tokenOptions.find((token) => token.address === RACE_TOKEN_MINT.toString());
      const usdc = tokenOptions.find((token) => token.symbol === "USDC");
      const fallback = tokenOptions.find((token) => token.address !== SOL_MINT);
      const output = raceToken ?? usdc ?? fallback ?? tokenOptions[0];
      if (output) {
        setOutputToken(output);
      }
    }
  }, [tokenOptions, inputToken, outputToken]);

  // ========================================================================
  // PERFORMANCE: Blockhash prefetching for faster wallet popup
  // ========================================================================
  // Start prefetching blockhash in the background when the swap page loads.
  // This ensures we always have a fresh blockhash ready when the user clicks swap,
  // eliminating ~50-100ms of latency.
  useEffect(() => {
    startBlockhashPrefetch(connection);
    return () => {
      stopBlockhashPrefetch();
    };
  }, [connection]);

  // Hide scroll indicator when user scrolls down
  useEffect(() => {
    const handleScroll = () => {
      // Hide after scrolling more than 50px
      if (window.scrollY > 50) {
        setShowScrollIndicator(false);
      } else {
        setShowScrollIndicator(true);
      }
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Smooth looping for the decorative raceclaw video (some browsers show a 1-frame flash on loop)
  useEffect(() => {
    const video = raceclawVideoRef.current;
    if (!video) return;

    // Skip a tiny bit to avoid possible black/empty first frame
    const LOOP_START = 0.03; // seconds
    // Jump a bit before the end to avoid decode gaps/flash at the boundary
    // (timeupdate is low-frequency; we use rAF so we don't miss the boundary)
    const LOOP_END_EPSILON = 0.18; // seconds

    const safePlay = () => {
      // Autoplay can be blocked in some cases; ignore failures
      void video.play().catch(() => undefined);
    };

    const safeLoop = () => {
      try {
        video.currentTime = LOOP_START;
      } catch {
        // ignore
      }
      safePlay();
    };

    let rafId = 0;
    const tick = () => {
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        if (video.currentTime >= duration - LOOP_END_EPSILON) {
          safeLoop();
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };

    const onLoadedMetadata = () => {
      if (video.currentTime < LOOP_START) {
        try {
          video.currentTime = LOOP_START;
        } catch {
          // ignore
        }
      }
      safePlay();
      // Start the tighter loop monitor once we know duration
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(tick);
    };

    const onEnded = () => safeLoop();

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("ended", onEnded);

    // If metadata was already loaded (e.g., SPA nav), apply immediately
    if (video.readyState >= 1) onLoadedMetadata();

    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("ended", onEnded);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, []);

  // Use debounced amount for quote calculations to reduce API calls
  const lamportsAmount = useMemo(() => {
    if (!debouncedAmount || !inputToken) return null;
    try {
      const dec = new Decimal(debouncedAmount);
      if (dec.lte(0)) return null;
      const raw = dec.mul(new Decimal(10).pow(inputToken.decimals)).toFixed(0, Decimal.ROUND_DOWN);
      const big = BigInt(raw);
      return big > 0n ? big : null;
    } catch {
      return null;
    }
  }, [debouncedAmount, inputToken]);
  
  const isBelowMinimum = useMemo(() => {
    if (!lamportsAmount || !inputToken) return false;
    if (inputToken.address === SOL_MINT) {
      return lamportsAmount < MINIMUM_BUY_LAMPORTS;
    }
    return false;
  }, [lamportsAmount, inputToken]);

  const inputBalanceQuery = useQuery<string>({
    queryKey: ["raceswap-token-balance", walletAddress, inputToken?.address],
    queryFn: async () => {
      if (!wallet.publicKey || !inputToken) return "0";
      return fetchTokenBalance(connection, wallet.publicKey, inputToken);
    },
    enabled: Boolean(wallet.publicKey && wallet.connected && inputToken),
    refetchInterval: 30000, // Reduced from 15s to lower API load
    staleTime: 15000,
  });

  const outputBalanceQuery = useQuery<string>({
    queryKey: ["raceswap-token-balance", walletAddress, outputToken?.address, "receive"],
    queryFn: async () => {
      if (!wallet.publicKey || !outputToken) return "0";
      return fetchTokenBalance(connection, wallet.publicKey, outputToken);
    },
    enabled: Boolean(wallet.publicKey && wallet.connected && outputToken),
    refetchInterval: 30000, // Reduced from 15s to lower API load
    staleTime: 15000,
  });

  // Fetch USD price for input token (used for reward likelihood preview)
  const inputTokenPriceQuery = useQuery<number>({
    queryKey: ["input-token-price", inputToken?.address],
    queryFn: async () => {
      if (!inputToken) return 0;
      if (inputToken.address === USDC_MINT) return 1;
      try {
        const stats = await api.getTokenStats(inputToken.address);
        return stats.currentPriceUsd || 0;
      } catch {
        return 0;
      }
    },
    enabled: Boolean(inputToken),
    staleTime: 30000, // Cache for 30 seconds
    refetchInterval: 60000, // Refetch every minute
  });

  // Fetch USD price for output token to display under "you receive"
  const outputTokenPriceQuery = useQuery<number>({
    queryKey: ["output-token-price", outputToken?.address],
    queryFn: async () => {
      if (!outputToken) return 0;
      if (outputToken.address === USDC_MINT) return 1;
      try {
        const stats = await api.getTokenStats(outputToken.address);
        return stats.currentPriceUsd || 0;
      } catch {
        return 0;
      }
    },
    enabled: Boolean(outputToken),
    staleTime: 30000, // Cache for 30 seconds
    refetchInterval: 60000, // Refetch every minute
  });

  // Fetch SOL USD price so card-drop odds can be expressed as "per 1 SOL" consistently.
  const solPriceQuery = useQuery<number>({
    queryKey: ["sol-price-usd"],
    queryFn: async () => {
      try {
        const prices = await api.getTokenPricesBatch([SOL_MINT]);
        const priceUsd = prices.find((p) => p.mint === SOL_MINT)?.priceUsd ?? 0;
        return priceUsd || 0;
      } catch {
        return 0;
      }
    },
    staleTime: 10 * 60_000,
    refetchInterval: 10 * 60_000,
  });

  const wsolBalanceQuery = useQuery<{
    ata: PublicKey;
    lamports: bigint;
    formatted: string;
  } | null>({
    queryKey: ["raceswap-wsol-balance", walletAddress],
    queryFn: async () => {
      if (!wallet.publicKey) return null;
      const wsolMint = new PublicKey(SOL_MINT);
      const ata = await getAssociatedTokenAddress(wsolMint, wallet.publicKey);
      const accountInfo = await connection.getAccountInfo(ata, "confirmed");
      if (!accountInfo) {
        return { ata, lamports: 0n, formatted: "0" };
      }
      const balanceInfo = await connection.getTokenAccountBalance(ata).catch(() => null);
      const lamports = balanceInfo ? BigInt(balanceInfo.value.amount) : 0n;
      return {
        ata,
        lamports,
        formatted: formatLamportsToSol(lamports, 6),
      };
    },
    enabled: Boolean(wallet.publicKey && wallet.connected),
    // Only fetch once per interaction; manual refetches follow wraps/unwraps.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  
  useEffect(() => {
    setPersistedWsolOnLoad(null);
  }, [walletAddress]);
  
  useEffect(() => {
    if (persistedWsolOnLoad === null && wsolBalanceQuery.data) {
      setPersistedWsolOnLoad(wsolBalanceQuery.data.lamports > 0n);
    }
  }, [persistedWsolOnLoad, wsolBalanceQuery.data]);

  // Debounce amount input to prevent excessive API calls while typing
  // Increased to 1000ms to reduce rate limiting issues
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedAmount(amount);
    }, 1000); // 1 second debounce delay
    return () => clearTimeout(timer);
  }, [amount]);
  
  const showWsolReminder =
    wallet.connected &&
    persistedWsolOnLoad === true &&
    Boolean(wsolBalanceQuery.data && wsolBalanceQuery.data.lamports > 0n);

  // Determine reflection token (Latest Winner)
  const mostRecentWinner = recentWinners?.[0];
  const winnerRunner = mostRecentWinner?.runners?.[mostRecentWinner.winnerIndex ?? 0];
  // Use most recent winner mint, fallback to RACE if unavailable
  const reflectionMint = winnerRunner?.mint ?? RACE_TOKEN_MINT.toString();
  const reflectionSymbolDisplay = winnerRunner?.symbol ?? reflectionMeta?.symbol ?? "RACE";
  const reflectionLogoURI = winnerRunner?.logoURI;

  const [quoteRefreshKey, setQuoteRefreshKey] = useState(0);
  
  const planQuery = useQuery<SwapPlan>({
    queryKey: [
      "raceswap-plan-v3",
      inputToken?.address,
      outputToken?.address,
      lamportsAmount?.toString(),
      slippageBps,
      reflectionBps,
      reflectionMint,
      sameTokenSwap,
      quoteRefreshKey,
    ],
    queryFn: async () => {
      console.log('[RaceSwap] Fetching quote...', {
        inputMint: inputToken!.address,
        outputMint: outputToken!.address,
        amount: Number(lamportsAmount ?? BigInt(0)),
      });
      try {
        const result = await getSwapPlan({
          inputMint: inputToken!.address,
          outputMint: outputToken!.address,
          amount: Number(lamportsAmount ?? BigInt(0)),
          slippageBps,
          reflectionMint,
          reflectionBps,
        });
        console.log('[RaceSwap] Quote result:', result);
        return result;
      } catch (error) {
        console.error('[RaceSwap] Quote error:', error);
        throw error;
      }
    },
    enabled: Boolean(
      inputToken &&
        outputToken &&
        lamportsAmount &&
        lamportsAmount > BigInt(0) &&
        !sameTokenSwap
    ),
    staleTime: 30000,
    gcTime: 0,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 2, // Retry failed requests up to 2 times
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff
  });
  
  const handleRefreshQuote = () => {
    setQuoteRefreshKey(prev => prev + 1);
  };
  
  const planData = sameTokenSwap ? undefined : planQuery.data;
  const isPlanLoading = planQuery.isLoading || planQuery.isFetching;
  const planError = planQuery.error;

  // Crate Tokens (Randomized recent winners)
  const crateTokens = useMemo(() => {
    const tokens = (recentWinners ?? [])
      .map((race) => {
        const runner = race.runners?.[race.winnerIndex ?? 0];
        if (!runner) return null;
        return { mint: runner.mint, symbol: runner.symbol, logoURI: runner.logoURI };
      })
      .filter(Boolean) as Array<{ mint: string; symbol: string; logoURI?: string }>;
    
    // Include the output token so the crate can land on it
    if (outputToken && !tokens.some(t => t.mint === outputToken.address)) {
      tokens.push({ 
        mint: outputToken.address, 
        symbol: outputToken.symbol, 
        logoURI: outputToken.logoURI 
      });
    }
      
    // Shuffle
    for (let i = tokens.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
    }
    
    return tokens;
  }, [recentWinners, outputToken]);

  const isSwapping = isExecuting;

  const primaryDisabled =
    !wallet.connected ||
    !planData ||
    isPlanLoading ||
    !lamportsAmount ||
    lamportsAmount <= 0n ||
    isSwapping ||
    sameTokenSwap ||
    isBelowMinimum;
    
  // Show live amount while typing, but use debounced amount for calculations
  const displayAmount = amount || debouncedAmount;
  
  const planMainOut = useMemo(() => {
    if (!planData || !outputToken) return "--";
    return formatAmount(planData.mainSwapAmount, outputToken.decimals);
  }, [planData, outputToken]);

  const planReflectionOut = useMemo(() => {
    if (!planData) return "0";
    const decimals = reflectionMeta?.decimals ?? 6; 
    return formatAmount(planData.reflectionAmount, decimals);
  }, [planData, reflectionMeta]);

  const dropEligibility = useMemo(() => {
    if (!raceswapConfig || !planData || !inputToken || !outputToken || !lamportsAmount) return null;

    const minSol = Number.parseFloat(String((raceswapConfig as any).dropMinSol ?? "0.1"));
    const minUsdc = Number.parseFloat(String((raceswapConfig as any).dropMinUsdc ?? "10"));
    const minSolSafe = Number.isFinite(minSol) && minSol > 0 ? minSol : 0.1;
    const minUsdcSafe = Number.isFinite(minUsdc) && minUsdc > 0 ? minUsdc : 10;

    // Use the debounced input amount (source of truth) rather than relying on plan fields.
    const inputBase = lamportsAmount.toString();
    const outputBase = (planData as any).mainSwapAmount ?? (planData as any).mainAmount ?? "0";

    let inputHuman = 0;
    let outputHuman = 0;
    try {
      inputHuman = new Decimal(String(inputBase)).div(new Decimal(10).pow(inputToken.decimals)).toNumber();
    } catch {
      inputHuman = 0;
    }
    try {
      outputHuman = new Decimal(String(outputBase)).div(new Decimal(10).pow(outputToken.decimals)).toNumber();
    } catch {
      outputHuman = 0;
    }

    const inputSol = inputToken.address === SOL_MINT && inputHuman >= minSolSafe;
    const outputSol = outputToken.address === SOL_MINT && outputHuman >= minSolSafe;
    const inputUsdc = inputToken.address === USDC_MINT && inputHuman >= minUsdcSafe;
    const outputUsdc = outputToken.address === USDC_MINT && outputHuman >= minUsdcSafe;

    const eligible = inputSol || outputSol || inputUsdc || outputUsdc;
    return {
      eligible,
      minSol: minSolSafe,
      minUsdc: minUsdcSafe,
      inputSol,
      outputSol,
      inputUsdc,
      outputUsdc,
    };
  }, [raceswapConfig, planData, inputToken, outputToken, lamportsAmount]);

  const previewSwapUsdValue = useMemo(() => {
    // Best-effort client-side estimate, shown only after quote loads.
    if (!planData || !inputToken || !outputToken || !lamportsAmount) return null;

    // Use the debounced input amount (source of truth) rather than relying on plan fields.
    const inputBase = lamportsAmount.toString();
    const outputBase = (planData as any).mainSwapAmount ?? (planData as any).mainAmount ?? "0";

    let inputHuman = 0;
    let outputHuman = 0;
    try {
      inputHuman = new Decimal(String(inputBase)).div(new Decimal(10).pow(inputToken.decimals)).toNumber();
    } catch {
      inputHuman = 0;
    }
    try {
      outputHuman = new Decimal(String(outputBase)).div(new Decimal(10).pow(outputToken.decimals)).toNumber();
    } catch {
      outputHuman = 0;
    }

    const inputPrice = inputToken.address === USDC_MINT ? 1 : (inputTokenPriceQuery.data ?? 0);
    const outputPrice = outputToken.address === USDC_MINT ? 1 : (outputTokenPriceQuery.data ?? 0);

    const inputUsd = inputPrice > 0 ? inputHuman * inputPrice : 0;
    const outputUsd = outputPrice > 0 ? outputHuman * outputPrice : 0;
    const usdValue = Math.max(inputUsd, outputUsd);
    if (!Number.isFinite(usdValue) || usdValue <= 0) return null;
    return Math.min(usdValue, 10000);
  }, [planData, inputToken, outputToken, lamportsAmount, inputTokenPriceQuery.data, outputTokenPriceQuery.data]);

  const showRewardPreview = Boolean(planData && !isPlanLoading && !planError);

  const rewardLikelihoodPreview = useMemo(() => {
    // Mirror server-side formulas in /api/raceswap/swap-rewards (best-effort; server still enforces gates).
    if (!showRewardPreview || !dropEligibility) return null;
    const usdValue = previewSwapUsdValue;
    if (!usdValue || !Number.isFinite(usdValue)) {
      return { eligible: dropEligibility.eligible, cardWinProbability: null, raceWinProbability: null };
    }

    const eligibleForDrops = dropEligibility.eligible;
    const holderBoostMultiplier = holderBoostPreviewQuery.data?.multiplier ?? 1;
    const safeHolderBoost = Number.isFinite(holderBoostMultiplier) && holderBoostMultiplier > 0 ? holderBoostMultiplier : 1;

    // $RACE reward probability
    const raceBase = 0.0125;
    const raceScaled = Math.min((usdValue / 500) * 0.002, 0.04);
    const raceBoostMultiplier = 1 + (safeHolderBoost - 1) * 0.5;
    const raceWinProbability = eligibleForDrops ? Math.min((raceBase + raceScaled) * raceBoostMultiplier, 0.08) : 0;

    // Card drop probability (client-side uses eligibility + holder boost only; server may disable via env/pool)
    const DEFAULT_SOL_PRICE_USD = 122.67;
    const solPriceUsdRaw = solPriceQuery.data ?? 0;
    const solPriceUsd =
      Number.isFinite(solPriceUsdRaw) && solPriceUsdRaw > 0 ? solPriceUsdRaw : DEFAULT_SOL_PRICE_USD;

    // Default: 1 in 80 per 1 SOL swap (optimized for 2.5% Gacha Treasury Fee).
    // Old system was 1 in 400, with 5x revenue increase we give 5x better odds.
    const ONE_IN_PER_SOL = 80;
    const PROBABILITY_CAP = 0.25;

    const solEquivalent = solPriceUsd > 0 ? usdValue / solPriceUsd : 0;
    const baseProbability = solEquivalent > 0 ? solEquivalent / ONE_IN_PER_SOL : 0;
    const cardWinProbability = eligibleForDrops ? Math.min(baseProbability * safeHolderBoost, PROBABILITY_CAP) : 0;

    return {
      eligible: eligibleForDrops,
      cardWinProbability,
      raceWinProbability,
    };
  }, [
    showRewardPreview,
    dropEligibility,
    previewSwapUsdValue,
    holderBoostPreviewQuery.data?.multiplier,
    solPriceQuery.data,
  ]);

  // Calculate actual reflection percentage for display/debugging
  const reflectionPercentageActual = useMemo(() => {
    if (!planData || !lamportsAmount || lamportsAmount <= 0n) return null;
    // planData.reflectionAmount is the OUTPUT tokens received from reflection swap
    // We need to calculate what percentage of INPUT was used for reflection
    // The reflection input amount would be: reflectionBps / 10000 * lamportsAmount
    const reflectionInputAmount = Math.floor(Number(lamportsAmount) * (reflectionBps / 10000));
    const reflectionInputPercent = (reflectionInputAmount / Number(lamportsAmount)) * 100;
    return reflectionInputPercent;
  }, [planData, lamportsAmount, reflectionBps]);

  const rentTotalLamports =
    BigInt(accountSetupState.accounts.length) * BigInt(accountSetupState.rentLamports || 0);
  const totalSetupCostLamports =
    rentTotalLamports + (accountSetupState.wsolTopUpLamports ?? 0n);
  const totalSetupCostSol = totalSetupCostLamports > 0n
    ? formatLamportsToSol(totalSetupCostLamports)
    : "0";
  const rentLockedSol = rentTotalLamports > 0n ? formatLamportsToSol(rentTotalLamports) : "0";
  const wsolTopUpSol = accountSetupState.wsolTopUpLamports > 0n
    ? formatLamportsToSol(accountSetupState.wsolTopUpLamports)
    : null;
  const perAccountCostSol = accountSetupState.rentLamports
    ? formatLamportsToSol(accountSetupState.rentLamports)
    : "0";

  async function detectPreparationNeeds(requiredSolLamports: bigint): Promise<{
    accounts: MissingAccountInfo[];
    wsolTopUpLamports: bigint;
  }> {
    if (!wallet.publicKey || !inputToken || !outputToken || !raceswapConfig || !planData) {
      return { accounts: [], wsolTopUpLamports: 0n };
    }

    type Requirement = {
      mintAddress: string;
      mintSymbol: string;
      label: string;
      owner: PublicKey;
      ownerLabel: string;
      category: AccountCategory;
    };

    const requirements: Requirement[] = [];
    const programCache = new Map<string, PublicKey>();

    const fetchProgramId = async (mintAddress: string): Promise<PublicKey> => {
      if (mintAddress === SOL_MINT) {
        return TOKEN_PROGRAM_ID;
      }
      if (programCache.has(mintAddress)) {
        return programCache.get(mintAddress)!;
      }
      const programId = await getMintTokenProgramId(connection, new PublicKey(mintAddress));
      programCache.set(mintAddress, programId);
      return programId;
    };

    const addRequirement = (requirement: Requirement) => {
      if (!requirements.find((req) => req.mintAddress === requirement.mintAddress && req.owner.equals(requirement.owner))) {
        requirements.push(requirement);
      }
    };

    if (inputToken.address === SOL_MINT) {
      addRequirement({
        mintAddress: SOL_MINT,
        mintSymbol: "WSOL",
        label: "SOL wrapper account",
        owner: wallet.publicKey,
        ownerLabel: "Your wallet",
        category: "user",
      });
    }

    addRequirement({
      mintAddress: outputToken.address,
      mintSymbol: outputToken.symbol,
      label: `${outputToken.symbol} destination`,
      owner: wallet.publicKey,
      ownerLabel: "Your wallet",
      category: "user",
    });

    const reflectionMintAddress = planData.reflectionMeta?.mint || reflectionMint;
    const reflectionDisabled = planData.disableReflection;
    // Lucky Buy disabled - no reflection ATA required

    if (raceswapConfig.swapAuthority) {
      addRequirement({
        mintAddress: inputToken.address,
        mintSymbol: inputToken.symbol || "Input",
        label: `${inputToken.symbol || "Input"} swap authority`,
        owner: new PublicKey(raceswapConfig.swapAuthority),
        ownerLabel: "Raceswap program authority",
        category: "program",
      });
    }

    if (raceswapConfig.treasuryWallet) {
      addRequirement({
        mintAddress: outputToken.address,
        mintSymbol: outputToken.symbol || "Output",
        label: `${outputToken.symbol || "Output"} treasury`,
        owner: new PublicKey(raceswapConfig.treasuryWallet),
        ownerLabel: "Raceswap treasury",
        category: "program",
      });
    }

    const requiresWsolTopUp = inputToken.address === SOL_MINT && requiredSolLamports > 0n;
    let wsolTopUpLamports = 0n;
    if (requiresWsolTopUp) {
      const wsolMint = new PublicKey(SOL_MINT);
      const wsolAta = await getAssociatedTokenAddress(wsolMint, wallet.publicKey);
      const wsolAccountInfo = await connection.getAccountInfo(wsolAta, "confirmed");
      if (!wsolAccountInfo) {
        wsolTopUpLamports = requiredSolLamports;
      } else {
        const balanceInfo = await connection.getTokenAccountBalance(wsolAta).catch(() => null);
        const currentBalance = balanceInfo ? BigInt(balanceInfo.value.amount) : 0n;
        if (currentBalance < requiredSolLamports) {
          wsolTopUpLamports = requiredSolLamports - currentBalance;
        }
      }
    }

    if (!requirements.length) {
      return { accounts: [], wsolTopUpLamports };
    }

    const resolved = await Promise.all(
      requirements.map(async (req) => {
        const mintKey = new PublicKey(req.mintAddress);
        const tokenProgramId = await fetchProgramId(req.mintAddress);
        const ata = await getAssociatedTokenAddress(
          mintKey,
          req.owner,
          true,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return {
          ata,
          mint: mintKey,
          mintSymbol: req.mintSymbol,
          label: req.label,
          owner: req.owner,
          ownerLabel: req.ownerLabel,
          tokenProgramId,
          category: req.category,
        };
      })
    );

    const ataInfos = await connection.getMultipleAccountsInfo(resolved.map((item) => item.ata));
    return {
      accounts: resolved.filter((_, idx) => !ataInfos[idx]),
      wsolTopUpLamports,
    };
  }

  async function handleSwap() {
    if (sameTokenSwap) {
      toast({
        title: "Select different tokens",
        description: "Input and output tokens must be different to create a swap.",
        variant: "destructive",
      });
      return;
    }
    if (!planData || !wallet.publicKey) {
      toast({ title: "Missing data", description: "Connect your wallet and preview a plan first.", variant: "destructive" });
      return;
    }
    if (!raceswapConfig) {
      toast({
        title: "Config unavailable",
        description: "Unable to load Raceswap settings. Please try again.",
        variant: "destructive",
      });
      return;
    }

    // Note: Account setup is no longer needed - ATAs are created idempotently within the swap transaction
    
    // For token swaps (not SOL), fetch actual balance and ensure we use full amount if close
    // This prevents small leftover balances that confuse Phantom's simulation
    let swapAmount = Number(lamportsAmount);
    if (inputToken && inputToken.address !== SOL_MINT) {
      try {
        const actualBalanceStr = await fetchTokenBalance(connection, wallet.publicKey, inputToken);
        const actualBalance = parseFloat(actualBalanceStr);
        const requestedAmount = parseFloat(debouncedAmount || amount);
        
        if (!isNaN(actualBalance) && actualBalance > 0) {
          // Convert actual balance to base units
          const actualBalanceBase = BigInt(
            new Decimal(actualBalance)
              .mul(new Decimal(10).pow(inputToken.decimals))
              .toFixed(0, Decimal.ROUND_DOWN)
          );
          
          const requestedBase = BigInt(swapAmount);
          
          // More aggressive: If requested amount is within 5% of actual balance, use full balance
          // This prevents even small leftovers (like 0.13 USDC) that trigger Phantom warnings
          const balanceThreshold = actualBalanceBase * BigInt(95) / BigInt(100);
          
          if (requestedBase >= balanceThreshold) {
            // Use full balance to avoid leftover
            swapAmount = Number(actualBalanceBase);
            const usedPercent = (Number(requestedBase) / Number(actualBalanceBase) * 100).toFixed(2);
            console.log(`🔄 Using full balance ${actualBalance} ${inputToken.symbol} (requested ${usedPercent}%, avoiding leftover)`);
          } else if (requestedBase > actualBalanceBase) {
            // Requested more than available, use available
            swapAmount = Number(actualBalanceBase);
            console.log(`⚠️ Requested ${requestedAmount} but only have ${actualBalance}, using full balance`);
            toast({
              title: "Insufficient balance",
              description: `Using full balance: ${actualBalance} ${inputToken.symbol}`,
              variant: "default",
            });
          } else {
            // Requested less than 95% - warn about potential leftover
            const leftoverEstimate = actualBalance - requestedAmount;
            if (leftoverEstimate > 0.01) { // More than 0.01 tokens leftover
              console.log(`⚠️ Swap will leave ~${leftoverEstimate.toFixed(6)} ${inputToken.symbol} (${(leftoverEstimate/actualBalance*100).toFixed(2)}%)`);
            }
          }
        }
      } catch (error) {
        console.warn("Failed to fetch actual balance, using requested amount:", error);
      }
    }
    
    // Store receipt data before clearing inputs
    const currentReceiptData: ReceiptData = {
        spentAmount: debouncedAmount || amount,
        spentSymbol: inputToken?.symbol,
        spentLogo: inputToken?.logoURI,
        receivedAmount: planMainOut,
        receivedSymbol: outputToken?.symbol,
        receivedLogo: outputToken?.logoURI,
    };
    
    // Don't show modal yet - wait for wallet confirmation
    setShowReceipt(false);
    setReceiptData(null);
    setSwapSuccess(false);
    setIsExecuting(true);
    setSwapStage("base");
    
    try {
      // PERFORMANCE: Pass prefetched quote to avoid redundant API calls
      // This saves 200-400ms by reusing the quote we already have from planQuery
      const result = await executeSwapWithReflection(connection, wallet, {
         inputMint: inputToken!.address,
         outputMint: outputToken!.address,
         amount: swapAmount, // Use calculated amount (may be full balance for tokens)
         slippageBps,
         reflectionMint: undefined,
         reflectionBps: 0 // Base swap only
      }, { 
        onStageChange: setSwapStage,
        // Pass the quote from planQuery to skip re-fetching
        prefetchedQuote: planData?.mainQuote,
        // Skip pre-wallet simulation - Phantom will simulate anyway
        skipSimulation: true,
      });
      
      // Wallet confirmed and swap succeeded - NOW show modal and start spinning!
      // This ensures the CSGO-style reveal only begins after user confirms in wallet
      setCrateKey((prev) => prev + 1);
      setShowSuccessModal(true);
      setCrateSpinning(true);
      
      // Check swap rewards (RACE bonus + rare NFT card), provably fair using blockhash.
      // We wait for this before showing receipt so the reveal lands on the final result.
      let boostedReward: ReceiptData["boostedReward"] | undefined;
      let cardReward: ReceiptData["cardReward"] | undefined;
      let holderBoost: ReceiptData["holderBoost"] | undefined;
      if (result.mainSignature && wallet.publicKey && inputToken) {
        try {
          setSwapStage("checking-rewards");

          // Always use the combined endpoint so the main /raceswap page is ready for NFT drops
          // once enabled server-side. The test page simply sends a header to bypass the env gate.
          const rewardResult = await api.checkSwapRewards(
            {
              signature: result.mainSignature,
              recipient: wallet.publicKey.toBase58(),
            },
            { testMode: isTestSwapPage }
          );

          holderBoost = rewardResult.holderBoost
            ? {
                raceBalanceUi: rewardResult.holderBoost.raceBalanceUi,
                tier: rewardResult.holderBoost.tier,
                multiplier: rewardResult.holderBoost.multiplier,
                nextTier: rewardResult.holderBoost.nextTier,
                nextTierTargetUi: rewardResult.holderBoost.nextTierTargetUi,
                progressToNext: rewardResult.holderBoost.progressToNext,
              }
            : undefined;

          boostedReward = {
            won: rewardResult.raceReward.won,
            rewardAmount: rewardResult.raceReward.rewardAmountBase || undefined,
            rewardSignature: rewardResult.raceReward.rewardSignature || undefined,
            blockhash: rewardResult.blockhash || undefined,
            seed: rewardResult.seed,
            slot: rewardResult.slot,
            recipient: rewardResult.recipient,
            randomValue: rewardResult.raceReward.roll,
            winProbability: rewardResult.raceReward.winProbability,
            usdValue: rewardResult.usdValue,
            transactionSignature: rewardResult.transactionSignature || result.mainSignature,
            error: rewardResult.raceReward.error || rewardResult.error || undefined,
          };

          cardReward = {
            enabled: rewardResult.cardReward.enabled,
            disabledReason: rewardResult.cardReward.disabledReason ?? null,
            won: rewardResult.cardReward.won,
            mint: rewardResult.cardReward.mint,
            rewardSignature: rewardResult.cardReward.rewardSignature,
            blockhash: rewardResult.blockhash,
            seed: rewardResult.seed,
            slot: rewardResult.slot,
            recipient: rewardResult.recipient,
            randomValue: rewardResult.cardReward.roll,
            winProbability: rewardResult.cardReward.winProbability,
            poolHash: rewardResult.cardReward.inventory.poolHash,
            poolSize: rewardResult.cardReward.inventory.poolSize,
            pickRoll: rewardResult.cardReward.pickRoll,
            pickIndex: rewardResult.cardReward.pickIndex,
            error: rewardResult.cardReward.error,
          };

          // Mutually exclusive reward toasts (card takes priority).
          if (rewardResult.cardReward.won && rewardResult.cardReward.mint) {
            toast({
              title: "Swap Reward Won!",
              description: `Card drop sent: ${rewardResult.cardReward.mint.slice(0, 6)}…`,
            });
          } else if (rewardResult.raceReward.won && rewardResult.raceReward.rewardSignature) {
            toast({
              title: "Swap Reward Won!",
              description: `You won ${
                rewardResult.raceReward.rewardAmountBase
                  ? (parseFloat(rewardResult.raceReward.rewardAmountBase) / 1e6).toFixed(0)
                  : ""
              } RACE tokens!`,
            });
          }
        } catch (error: any) {
          console.error("[raceswap] swap-rewards check failed:", error);
          // Don't block swap success if reward check fails, but still show a clear receipt row.
          const msg = String(error?.message || error || "Swap rewards check failed");
          boostedReward = {
            won: false,
            error: msg,
          };
          cardReward = {
            enabled: false,
            disabledReason: "verification_failed",
            won: false,
            error: msg,
          };
        }
      }
      
      // Store final receipt data with swap results
      // Look up winning card metadata if a card was won
      let winningCard: PokemonCardNft | null = null;
      if (cardReward?.won && cardReward?.mint) {
        const cardItems = pokemonCardsForReelQuery.data?.items || [];
        winningCard = cardItems.find(c => c.mint === cardReward.mint) || null;
      }
      
      const finalReceiptData: ReceiptData = {
        ...currentReceiptData,
        mainSignature: result.mainSignature,
        boostedReward,
        cardReward,
        holderBoost,
        winningCard,
      };
      
      setReceiptData(finalReceiptData);
      
      // Only trigger landing animation after receipt is ready (including boosted reward)
      // This ensures the spin continues while we wait for blockhash/boosted reward check
      // The crate will keep spinning until swapSuccess is true
      setSwapSuccess(true);
      setIsExecuting(false);
      setSwapStage(null);
      // Note: crateSpinning stays true - it will keep the crate spinning until swapSuccess triggers landing
      
      // Save tokens to custom list only after successful swap
      // Only save if they were pasted (in tempTokens) and not already in Jupiter/owned/custom lists
      if (inputToken && tempTokens.find(t => t.address === inputToken.address)) {
        // Check if it's already in the permanent lists (Jupiter, owned, or custom)
        const inJupiter = tokenList?.some(t => t.address === inputToken.address);
        const inOwned = ownedTokens?.some(t => t.address === inputToken.address);
        const inCustom = customTokens.some(t => t.address === inputToken.address);
        
        if (!inJupiter && !inOwned && !inCustom) {
          saveCustomToken(walletAddress, inputToken);
          setCustomTokensVersion((v) => v + 1);
        }
      }
      if (outputToken && tempTokens.find(t => t.address === outputToken.address)) {
        // Check if it's already in the permanent lists
        const inJupiter = tokenList?.some(t => t.address === outputToken.address);
        const inOwned = ownedTokens?.some(t => t.address === outputToken.address);
        const inCustom = customTokens.some(t => t.address === outputToken.address);
        
        if (!inJupiter && !inOwned && !inCustom) {
          saveCustomToken(walletAddress, outputToken);
          setCustomTokensVersion((v) => v + 1);
        }
      }
      
      // Clear temp tokens since they're now saved (or were already in the list)
      setTempTokens([]);
      
      toast({
        title: "Swap complete",
        description: `Tx: ${result.signature.slice(0, 8)}…`,
      });
      
      // Send swap notification to Telegram (fire and forget)
      // Use pre-captured currentReceiptData to ensure values are stable
      const notificationData = {
        spentAmount: currentReceiptData.spentAmount || "0",
        spentSymbol: currentReceiptData.spentSymbol || "???",
        spentLogo: currentReceiptData.spentLogo,
        // Use result.mainSwapAmount as source of truth (already in base units, need to format)
        receivedAmount: currentReceiptData.receivedAmount !== "--" 
          ? currentReceiptData.receivedAmount 
          : (result.mainSwapAmount || "0"),
        receivedSymbol: currentReceiptData.receivedSymbol || "???",
        receivedLogo: currentReceiptData.receivedLogo,
        mainSignature: result.mainSignature,
        boostedReward: boostedReward ? {
          won: boostedReward.won,
          rewardAmount: boostedReward.rewardAmount,
          rewardSignature: boostedReward.rewardSignature,
        } : undefined,
        cardReward: cardReward ? {
          won: cardReward.won,
          mint: cardReward.mint,
          rewardSignature: cardReward.rewardSignature,
        } : undefined,
      };
      
      try {
        console.log("[raceswap] Sending swap notification:", notificationData);
        const notifyResponse = await fetch("/api/raceswap/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(notificationData),
        });
        
        if (!notifyResponse.ok) {
          console.warn("[raceswap] Notification failed with status:", notifyResponse.status);
        } else {
          console.log("[raceswap] Swap notification sent successfully");
        }
      } catch (err) {
        // Silently fail - notification is not critical
        console.log("[raceswap] Swap notification error:", err);
      }
      
      setAmount("");
      
      // Immediately refetch balances and plan
      planQuery.refetch();
      inputBalanceQuery.refetch();
      outputBalanceQuery.refetch();
      wsolBalanceQuery.refetch();
      
      // Clear owned tokens cache and refetch immediately
      clearOwnedTokensCache(walletAddress);
      if (wallet.publicKey && wallet.connected) {
        refetchOwnedTokens();
      }

      // Invalidate token selector caches so its "Your tokens" list updates quickly after swaps.
      // Without this, the selector may show stale balances/prices for up to its staleTime.
      if (walletAddress) {
        queryClient.invalidateQueries({ queryKey: ["token-balances-v2", walletAddress] });
      }
      
      // Aggressive refetching with retries to catch balance updates as transaction settles
      // Transaction confirmation doesn't always mean balances are immediately updated
      const refetchBalances = () => {
        inputBalanceQuery.refetch();
        outputBalanceQuery.refetch();
        wsolBalanceQuery.refetch();
        if (wallet.publicKey && wallet.connected) {
          refetchOwnedTokens();
        }
        if (walletAddress) {
          queryClient.invalidateQueries({ queryKey: ["token-balances-v2", walletAddress] });
        }
      };
      
      // Refetch after 1 second (transaction usually confirmed by now)
      setTimeout(refetchBalances, 1000);
      // Refetch after 2 seconds (balances should be updated)
      setTimeout(refetchBalances, 2000);
      // Refetch after 4 seconds (final check to ensure balances are accurate)
      setTimeout(refetchBalances, 4000);
    } catch (error: any) {
      console.error("[raceswap] Swap error:", error);
      // Close modal on error
      setShowSuccessModal(false);
      setCrateSpinning(false);
      setSwapSuccess(false);
      setSwapStage(null);
      
      let errorMessage = error?.message || "Unknown error";
      toast({
        title: "Swap failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsExecuting(false);
      setSwapStage(null);
    }
  }

  const handleDismissAccountSetup = () => {
    if (accountSetupState.submitting) return;
    setAccountSetupState((prev) => ({
      open: false,
      accounts: [],
      rentLamports: prev.rentLamports,
      pairLabel: "",
      submitting: false,
      wsolTopUpLamports: 0n,
      wsolRequiredLamports: 0n,
      finalizing: false,
      statusMessage: undefined,
      error: undefined,
    }));
  };

  async function handleConfirmAccountSetup() {
    if (!wallet.publicKey) {
      toast({
        title: "Wallet required",
        description: "Connect your wallet to prepare accounts.",
        variant: "destructive",
      });
      return;
    }
    if (!accountSetupState.accounts.length && accountSetupState.wsolTopUpLamports === 0n) {
      handleDismissAccountSetup();
      return;
    }

    const walletPubkey = wallet.publicKey!;
    const accountsToVerify = accountSetupState.accounts;
    const requiredWsolLamports = accountSetupState.wsolRequiredLamports;

    setAccountSetupState((prev) => ({
      ...prev,
      submitting: true,
      finalizing: false,
      statusMessage: undefined,
      error: undefined,
    }));

    try {
      const transaction = new Transaction();
      accountsToVerify.forEach((account) => {
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            walletPubkey,
            account.ata,
            account.owner,
            account.mint,
            account.tokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      });

      if (accountSetupState.wsolTopUpLamports > 0n) {
        if (accountSetupState.wsolTopUpLamports > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("SOL amount too large for single wrap transaction.");
        }
        const wsolAta = await getAssociatedTokenAddress(new PublicKey(SOL_MINT), walletPubkey);
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: walletPubkey,
            toPubkey: wsolAta,
            lamports: Number(accountSetupState.wsolTopUpLamports),
          }),
          createSyncNativeInstruction(wsolAta)
        );
      }

      transaction.feePayer = walletPubkey;
      const latestBlockhash = await connection.getLatestBlockhash();
      transaction.recentBlockhash = latestBlockhash.blockhash;
      const signature = await wallet.sendTransaction(transaction, connection, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed"
      );

      setAccountSetupState((prev) => ({
        ...prev,
        finalizing: true,
        statusMessage: "Waiting for final confirmation…",
      }));

      const finalized = await waitForFinalizedSignature(connection, signature);
      let accountsReady = true;
      let wsolReady = true;

      if (accountsToVerify.length) {
        setAccountSetupState((prev) => ({
          ...prev,
          statusMessage: "Verifying newly created token accounts…",
        }));
        const atas = accountsToVerify.map((account) => account.ata);
        accountsReady = await waitForAccountsToExist(connection, atas);
      }

      if (requiredWsolLamports > 0n) {
        setAccountSetupState((prev) => ({
          ...prev,
          statusMessage: "Checking SOL wrapper funding…",
        }));
        wsolReady = await waitForWsolBalance(connection, walletPubkey, requiredWsolLamports);
      }

      setAccountSetupState({
        open: false,
        accounts: [],
        rentLamports: 0,
        pairLabel: "",
        submitting: false,
        wsolTopUpLamports: 0n,
        wsolRequiredLamports: 0n,
        finalizing: false,
        statusMessage: undefined,
        error: undefined,
      });

      const waitSucceeded = finalized && accountsReady && wsolReady;
      toast({
        title: waitSucceeded ? "Accounts ready" : "Accounts finalizing",
        description: waitSucceeded
          ? `Setup tx: ${signature.slice(0, 8)}…`
          : `Setup tx ${signature.slice(0, 8)}… is still settling. Waiting a few seconds before swapping avoids Phantom warnings.`,
      });

      await Promise.all([
        planQuery.refetch(),
        inputBalanceQuery.refetch(),
        outputBalanceQuery.refetch(),
        wsolBalanceQuery.refetch(),
      ]);
    } catch (error: any) {
      console.error("[raceswap] Account setup failed:", error);
      setAccountSetupState((prev) => ({
        ...prev,
        submitting: false,
        finalizing: false,
        statusMessage: undefined,
        error: error?.message || "Failed to create accounts.",
      }));
    }
  }

  async function handleUnwrapWsol() {
    if (!wallet.publicKey) {
      toast({
        title: "Wallet required",
        description: "Connect your wallet to unwrap SOL.",
        variant: "destructive",
      });
      return;
    }
    const wsolInfo = wsolBalanceQuery.data;
    if (!wsolInfo || wsolInfo.lamports <= 0n) {
      toast({
        title: "No wrapped SOL detected",
        description: "Your SOL is already unwrapped.",
      });
      return;
    }
    setIsUnwrappingWsol(true);
    try {
      const transaction = new Transaction().add(
        createCloseAccountInstruction(
          wsolInfo.ata,
          wallet.publicKey,
          wallet.publicKey
        )
      );
      transaction.feePayer = wallet.publicKey;
      const latestBlockhash = await connection.getLatestBlockhash();
      transaction.recentBlockhash = latestBlockhash.blockhash;
      const signature = await wallet.sendTransaction(transaction, connection, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed"
      );
      await waitForFinalizedSignature(connection, signature);
      const amountSol = formatLamportsToSol(wsolInfo.lamports);
      toast({
        title: "Unwrapped SOL",
        description: `${amountSol} SOL returned to your wallet.`,
      });
      await Promise.all([
        wsolBalanceQuery.refetch(),
        inputBalanceQuery.refetch(),
      ]);
    } catch (error: any) {
      console.error("[raceswap] Unwrap WSOL failed:", error);
      toast({
        title: "Unwrap failed",
        description: error?.message || "Unable to unwrap SOL. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsUnwrappingWsol(false);
    }
  }

  const handleCloseModal = () => {
      setShowSuccessModal(false);
      setCrateSpinning(false);
      setSwapSuccess(false);
      setShowReceipt(false);
  };

  const handleMax = () => {
    if (!inputBalanceQuery.data || !inputToken) return;
    let val = inputBalanceQuery.data;
    if (inputToken.address === SOL_MINT) {
       const num = parseFloat(val);
       if (!isNaN(num) && num > 0.02) {
          val = (num - 0.01).toFixed(4); // Leave 0.01 SOL for fees
       }
    } else {
      // For tokens, use full balance (Jupiter handles fees from output)
      // This prevents leftover balances that confuse Phantom simulation
      const num = parseFloat(val);
      if (!isNaN(num) && num > 0) {
        // Use full balance with appropriate precision
        const decimals = inputToken.decimals || 6;
        val = num.toFixed(decimals).replace(/\.?0+$/, "");
      }
    }
    setAmount(val);
  };

  const handleHalf = () => {
    // If user has entered a value, half it
    const currentVal = parseFloat(amount);
    if (!isNaN(currentVal) && currentVal > 0) {
       setAmount((currentVal / 2).toFixed(6).replace(/\.?0+$/, ""));
       return;
    }
    // Fallback to half balance
    if (!inputBalanceQuery.data) return;
    const num = parseFloat(inputBalanceQuery.data);
    if (!isNaN(num)) {
       setAmount((num / 2).toFixed(6).replace(/\.?0+$/, ""));
    }
  };

  const handleFlipTokens = () => {
     const temp = inputToken;
     setInputToken(outputToken);
     setOutputToken(temp);
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-x-clip">
      <div className="container relative mx-auto flex w-full flex-1 flex-col items-center justify-center gap-2 px-3 py-1 sm:px-4 md:gap-3 md:py-2 max-w-7xl min-h-0">
        <div className="relative z-10 w-full">
          <section className="text-center space-y-1 relative">
            <div className="relative max-w-4xl mx-auto">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 relative">
                <div></div>
                <div className="relative">
                  <h1 className="text-3xl md:text-4xl lg:text-5xl swap-rip-title">
                    SWAP&RIP
                  </h1>
                </div>
                <div></div>
              </div>
            </div>
            {/* Subtitle with fixed height to prevent layout shifts - hidden on mobile */}
            <div className="hidden md:flex min-h-[1.25rem] items-center justify-center">
              <RotatingTagline />
            </div>
          </section>

          {/* Mobile Card Showcase - shown only on mobile, above swap UI */}
          <div className="xl:hidden w-full max-w-xl mx-auto mt-2 px-0">
            <MobileCardShowcase 
              connection={connection} 
              walletAddress={walletAddress}
              hideStats={true}
            />
          </div>

          <div className="grid w-full justify-items-center gap-3">
            <div className="swap-card-scale w-full">
              <Card className="w-full max-w-xl xl:max-w-[1160px] rounded-2xl border-none bg-[#13141b] shadow-2xl ring-1 ring-white/10 overflow-hidden">
                <div className="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)_360px]">
                  {/* LEFT: On-chain Pokemon cards (desktop only) */}
                  <aside className="hidden xl:flex flex-col border-r border-white/5 bg-[#0d0f16]/20 p-2">
                    <PokemonCardRail connection={connection} walletAddress={walletAddress} />
                  </aside>

                  {/* LEFT: main swap UI */}
                  <div className="min-w-0">
                    <div className="w-full">
                      {/* Swap Stats Bar - Card Drop Rates - now visible on mobile too */}
                      <div className="px-3 py-2 border-b border-white/5">
                        <SwapStatsBar 
                          walletAddress={walletAddress}
                          holderBoost={holderBoostPreviewQuery.data}
                        />
                      </div>

                      <CardContent className="flex-1 space-y-3 p-4 md:p-5">
            {showWsolReminder && wsolBalanceQuery.data && (
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-primary">Wrapped SOL from last session</p>
                  <p className="text-xs text-muted-foreground">
                    {wsolBalanceQuery.data.formatted} SOL is ready to unwrap back to your wallet.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUnwrapWsol}
                  disabled={isUnwrappingWsol || isSwapping}
                  className="mt-2 sm:mt-0"
                >
                  {isUnwrappingWsol ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Unwrapping...
                    </>
                  ) : (
                    "Unwrap to SOL"
                  )}
                </Button>
              </div>
            )}

            {/* PAY SECTION */}
            <div className="bg-[#1c1e26] rounded-xl p-3 sm:p-4 space-y-2 border border-white/5 hover:border-white/10 transition-colors">
              <div className="flex justify-between text-xs text-muted-foreground items-center">
                <div className="flex items-center gap-1.5">
                  <span>You pay</span>
                  {planData && !isPlanLoading && !planError && dropEligibility ? (
                    <TooltipProvider>
                      <UiTooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground hover:text-foreground hover:bg-white/5"
                            aria-label="Card drop eligibility"
                          >
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[320px] text-[11px] leading-snug p-3">
                          <div className="space-y-2">
                            <div className="font-semibold text-foreground">Card drop eligibility</div>
                            <div className={dropEligibility.eligible ? "text-green-300" : "text-red-300"}>
                              {dropEligibility.eligible ? "Eligible for card drops on this swap." : "Not eligible for card drops on this swap."}
                            </div>
                            {!dropEligibility.eligible ? (
                              <div className="text-muted-foreground">
                                Minimums (server env): ≥ <span className="font-mono">{dropEligibility.minSol}</span> SOL or ≥{" "}
                                <span className="font-mono">{dropEligibility.minUsdc}</span> USDC (input or output).
                              </div>
                            ) : (
                              <div className="text-muted-foreground">
                                Minimums met via{" "}
                                <span className="font-mono">
                                  {dropEligibility.inputSol
                                    ? "SOL input"
                                    : dropEligibility.outputSol
                                      ? "SOL output"
                                      : dropEligibility.inputUsdc
                                        ? "USDC input"
                                        : "USDC output"}
                                </span>
                                .
                              </div>
                            )}

                            {holderBoostPreviewQuery.data ? (
                              <div className="text-muted-foreground">
                                Holder boost:{" "}
                                <span className="font-mono text-foreground">x{holderBoostPreviewQuery.data.multiplier.toFixed(2)}</span>{" "}
                                <span className="text-muted-foreground">
                                  ({holderBoostPreviewQuery.data.multiplier > 1
                                    ? `+${Math.round((holderBoostPreviewQuery.data.multiplier - 1) * 100)}%`
                                    : "+0%"}
                                  , tier {holderBoostPreviewQuery.data.tier.toUpperCase()})
                                </span>
                                <div className="text-[10px] text-muted-foreground mt-1">
                                  Boost multiplies card-drop odds when eligible.
                                </div>
                              </div>
                            ) : wallet.connected ? (
                              <div className="text-muted-foreground">Holder boost: loading…</div>
                            ) : (
                              <div className="text-muted-foreground">Connect wallet to see your holder boost.</div>
                            )}
                          </div>
                        </TooltipContent>
                      </UiTooltip>
                    </TooltipProvider>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                   <div className="flex gap-1">
                      <button onClick={handleHalf} className="text-[10px] bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded transition-colors text-primary/80 hover:text-primary">HALF</button>
                      <button onClick={handleMax} className="text-[10px] bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded transition-colors text-primary/80 hover:text-primary">MAX</button>
                   </div>
                   <span>{inputBalanceQuery.data ? `Bal: ${inputBalanceQuery.data}` : "--"}</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                 <Input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="bg-white/5 border border-white/10 text-xl sm:text-2xl font-bold px-3 sm:px-4 py-3 h-14 rounded-xl focus-visible:ring-2 focus-visible:ring-primary/30 placeholder:text-muted-foreground/70 text-foreground w-full min-w-0 flex-1 transition-colors"
                 />
                 <div className="shrink-0">
                     <RaceswapTokenSelector
                        value={inputToken}
                        tokens={tokenOptions}
                        onSelect={(token) => {
                          setInputToken(token);
                          // Add to temp tokens if not already in the list
                          // This ensures pasted tokens are available for quotes
                          if (!tokenOptions.find(t => t.address === token.address)) {
                            setTempTokens(prev => {
                              if (prev.find(t => t.address === token.address)) return prev;
                              return [...prev, token];
                            });
                          }
                        }}
                        disabled={!tokenOptions.length}
                      />
                 </div>
              </div>
            </div>

            {/* SWAP ARROW */}
            <div className="relative h-3 flex items-center justify-center z-10">
               <button 
                  onClick={handleFlipTokens}
                  className="absolute bg-[#13141b] p-1.5 rounded-full border border-white/10 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 hover:border-primary/50 hover:text-primary transition-all cursor-pointer"
               >
                  <ArrowDownUp className="w-4 h-4" />
               </button>
            </div>

            {/* RECEIVE SECTION */}
            <div className="bg-[#1c1e26] rounded-xl p-3 sm:p-4 space-y-2 border border-white/5 hover:border-white/10 transition-colors">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>You receive</span>
                <span>{outputBalanceQuery.data ? `Bal: ${outputBalanceQuery.data}` : "--"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                 <div className="flex flex-col flex-1 min-w-0">
                    <div className="text-xl sm:text-2xl font-bold text-foreground truncate">
                      {isPlanLoading ? (
                        <Skeleton className="h-8 w-24" />
                      ) : planError ? (
                        <div className="flex items-center gap-2">
                          <span className="text-red-400 text-sm">Quote error</span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRefreshQuote}
                            className="h-6 px-2 text-xs border-primary/50 text-primary hover:bg-primary/10"
                            data-testid="button-refresh-quote"
                          >
                            <RefreshCw className="w-3 h-3 mr-1" />
                            Retry
                          </Button>
                        </div>
                      ) : (
                        planMainOut
                      )}
                    </div>
                    {/* USD Price Display */}
                    {planMainOut && !isPlanLoading && !planError && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {(() => {
                          // For USDC, 1 USDC = $1, so just display the amount directly
                          if (outputToken?.address === USDC_MINT) {
                            const usdcAmount = parseFloat(planMainOut);
                            if (!isNaN(usdcAmount)) {
                              return `$${usdcAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                            }
                          }
                          // For other tokens, use the price from API
                          if (outputTokenPriceQuery.data && outputTokenPriceQuery.data > 0) {
                            const usdValue = parseFloat(planMainOut) * outputTokenPriceQuery.data;
                            if (!isNaN(usdValue)) {
                              return `$${usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                            }
                          }
                          return null;
                        })()}
                      </div>
                    )}
                 </div>
                 <div className="shrink-0">
                     <RaceswapTokenSelector
                        value={outputToken}
                        tokens={tokenOptions}
                        onSelect={(token) => {
                          setOutputToken(token);
                          // Add to temp tokens if not already in the list
                          // This ensures pasted tokens are available for quotes
                          if (!tokenOptions.find(t => t.address === token.address)) {
                            setTempTokens(prev => {
                              if (prev.find(t => t.address === token.address)) return prev;
                              return [...prev, token];
                            });
                          }
                        }}
                        disabled={!tokenOptions.length}
                      />
                 </div>
              </div>
            </div>

            {/* INFO TILES (COMPACT) */}
            {planData && (
               <div className="space-y-2 pt-1">
                  <div className="flex justify-between text-xs">
                     <span className="text-muted-foreground">Rate</span>
                     <span>1 {inputToken?.symbol} ≈ {(() => {
                        // Calculate rate: output amount (in human-readable) / input amount (in human-readable)
                        // planData.mainSwapAmount is in base units, amount is human-readable string
                        const calcAmount = debouncedAmount || amount;
                        if (!outputToken || !calcAmount || parseFloat(calcAmount) <= 0) return "--";
                        const outputHumanReadable = new Decimal(planData.mainSwapAmount).div(new Decimal(10).pow(outputToken.decimals));
                        const inputHumanReadable = new Decimal(calcAmount);
                        const rate = outputHumanReadable.div(inputHumanReadable);
                        return formatAmount(rate.toString(), 0);
                     })()} {outputToken?.symbol}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                     <span className="text-muted-foreground">Gacha Treasury Fee</span>
                     <span>{treasuryFeeLabel}</span>
                  </div>
               </div>
            )}

            {/* ERROR / MINIMUM WARNING */}
            {isBelowMinimum && inputToken?.address === SOL_MINT && (
                <div className="bg-destructive/10 border border-destructive/20 p-3 rounded-lg flex items-center gap-2 text-xs text-destructive">
                   <AlertTriangle className="w-4 h-4" />
                   Minimum buy is {MINIMUM_BUY_SOL} SOL
                </div>
            )}

            <Button
              disabled={primaryDisabled}
              onClick={handleSwap}
              className="w-full h-12 text-base font-semibold bg-gradient-to-r from-primary to-purple-600 hover:from-primary/90 hover:to-purple-600/90 shadow-lg shadow-primary/20 mt-3 disabled:opacity-100 disabled:from-primary disabled:to-purple-600 disabled:text-white disabled:shadow-primary/20 disabled:cursor-not-allowed"
            >
              {isSwapping ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Confirming swap...
                </>
              ) : isBelowMinimum ? (
                `Min Amount ${MINIMUM_BUY_SOL} ${inputToken?.symbol || "SOL"}`
              ) : wallet.connected ? (
                (amount || debouncedAmount) && parseFloat(amount || debouncedAmount) > 0 ? "Buy" : "Enter an amount"
              ) : (
                "Connect Wallet"
              )}
            </Button>

            {/* Trust Row – light-mode only */}
            {theme === 'light' && (
              <div className="lm-trust-row mt-2">
                <div className="lm-trust-row__item"><Shield className="lm-trust-row__icon" /> Self-custody</div>
                <div className="lm-trust-row__item"><Route className="lm-trust-row__icon" /> Best route</div>
                <div className="lm-trust-row__item"><Zap className="lm-trust-row__icon" /> Live quote</div>
                <div className="lm-trust-row__item"><Eye className="lm-trust-row__icon" /> Transparent fees</div>
              </div>
            )}

            {/* Price Charts Section - Inside swap UI, side-by-side */}
            {inputToken && outputToken && (
              <div className="grid grid-cols-2 gap-2 mt-3">
                <PriceChart token={inputToken} label="Input Token" />
                <PriceChart token={outputToken} label="Output Token" />
              </div>
            )}
                      </CardContent>
                    </div>
                  </div>

                  {/* RIGHT: RaceClaw panel (desktop only) */}
                  <aside className={cn("hidden xl:flex flex-col border-l", theme === 'light' ? "border-border bg-white" : "border-white/5 bg-[#0d0f16]/20")}>
                    <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden">
                      <video
                        ref={raceclawVideoRef}
                        className={cn("w-full h-full", theme === 'light' ? "object-contain" : "object-cover")}
                        src={activeVideoUrl}
                        key={theme}
                        autoPlay
                        loop
                        muted
                        playsInline
                        preload="auto"
                        disablePictureInPicture
                        aria-hidden="true"
                      />
                      {/* Overlay action buttons – visible in light mode */}
                      {theme === 'light' && (
                        <div className="absolute bottom-3 left-3 right-3 flex flex-col gap-2 z-10">
                          <a href="#quests-section" className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/90 backdrop-blur-sm border border-border text-xs font-semibold text-foreground shadow-sm hover:bg-white transition-colors">
                            <Trophy className="w-3.5 h-3.5 text-yellow-600" />
                            View prize pool
                          </a>
                        </div>
                      )}
                    </div>
                  </aside>
                </div>
              </Card>
            </div>
          </div>
          
        </div>
      </div>


      {/* FEATURED CARDS – Pokemon.com-style showcase */}
      {theme === 'light' && (
        <div className="container mx-auto px-3 sm:px-4 max-w-xl xl:max-w-3xl pt-6">
          <FeaturedCards connection={connection} />
        </div>
      )}

      {/* QUESTS SECTION */}
      <div id="quests-section" className="container mx-auto px-3 sm:px-4 max-w-xl xl:max-w-3xl pt-4 sm:pt-6">
        <QuestsPanel />
      </div>
      
      {/* SWAP CONTEST LEADERBOARD - below quests */}
      <div className="container mx-auto px-3 sm:px-4 max-w-xl xl:max-w-3xl pb-32 pt-4 sm:pt-6">
        <SwapContestLeaderboard />
      </div>

      <Dialog
        open={accountSetupState.open}
        onOpenChange={(open) => {
          if (!open) handleDismissAccountSetup();
        }}
      >
        <DialogContent
          className="sm:max-w-md border-none bg-[#13141b] text-white shadow-2xl"
          onInteractOutside={(e) => {
            if (accountSetupState.submitting) {
              e.preventDefault();
            } else {
              handleDismissAccountSetup();
            }
          }}
        >
          <DialogTitle className="text-xl font-bold">
            Prepare accounts for {accountSetupState.pairLabel || "this swap"}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            This one-time transaction creates the swap, treasury, and destination accounts needed for{" "}
            {accountSetupState.pairLabel || "this pair"}. No tokens move yet.
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto rounded-xl bg-white/5 p-3 border border-white/10">
            {accountSetupState.accounts.map((account) => (
              <div
                key={account.ata.toBase58()}
                className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium">{account.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {account.category === "user" ? "Your wallet" : account.ownerLabel}
                  </p>
                </div>
                <Badge variant={account.category === "user" ? "secondary" : "outline"}>
                  {account.mintSymbol}
                </Badge>
              </div>
            ))}
            {accountSetupState.accounts.length === 0 && accountSetupState.wsolTopUpLamports === 0n && (
              <div className="text-xs text-muted-foreground text-center py-4">
                All token accounts are ready—no new accounts required.
              </div>
            )}
            {accountSetupState.wsolTopUpLamports > 0n && (
              <div className="flex items-center justify-between rounded-lg bg-primary/10 border border-primary/30 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-primary">SOL wrapper funding</p>
                  <p className="text-xs text-muted-foreground">Pre-wrap SOL so the swap stays ATA-free.</p>
                </div>
                <Badge variant="outline">{wsolTopUpSol} SOL</Badge>
              </div>
            )}
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Accounts</span>
              <span>{accountSetupState.accounts.length}</span>
            </div>
            {accountSetupState.accounts.length > 0 && (
              <div className="flex justify-between">
                <span>Rent locked</span>
                <span>
                  {rentLockedSol} SOL
                  {accountSetupState.accounts.length > 1 && (
                    <span className="text-xs text-muted-foreground"> ({perAccountCostSol} each)</span>
                  )}
                </span>
              </div>
            )}
            {wsolTopUpSol && (
              <div className="flex justify-between">
                <span>WSOL funding</span>
                <span>{wsolTopUpSol} SOL</span>
              </div>
            )}
            <div className="flex justify-between font-semibold">
              <span>Total cost</span>
              <span>{totalSetupCostSol} SOL</span>
            </div>
          </div>
          {accountSetupState.error && (
            <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
              {accountSetupState.error}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="flex-1"
              onClick={handleDismissAccountSetup}
              disabled={accountSetupState.submitting}
            >
              Not now
            </Button>
            <Button
              className="flex-1"
              onClick={handleConfirmAccountSetup}
              disabled={accountSetupState.submitting}
            >
              {accountSetupState.submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {accountSetupState.finalizing ? "Finalizing..." : "Creating..."}
                </>
              ) : (
                accountSetupState.accounts.length > 0
                  ? `Create ${accountSetupState.accounts.length} account${
                      accountSetupState.accounts.length === 1 ? "" : "s"
                    }`
                  : accountSetupState.wsolTopUpLamports > 0n
                    ? "Fund SOL wrapper"
                    : "Create accounts"
              )}
            </Button>
          </div>
          {accountSetupState.submitting && accountSetupState.statusMessage && (
            <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {accountSetupState.statusMessage}
            </p>
          )}
          <p className="text-xs text-muted-foreground text-center">
            We’ll refresh your quote automatically after setup completes.
          </p>
        </DialogContent>
      </Dialog>

      {/* SUCCESS MODAL WITH CRATE */}
      <Dialog open={showSuccessModal} onOpenChange={setShowSuccessModal}>
         <DialogContent className="sm:max-w-md border-none bg-[#13141b] text-white shadow-2xl max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto my-4" onInteractOutside={(e) => e.preventDefault()}>
            <div className="flex flex-col items-center justify-center p-4 space-y-6 max-h-full">
               <DialogTitle className="text-xl font-bold text-center">
                  {isExecuting ? "Confirming Transaction..." : "Swap Successful!"}
               </DialogTitle>
               
               <div className="w-full space-y-3">
                  <div className="text-[10px] text-muted-foreground text-center uppercase tracking-wider">
                    Crate reveal
                  </div>
                  {/* FLOATING CRATE ANIMATION */}
                  <RaceswapCrate
                    tokens={crateTokens}
                    landingMint={outputToken?.address}
                    spinning={crateSpinning}
                    success={swapSuccess}
                    onLand={() => setShowReceipt(true)}
                    triggerKey={crateKey}
                    boostedReward={receiptData?.boostedReward}
                    cards={cardReelItems}
                    cardReward={
                      receiptData?.cardReward
                        ? { won: Boolean(receiptData.cardReward.won), mint: receiptData.cardReward.mint ?? null }
                        : null
                    }
                  />
               </div>

               {showReceipt && receiptData && (
                  <div className="w-full space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                     <div className="bg-white/5 rounded-xl p-4 space-y-3 border border-white/10">
                        <h3 className="text-sm font-medium text-muted-foreground text-center uppercase tracking-wider">Receipt</h3>
                        
                        <div className="flex justify-between items-center">
                           <div className="flex items-center gap-2 flex-shrink-0">
                              {receiptData.spentLogo && <img src={receiptData.spentLogo} className="w-6 h-6 rounded-full" />}
                              <span className="text-sm">Spent</span>
                           </div>
                           <span className="font-bold text-red-400 text-right">-{receiptData.spentAmount} {receiptData.spentSymbol}</span>
                        </div>

                        <div className="flex justify-between items-center">
                           <div className="flex items-center gap-2 flex-shrink-0">
                              {receiptData.receivedLogo && <img src={receiptData.receivedLogo} className="w-6 h-6 rounded-full" />}
                              <span className="text-sm">Received</span>
                           </div>
                           <span className="font-bold text-green-400 text-right">+{receiptData.receivedAmount} {receiptData.receivedSymbol}</span>
                        </div>

                        {/* Card Won Display - compact mobile-friendly version */}
                        {receiptData.cardReward?.won && receiptData.cardReward?.mint && (
                          <>
                            <div className="h-px bg-white/10" />
                            <div className="p-2 bg-violet-500/10 rounded-lg border border-violet-400/30 overflow-hidden">
                              <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-violet-200 font-bold text-xs">🎉 CARD WON!</span>
                                  <Badge variant="outline" className="text-[10px] border-violet-400/50 text-violet-300 px-1 py-0">NFT</Badge>
                                </div>
                                {receiptData.winningCard?.grade && <span className="text-[10px] text-violet-300 flex-shrink-0">PSA {receiptData.winningCard.grade}</span>}
                              </div>
                              <p className="text-[11px] text-white/90 font-medium overflow-hidden text-ellipsis whitespace-nowrap">{(receiptData.winningCard?.name || "Pokemon Card").slice(0, 35)}{(receiptData.winningCard?.name?.length || 0) > 35 ? "..." : ""}</p>
                            </div>
                          </>
                        )}

                        {/* Swap Reward (single outcome: card OR $RACE, never both) */}
                        {(receiptData.boostedReward !== undefined || receiptData.cardReward !== undefined) && (
                          <>
                            <div className="h-px bg-white/10" />
                            <div className="flex items-start gap-3">
                              <div className="relative">
                                {/* Treasure chest icon for Swap Rewards */}
                                <div className="w-6 h-6 rounded-full ring-2 ring-primary/50 bg-[#0a0b10] flex items-center justify-center">
                                  <svg
                                    viewBox="0 0 24 24"
                                    width="16"
                                    height="16"
                                    aria-hidden="true"
                                    className="text-primary"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M4 9h16" />
                                    <path d="M5 9V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2" />
                                    <path d="M6 9v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9" />
                                    <path d="M12 9v12" />
                                    <path d="M10 13h4" />
                                  </svg>
                                </div>
                                {receiptData.cardReward?.won ? (
                                  <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-violet-400 text-black text-[9px] font-black flex items-center justify-center">
                                    ◆
                                  </span>
                                ) : null}
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex flex-col min-w-0">
                                    <span className="text-sm text-primary font-semibold">Swap Reward</span>
                                    {receiptData.holderBoost ? (
                                      <span className="text-[10px] text-muted-foreground/70">
                                        Holder boost:{" "}
                                        <span className="font-mono">x{receiptData.holderBoost.multiplier.toFixed(2)}</span>
                                        {receiptData.holderBoost.tier !== "none" ? (
                                          <>
                                            {" "}
                                            • Tier{" "}
                                            <span className="font-mono">{receiptData.holderBoost.tier.toUpperCase()}</span>
                                          </>
                                        ) : null}
                                      </span>
                                    ) : null}
                                  </div>

                                  <div className="flex flex-col items-end gap-1 text-right shrink-0">
                                    {receiptData.cardReward?.won && receiptData.cardReward?.mint ? (
                                      <a
                                        href={`https://solscan.io/token/${receiptData.cardReward.mint}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="font-bold text-violet-200 hover:underline font-mono text-xs"
                                      >
                                        {receiptData.cardReward.mint.slice(0, 4)}…{receiptData.cardReward.mint.slice(-4)}
                                      </a>
                                    ) : receiptData.cardReward?.error ? (
                                      <span className="text-xs text-amber-200">Delivery failed</span>
                                    ) : receiptData.boostedReward?.won && receiptData.boostedReward?.rewardAmount ? (
                                      <span className="font-bold text-primary animate-pulse">
                                        +{(parseFloat(receiptData.boostedReward.rewardAmount) / 1e6).toFixed(0)} RACE
                                      </span>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">No win</span>
                                    )}

                                    {(receiptData.boostedReward?.transactionSignature || receiptData.mainSignature) &&
                                    (receiptData.boostedReward?.recipient || receiptData.cardReward?.recipient) &&
                                    (receiptData.boostedReward?.seed || receiptData.cardReward?.seed) ? (
                                      <button
                                        type="button"
                                        className="text-[10px] text-primary/80 hover:text-primary transition-colors underline"
                                        title="See exact verification steps"
                                        onClick={() => {
                                          const tx =
                                            receiptData.boostedReward?.transactionSignature || receiptData.mainSignature || "";
                                          const recipient =
                                            receiptData.boostedReward?.recipient || receiptData.cardReward?.recipient || "";
                                          const seed = receiptData.boostedReward?.seed || receiptData.cardReward?.seed || "";
                                          const slot = receiptData.boostedReward?.slot ?? receiptData.cardReward?.slot ?? null;
                                          const blockhash =
                                            (receiptData.boostedReward?.blockhash ?? receiptData.cardReward?.blockhash) ?? null;

                                          if (!tx || !recipient || !seed) return;

                                          setVerifyDialogData({
                                            recipient,
                                            transactionSignature: tx,
                                            slot,
                                            blockhash,
                                            seed,
                                            race: {
                                              roll: receiptData.boostedReward?.randomValue ?? 0,
                                              winProbability: receiptData.boostedReward?.winProbability ?? 0,
                                              won: Boolean(receiptData.boostedReward?.won),
                                              rewardAmountBase: receiptData.boostedReward?.rewardAmount ?? null,
                                              rewardSignature: receiptData.boostedReward?.rewardSignature ?? null,
                                              error: receiptData.boostedReward?.error ?? null,
                                            },
                                            card: {
                                              enabled: Boolean(receiptData.cardReward?.enabled),
                                              disabledReason: receiptData.cardReward?.disabledReason ?? null,
                                              roll: receiptData.cardReward?.randomValue ?? 0,
                                              winProbability: receiptData.cardReward?.winProbability ?? 0,
                                              won: Boolean(receiptData.cardReward?.won),
                                              mint: receiptData.cardReward?.mint ?? null,
                                              rewardSignature: receiptData.cardReward?.rewardSignature ?? null,
                                              error: receiptData.cardReward?.error ?? null,
                                              poolHash: receiptData.cardReward?.poolHash ?? null,
                                              poolSize: receiptData.cardReward?.poolSize ?? null,
                                              pickRoll: receiptData.cardReward?.pickRoll ?? null,
                                              pickIndex: receiptData.cardReward?.pickIndex ?? null,
                                            },
                                          });
                                          setVerifyDialogOpen(true);
                                        }}
                                      >
                                        verify
                                      </button>
                                    ) : null}
                                  </div>
                                </div>

                                {/* Cleaner, human-readable reward roll breakdown */}
                                <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] p-2">
                                  <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
                                    {/* Card */}
                                    <span className="text-[11px] text-muted-foreground/90">Card drop</span>
                                    <span
                                      className={[
                                        "text-[11px] font-semibold",
                                        receiptData.cardReward?.enabled === false
                                          ? "text-muted-foreground/70"
                                          : receiptData.cardReward?.error
                                            ? "text-amber-200"
                                            : receiptData.cardReward?.won
                                              ? "text-violet-200"
                                              : "text-muted-foreground/70",
                                      ].join(" ")}
                                    >
                                      {receiptData.cardReward?.enabled === false
                                        ? "Disabled"
                                        : receiptData.cardReward?.error
                                          ? "Delivery failed"
                                          : receiptData.cardReward?.won
                                            ? "WIN"
                                            : "No win"}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/70 col-span-2">
                                      {receiptData.cardReward?.enabled === false ? (
                                        <>
                                          Reason:{" "}
                                          <span className="text-muted-foreground/80">
                                            {receiptData.cardReward?.disabledReason || "Not eligible"}
                                          </span>
                                        </>
                                      ) : (
                                        <>
                                          Win threshold:{" "}
                                          <span className="font-mono text-foreground/90">
                                            {formatPercentSmart01(receiptData.cardReward?.winProbability)}
                                          </span>
                                          {formatOneInChance01(receiptData.cardReward?.winProbability) ? (
                                            <span className="text-muted-foreground/60">
                                              {" "}
                                              ({formatOneInChance01(receiptData.cardReward?.winProbability)})
                                            </span>
                                          ) : null}
                                          {" • "}
                                          Your roll:{" "}
                                          <span className="font-mono text-foreground/90">
                                            {formatRollPercent01(receiptData.cardReward?.randomValue)}
                                          </span>
                                        </>
                                      )}
                                    </span>

                                    <div className="h-px bg-white/10 col-span-2 my-1" />

                                    {/* RACE */}
                                    <span className="text-[11px] text-muted-foreground/90">$RACE reward</span>
                                    <span
                                      className={[
                                        "text-[11px] font-semibold",
                                        receiptData.cardReward?.won
                                          ? "text-muted-foreground/70"
                                          : receiptData.boostedReward?.error
                                            ? "text-amber-200"
                                            : receiptData.boostedReward?.won
                                              ? "text-primary"
                                              : "text-muted-foreground/70",
                                      ].join(" ")}
                                    >
                                      {receiptData.cardReward?.won
                                        ? "Skipped"
                                        : receiptData.boostedReward?.error
                                          ? "Error"
                                          : receiptData.boostedReward?.won
                                            ? "WIN"
                                            : "No win"}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/70 col-span-2">
                                      {receiptData.cardReward?.won ? (
                                        <>Skipped because the card reward was won.</>
                                      ) : (
                                        <>
                                          Win threshold:{" "}
                                          <span className="font-mono text-foreground/90">
                                            {formatPercentSmart01(receiptData.boostedReward?.winProbability)}
                                          </span>
                                          {formatOneInChance01(receiptData.boostedReward?.winProbability) ? (
                                            <span className="text-muted-foreground/60">
                                              {" "}
                                              ({formatOneInChance01(receiptData.boostedReward?.winProbability)})
                                            </span>
                                          ) : null}
                                          {" • "}
                                          Your roll:{" "}
                                          <span className="font-mono text-foreground/90">
                                            {formatRollPercent01(receiptData.boostedReward?.randomValue)}
                                          </span>
                                        </>
                                      )}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Reward tx link (card takes priority) */}
                            {receiptData.cardReward?.rewardSignature ? (
                              <a
                                href={`https://solscan.io/tx/${receiptData.cardReward.rewardSignature}`}
                                target="_blank"
                                rel="noreferrer"
                                className="block text-xs text-primary hover:underline text-center mt-1"
                              >
                                View Reward Tx
                              </a>
                            ) : receiptData.boostedReward?.rewardSignature ? (
                              <a
                                href={`https://solscan.io/tx/${receiptData.boostedReward.rewardSignature}`}
                                target="_blank"
                                rel="noreferrer"
                                className="block text-xs text-primary hover:underline text-center mt-1"
                              >
                                View Reward Tx
                              </a>
                            ) : null}
                          </>
                        )}
                     </div>
                     
                    <div className="space-y-2 text-xs text-muted-foreground text-center">
                      {receiptData.mainSignature && (
                        <a
                          href={`https://solscan.io/tx/${receiptData.mainSignature}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block hover:text-primary transition-colors"
                        >
                          View Swap
                        </a>
                      )}
                    </div>

                     <Button onClick={handleCloseModal} className="w-full">
                        Close
                     </Button>
                  </div>
               )}
            </div>
         </DialogContent>
      </Dialog>

      <ProvablyFairVerifyDialog
        open={verifyDialogOpen}
        onOpenChange={setVerifyDialogOpen}
        data={verifyDialogData}
      />
      
      {/* Leaderboard scroll indicator - fixed at bottom, hides on scroll (desktop only) */}
      {showScrollIndicator && (
        <div className="hidden md:flex fixed bottom-6 left-0 right-0 z-50 justify-center pointer-events-none transition-opacity duration-300">
          <div className="flex items-center gap-3 pointer-events-auto">
            {/* Left animated arrows */}
            <div className="flex items-center">
              <ChevronDown className="w-5 h-5 text-primary animate-bounce-arrow-1" />
              <ChevronDown className="w-5 h-5 text-primary animate-bounce-arrow-2 -ml-2" />
              <ChevronDown className="w-5 h-5 text-primary animate-bounce-arrow-3 -ml-2" />
            </div>
            
            {/* Center text with trophy */}
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-[#0a0b10]/95 backdrop-blur-sm border border-primary/30 shadow-lg shadow-primary/20">
              <Trophy className="w-4 h-4 text-primary animate-pulse-glow" />
              <span className="text-sm font-semibold text-primary tracking-wide">Swap Quests</span>
              <Trophy className="w-4 h-4 text-primary animate-pulse-glow" />
            </div>
            
            {/* Right animated arrows */}
            <div className="flex items-center">
              <ChevronDown className="w-5 h-5 text-primary animate-bounce-arrow-3 -mr-2" />
              <ChevronDown className="w-5 h-5 text-primary animate-bounce-arrow-2 -mr-2" />
              <ChevronDown className="w-5 h-5 text-primary animate-bounce-arrow-1" />
            </div>
          </div>
        </div>
      )}
      
      {/* BOTTOM BANNER – hidden in light mode */}
      {theme !== 'light' && (
        <div className="fixed bottom-0 left-0 w-full z-0 pointer-events-none flex justify-center opacity-60">
           <img 
              src="/racebanner.png" 
              alt="" 
              className="w-full h-auto object-cover object-bottom" 
              style={{ 
                  maskImage: 'linear-gradient(to top, black 70%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to top, black 70%, transparent 100%)',
                  maxHeight: '22vh'
              }}
           />
        </div>
      )}
    </div>
  );
}

function formatAmount(raw: string, decimals: number) {
  try {
    const dec = new Decimal(raw).div(new Decimal(10).pow(decimals));
    return dec.toSignificantDigits(6).toString();
  } catch {
    return "0";
  }
}

function formatRollPercent01(v01?: number | null): string {
  if (v01 === undefined || v01 === null || !isFinite(v01)) return "--";
  return `${(v01 * 100).toFixed(3)}%`;
}

function formatPercentSmart01(v01?: number | null): string {
  if (v01 === undefined || v01 === null || !isFinite(v01)) return "--";
  const pct = v01 * 100;
  const digits = pct < 1 ? 3 : 2;
  return `${pct.toFixed(digits)}%`;
}

function formatOneInChance01(v01?: number | null): string | null {
  if (v01 === undefined || v01 === null || !isFinite(v01) || v01 <= 0) return null;
  // Conservative rounding: don't overstate odds.
  const oneIn = Math.ceil(1 / v01);
  if (!isFinite(oneIn) || oneIn < 2 || oneIn > 1e9) return null;
  return `1 in ${oneIn.toLocaleString()} chance`;
}

function formatLamportsToSol(lamports: number | bigint, precision = 4) {
  try {
    const dec = new Decimal(lamports.toString()).div(LAMPORTS_PER_SOL);
    return dec.toFixed(precision);
  } catch {
    return "0";
  }
}

function mapToken(token?: RaceswapTokenInfo | null): TokenOption {
  if (!token) {
    return SOL_DEFAULT_OPTION;
  }
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    logoURI: token.logoURI,
    decimals: token.decimals ?? 9,
  };
}

function mapTokens(tokens?: RaceswapTokenInfo[] | null): TokenOption[] {
  const dedup = new Map<string, TokenOption>();
  dedup.set(SOL_DEFAULT_OPTION.address, SOL_DEFAULT_OPTION);
  
  // Ensure RACE is present for default selection
  const raceMint = RACE_TOKEN_MINT.toString();
  dedup.set(raceMint, {
    address: raceMint,
    symbol: "RACE",
    name: "Pump Racers",
    decimals: 6,
    logoURI: "/racepump.svg"
  });

  for (const token of tokens ?? []) {
    const mapped = mapToken(token);
    if (!mapped.symbol) continue;
    dedup.set(mapped.address, mapped);
  }
  return Array.from(dedup.values());
}

async function fetchTokenBalance(connection: Connection, owner: PublicKey, token: TokenOption): Promise<string> {
  if (token.address === SOL_MINT) {
    const [nativeLamports, wsolLamports] = await Promise.all([
      connection.getBalance(owner).then((lamports) => BigInt(lamports)),
      getWsolLamports(connection, owner),
    ]);
    const totalLamports = nativeLamports + wsolLamports;
    return formatAmount(totalLamports.toString(), token.decimals ?? 9);
  }
  const mintKey = new PublicKey(token.address);
  return connection
    .getParsedTokenAccountsByOwner(owner, { mint: mintKey })
    .then((accounts) => {
      const tokenAmount = accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount;
      if (!tokenAmount) return "0";
      return formatAmount(tokenAmount.amount as string, Number(tokenAmount.decimals ?? token.decimals ?? 0));
    })
    .catch(() => "0");
}

async function getWsolLamports(connection: Connection, owner: PublicKey): Promise<bigint> {
  try {
    const wsolAta = await getAssociatedTokenAddress(new PublicKey(SOL_MINT), owner);
    const balanceInfo = await connection.getTokenAccountBalance(wsolAta);
    return BigInt(balanceInfo.value.amount);
  } catch {
    return 0n;
  }
}

async function waitForFinalizedSignature(
  connection: Connection,
  signature: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
) {
  const timeoutMs = options?.timeoutMs ?? 15000;
  const pollIntervalMs = options?.pollIntervalMs ?? 600;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const confirmationStatus = status.value?.[0]?.confirmationStatus;
    if (confirmationStatus === "finalized") {
      return true;
    }
    await delay(pollIntervalMs);
  }

  return false;
}

async function waitForAccountsToExist(
  connection: Connection,
  pubkeys: PublicKey[],
  options?: { timeoutMs?: number; pollIntervalMs?: number }
) {
  if (!pubkeys.length) return true;
  const timeoutMs = options?.timeoutMs ?? 10000;
  const pollIntervalMs = options?.pollIntervalMs ?? 600;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const infos = await connection.getMultipleAccountsInfo(pubkeys);
    if (infos.every((info) => Boolean(info))) {
      return true;
    }
    await delay(pollIntervalMs);
  }

  return false;
}

async function waitForWsolBalance(
  connection: Connection,
  owner: PublicKey,
  requiredLamports: bigint,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
) {
  if (requiredLamports <= 0n) return true;
  const timeoutMs = options?.timeoutMs ?? 10000;
  const pollIntervalMs = options?.pollIntervalMs ?? 600;
  const wsolAta = await getAssociatedTokenAddress(new PublicKey(SOL_MINT), owner);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const balanceInfo = await connection.getTokenAccountBalance(wsolAta).catch(() => null);
    const lamports = balanceInfo ? BigInt(balanceInfo.value.amount) : 0n;
    if (lamports >= requiredLamports) {
      return true;
    }
    await delay(pollIntervalMs);
  }

  return false;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Smart price formatter for compact display
// - Prices >= $1: show 2 decimal places (e.g., $143.07)
// - Prices >= $0.01: show 4 decimal places (e.g., $0.0542)
// - Prices < $0.01: subscript notation for leading zeros (e.g., $0.0₃286)
function formatChartPrice(price: number): string {
  if (price >= 1) {
    return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (price >= 0.01) {
    return price.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  } else {
    // For prices < $0.01, use subscript notation: 0.0₃286 means 0.000286
    const str = price.toFixed(12);
    const match = str.match(/^0\.(0*)([1-9]\d{0,3})/);
    if (match) {
      const zeros = match[1].length;
      const significant = match[2].slice(0, 3); // max 3 sig digits
      if (zeros >= 2) {
        const subscriptDigits = '₀₁₂₃₄₅₆₇₈₉';
        const subscript = zeros.toString().split('').map(d => subscriptDigits[parseInt(d)]).join('');
        return `0.0${subscript}${significant}`;
      }
      return price.toFixed(zeros + significant.length);
    }
    return price.toExponential(2);
  }
}

// Price Chart Component - uses React Query for cross-navigation caching
// Data persists in query cache so charts appear instantly when returning to this page
const PriceChart = memo(function PriceChart({ token, label }: { token: TokenOption; label: string }) {
  // Determine time frame: 24 hours for SOL, 168h for others
  const hours = token.address === SOL_MINT ? 24 : 168;
  const isUSDC = token.address === USDC_MINT;

  // Fetch price history via React Query with aggressive caching
  // staleTime: 10 minutes - data won't re-fetch on page re-mount within this window
  // gcTime: 30 minutes - cached data persists in memory even after unmount
  const { data: chartResult, isLoading: isChartLoading } = useQuery({
    queryKey: ["price-chart", token.address, hours],
    queryFn: async (): Promise<{ chartData: Array<{ time: string; price: number }>; lastPrice: number | null }> => {
      // USDC: generate synthetic stablecoin data locally (no API call needed)
      if (isUSDC) {
        const stableData = generateStablecoinData(1.0, hours);
        return { chartData: stableData, lastPrice: 1.0 };
      }

      try {
        const params = new URLSearchParams({
          mint: token.address,
          hours: hours.toString(),
        });
        const response = await fetch(`/api/token-price-history?${params.toString()}`);
        if (response.ok) {
          const data = await response.json();
          if (data.prices && Array.isArray(data.prices) && data.prices.length > 0) {
            const formatted = data.prices.map((p: any) => ({
              time: new Date(p.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
              price: p.price,
            }));
            return {
              chartData: formatted,
              lastPrice: formatted[formatted.length - 1].price,
            };
          }
        }
      } catch (error) {
        console.warn("Price history fetch failed:", error);
      }

      // Fallback: return empty so we can use tokenStats price for mock data
      return { chartData: [], lastPrice: null };
    },
    staleTime: 10 * 60 * 1000,   // 10 minutes - charts don't need frequent refresh
    gcTime: 30 * 60 * 1000,      // 30 minutes - keep in memory across navigations
    refetchOnWindowFocus: false,  // Don't refetch just because user tabbed back
    refetchOnMount: false,        // Don't refetch on component mount if data exists
    retry: 1,                     // One retry on failure
  });

  // Separate query for current price (lighter, can refresh more often)
  const { data: tokenStats } = useQuery({
    queryKey: ["token-stats", token.address],
    queryFn: async () => {
      try {
        return await api.getTokenStats(token.address);
      } catch {
        return null;
      }
    },
    staleTime: 60000,        // 1 minute
    gcTime: 5 * 60 * 1000,   // 5 minutes
    refetchInterval: 120000,  // Refetch every 2 minutes (was 1 min)
    refetchOnWindowFocus: false,
  });

  // Use chart data from query, or generate fallback mock data from tokenStats
  const chartData = useMemo(() => {
    if (chartResult?.chartData && chartResult.chartData.length > 0) {
      return chartResult.chartData;
    }
    // Fallback: generate mock data if we have a price but no chart data
    const fallbackPrice = tokenStats?.currentPriceUsd;
    if (fallbackPrice && fallbackPrice > 0) {
      return generateMockPriceData(fallbackPrice, hours);
    }
    return [];
  }, [chartResult?.chartData, tokenStats?.currentPriceUsd, hours]);

  // Current price: prefer tokenStats (more recent), fall back to chart data
  const currentPrice = useMemo(() => {
    if (!isUSDC && tokenStats?.currentPriceUsd != null) return tokenStats.currentPriceUsd;
    if (chartResult?.lastPrice != null) return chartResult.lastPrice;
    return null;
  }, [isUSDC, tokenStats?.currentPriceUsd, chartResult?.lastPrice]);

  // Calculate price change percentage and direction
  const priceChange = useMemo(() => {
    if (chartData.length < 2 || !currentPrice) return null;
    const firstPrice = chartData[0].price;
    if (firstPrice === 0 || currentPrice === 0 || Math.abs(firstPrice) < 0.000001) return null;
    const change = ((currentPrice - firstPrice) / firstPrice) * 100;
    if (!isFinite(change)) return null;
    return {
      value: change,
      direction: change >= 0 ? 'up' as const : 'down' as const,
    };
  }, [chartData, currentPrice]);

  // Chart color based on price direction
  const priceDirection = useMemo(() => {
    if (chartData.length < 2) return null;
    const firstPrice = chartData[0].price;
    const lastPrice = chartData[chartData.length - 1].price;
    return lastPrice >= firstPrice ? 'up' : 'down';
  }, [chartData]);

  const chartColor = priceDirection === 'up' ? '#22c55e' : '#ef4444';
  const gradientId = `gradient-${token.address}`;

  // Only show skeleton on first ever load (no cached data at all)
  const hasData = chartData.length > 0;
  const showSkeleton = isChartLoading && !hasData;

  if (showSkeleton) {
    return (
      <Card className="bg-[#13141b] border-white/10">
        <CardContent className="p-1.5">
          <div className="flex items-center justify-between mb-0.5">
            <div className="flex items-center gap-1.5">
              {token.logoURI && <img src={token.logoURI} alt={token.symbol} className="w-3.5 h-3.5 rounded-full" />}
              <span className="text-[10px] font-medium text-muted-foreground">{token.symbol}</span>
            </div>
          <div className="flex items-center gap-1.5">
            {currentPrice !== null && currentPrice !== undefined && (
              <span className="text-[10px] font-bold text-foreground">
                ${formatChartPrice(currentPrice)}
              </span>
            )}
          </div>
          </div>
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  // No data at all - show minimal card
  if (!hasData) {
    return (
      <Card className="bg-[#13141b] border-white/10">
        <CardContent className="p-1.5">
          <div className="flex items-center justify-between mb-0.5">
            <div className="flex items-center gap-1.5">
              {token.logoURI && <img src={token.logoURI} alt={token.symbol} className="w-3.5 h-3.5 rounded-full" />}
              <span className="text-[10px] font-medium text-muted-foreground">{token.symbol}</span>
            </div>
          <div className="flex items-center gap-1.5">
            {currentPrice !== null && currentPrice !== undefined && (
              <span className="text-[10px] font-bold text-foreground">
                ${formatChartPrice(currentPrice)}
              </span>
            )}
          </div>
          </div>
          <div className="h-12 w-full flex items-center justify-center">
            <span className="text-[10px] text-muted-foreground/50">No chart data</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-[#13141b] border-white/10">
      <CardContent className="p-1.5">
        <div className="flex items-center justify-between mb-0.5">
          <div className="flex items-center gap-1.5">
            {token.logoURI && <img src={token.logoURI} alt={token.symbol} className="w-3.5 h-3.5 rounded-full" />}
            <span className="text-[10px] font-medium text-muted-foreground">{token.symbol}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {currentPrice !== null && currentPrice !== undefined && (
              <span className="text-[10px] font-bold text-foreground">
                ${formatChartPrice(currentPrice)}
              </span>
            )}
            {priceChange !== null && (
              <span className={`text-[10px] font-semibold ${priceChange.direction === 'up' ? 'text-green-500' : 'text-red-500'}`}>
                {priceChange.direction === 'up' ? '+' : ''}{priceChange.value.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <div className="h-16 sm:h-20 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chartColor} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis 
                dataKey="time" 
                tick={false} 
                axisLine={false}
                tickLine={false}
                height={0}
              />
              <YAxis 
                domain={['auto', 'auto']}
                tick={false}
                axisLine={false}
                tickLine={false}
                width={0}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    return (
                      <div className="bg-[#1c1e26] border border-white/10 rounded-lg px-2 py-1 text-xs">
                        <p className="text-foreground font-medium">
                          ${formatChartPrice(Number(payload[0].value))}
                        </p>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Area
                type="monotone"
                dataKey="price"
                stroke={chartColor}
                strokeWidth={1.5}
                fill={`url(#${gradientId})`}
                dot={false}
                activeDot={{ r: 2, fill: chartColor }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
});

// Generate mock price data for fallback
function generateMockPriceData(basePrice: number, hours: number = 24): Array<{ time: string; price: number }> {
  const data: Array<{ time: string; price: number }> = [];
  const now = Date.now();
  const volatility = basePrice * 0.05; // 5% volatility
  
  // Generate data with hourly intervals
  const intervals = hours;
  for (let i = intervals - 1; i >= 0; i--) {
    const timestamp = now - (i * 3600000); // 1 hour intervals
    const randomChange = (Math.random() - 0.5) * volatility;
    const price = basePrice + randomChange;
    data.push({
      time: new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      price: Math.max(0, price),
    });
  }
  
  return data;
}

// Generate stablecoin data (for USDC) - shows minimal variation around $1
function generateStablecoinData(basePrice: number = 1.0, hours: number = 24): Array<{ time: string; price: number }> {
  const data: Array<{ time: string; price: number }> = [];
  const now = Date.now();
  // Very small volatility for stablecoins (0.1% max variation)
  const volatility = basePrice * 0.001;
  
  // Generate data with hourly intervals
  const intervals = hours;
  for (let i = intervals - 1; i >= 0; i--) {
    const timestamp = now - (i * 3600000); // 1 hour intervals
    // Small random variation around $1
    const randomChange = (Math.random() - 0.5) * volatility;
    const price = basePrice + randomChange;
    data.push({
      time: new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      price: Math.max(0.99, Math.min(1.01, price)), // Keep between $0.99 and $1.01
    });
  }
  
  return data;
}

// Mobile Card Drops Tooltip Component
function MobileCardDropsTooltip({ 
  walletAddress,
  holderBoost,
}: { 
  walletAddress?: string;
  holderBoost?: { multiplier: number; tier: string } | null;
}) {
  const { connection } = useConnection();
  
  // Fetch card data for total value
  const { data: allowlistData } = useQuery({
    queryKey: ["pokemon-card-allowlist-tooltip"],
    queryFn: () => api.getPokemonCardAllowlist(),
    staleTime: 1000 * 60 * 5,
  });

  const { data: cardsData } = useQuery({
    queryKey: ["pokemon-cards-tooltip", connection.rpcEndpoint, allowlistData?.droppableMints?.join(",") || ""],
    queryFn: () => {
      const mints = allowlistData?.droppableMints || allowlistData?.mints || [];
      return getPokemonCardsResult(connection, { allowlist: mints });
    },
    enabled: Boolean(allowlistData),
    staleTime: 1000 * 60 * 60 * 12,
  });

  const { data: raceswapConfig } = useQuery({
    queryKey: ["raceswap-config"],
    queryFn: api.getRaceswapConfig,
    staleTime: 60_000,
  });

  const totalValueUsd = useMemo(() => {
    const items = cardsData?.items ?? [];
    return items.reduce((sum, nft) => {
      const v = nft.insuredValueUsd;
      return typeof v === "number" && Number.isFinite(v) ? sum + v : sum;
    }, 0);
  }, [cardsData]);

  const cardCount = cardsData?.items?.length ?? 0;

  const minSol = useMemo(() => {
    const raw = Number.parseFloat(String((raceswapConfig as any)?.dropMinSol ?? "0.1"));
    return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
  }, [raceswapConfig]);

  const boostMultiplier = holderBoost?.multiplier ?? 1;
  const safeBoost = Number.isFinite(boostMultiplier) && boostMultiplier > 0 ? boostMultiplier : 1;

  // Calculate odds for 1 SOL and 10 SOL swaps
  const calcProb = (sol: number) => {
    const ONE_IN_PER_SOL = 80; // Optimized for 2.5% Gacha Treasury Fee (5x from old 1 in 400)
    const PROBABILITY_CAP = 0.25;
    const baseProbability = sol / ONE_IN_PER_SOL;
    return Math.min(baseProbability * safeBoost, PROBABILITY_CAP);
  };

  const oneSOLProb = calcProb(1);
  const tenSOLProb = calcProb(10);
  
  const formatOdds = (prob: number) => {
    const oneIn = Math.ceil(1 / prob);
    return `1 in ${oneIn.toLocaleString()}`;
  };
  
  const formatPercent = (prob: number) => {
    const pct = prob * 100;
    return pct < 1 ? `${pct.toFixed(2)}%` : `${pct.toFixed(1)}%`;
  };

  const formatUsdValue = (v: number) => {
    if (v >= 1000) {
      return `$${(v / 1000).toFixed(1)}k`;
    }
    return `$${v.toFixed(0)}`;
  };

  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 group md:hidden">
      <span className="swap-rewards-text swap-rewards-cursive swap-rewards-pulse text-2xl md:text-3xl text-primary cursor-help">
        Card Drops
      </span>
      <div className="absolute left-1/2 top-full mt-2 -translate-x-1/2 w-[340px] p-4 bg-[#1c1e26] border border-primary/30 rounded-xl shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-[99999] pointer-events-none">
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/20 to-purple-500/20 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground">On-Chain Graded Cards</p>
            <p className="text-[10px] text-muted-foreground">Provably fair drops from racebank.sol</p>
          </div>
        </div>

        {/* How it works */}
        <div className="bg-white/5 rounded-lg p-2.5 mb-3 border border-white/5">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Swap <span className="text-primary font-semibold">{minSol}+ SOL</span> to qualify for on-chain graded Pokémon card drops. 
            Winners are selected using a provably fair roll derived from your transaction blockhash.
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="bg-white/5 rounded-lg p-2 border border-white/5">
            <div className="text-[9px] text-white/50 uppercase tracking-wider mb-0.5">Treasury Value</div>
            <div className="text-sm font-bold text-green-400">{formatUsdValue(totalValueUsd)}</div>
            <div className="text-[9px] text-white/40">{cardCount} cards</div>
          </div>
          <div className="bg-white/5 rounded-lg p-2 border border-white/5">
            <div className="text-[9px] text-white/50 uppercase tracking-wider mb-0.5">Your Boost</div>
            <div className="text-sm font-bold text-primary">x{safeBoost.toFixed(2)}</div>
            <div className="text-[9px] text-white/40">
              {walletAddress ? `Tier ${holderBoost?.tier?.toUpperCase() || 'NONE'}` : 'Connect wallet'}
            </div>
          </div>
        </div>

        {/* Win Probability */}
        <div className="bg-gradient-to-r from-primary/10 to-purple-500/10 rounded-lg p-2.5 border border-primary/20">
          <p className="text-[10px] text-primary font-semibold mb-2 flex items-center gap-1">
            <Rocket className="w-3 h-3" />
            {safeBoost > 1 ? 'Your Boosted Odds' : 'Win Probability'}
            {safeBoost > 1 && (
              <span className="text-[8px] text-primary/70 font-normal ml-1">(x{safeBoost.toFixed(2)} boost applied)</span>
            )}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[9px] text-white/50 mb-0.5">1 SOL Swap</div>
              <div className={`text-xs font-bold ${safeBoost > 1 ? 'text-primary' : 'text-white'}`}>{formatOdds(oneSOLProb)}</div>
              <div className="text-[9px] text-white/40">{formatPercent(oneSOLProb)}</div>
            </div>
            <div>
              <div className="text-[9px] text-white/50 mb-0.5">10 SOL Swap</div>
              <div className={`text-xs font-bold ${safeBoost > 1 ? 'text-primary' : 'text-white'}`}>{formatOdds(tenSOLProb)}</div>
              <div className="text-[9px] text-white/40">{formatPercent(tenSOLProb)}</div>
            </div>
          </div>
          {!walletAddress && (
            <div className="text-[9px] text-white/40 mt-2 text-center italic">
              Connect wallet to see your boosted odds
            </div>
          )}
        </div>

        {/* Footer note */}
        <div className="mt-2.5 pt-2 border-t border-white/10">
          <p className="text-[9px] text-white/40 text-center">
            Hold $RACE to boost your odds • Larger swaps = better chances
          </p>
        </div>
      </div>
    </div>
  );
}
