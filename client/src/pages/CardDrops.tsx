import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { getPokemonCardsResult, type PokemonCardNft } from "@/lib/pokemon-cards";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ExternalLink } from "lucide-react";
 
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_PRICE_USD_CACHE_KEY = "raceswap:card-drops:sol-price-usd:v1";
const SOL_PRICE_USD_CACHE_MS = 1000 * 60 * 60 * 24; // 24 hours
const FALLBACK_SOL_PRICE_USD = 122.67;

function readCachedSolPriceUsd(): { priceUsd: number; fetchedAt: number } | null {
  try {
    const raw = localStorage.getItem(SOL_PRICE_USD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { priceUsd?: unknown; fetchedAt?: unknown };
    const priceUsd = typeof parsed.priceUsd === "number" ? parsed.priceUsd : NaN;
    const fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : NaN;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null;
    // Ignore extremely old values (helps if a user’s clock changed).
    if (Date.now() - fetchedAt > SOL_PRICE_USD_CACHE_MS * 7) return null;
    return { priceUsd, fetchedAt };
  } catch {
    return null;
  }
}

function writeCachedSolPriceUsd(priceUsd: number) {
  try {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
    localStorage.setItem(
      SOL_PRICE_USD_CACHE_KEY,
      JSON.stringify({ priceUsd, fetchedAt: Date.now() })
    );
  } catch {
    // Ignore storage failures (private mode, quota, etc).
  }
}
 
function formatUsd(v?: number | null): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "N/A";
  const fractionDigits = Number.isInteger(v) ? 0 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(v);
}
 
function formatPercentSmart01(v01?: number | null): string {
  if (v01 === undefined || v01 === null || !Number.isFinite(v01)) return "--";
  const pct = v01 * 100;
  const digits = pct < 1 ? 3 : 2;
  return `${pct.toFixed(digits)}%`;
}
 
function formatOneInChance01(v01?: number | null): string | null {
  if (v01 === undefined || v01 === null || !Number.isFinite(v01) || v01 <= 0) return null;
  // Conservative rounding: don't overstate odds.
  const oneIn = Math.ceil(1 / v01);
  if (!Number.isFinite(oneIn) || oneIn < 2 || oneIn > 1e9) return null;
  return `1 in ${oneIn.toLocaleString()} chance`;
}
 
function calcCardWinProbability01(
  usdValue: number,
  solPriceUsd: number,
  holderBoostMultiplier: number,
  eligibleForDrops: boolean
): number {
  // Mirrors server-side card odds (best-effort): see `server/routes.ts` /api/raceswap/swap-rewards.
  const safeBoost =
    Number.isFinite(holderBoostMultiplier) && holderBoostMultiplier > 0 ? holderBoostMultiplier : 1;
  const DEFAULT_SOL_PRICE_USD = 122.67;
  const safeSolPriceUsd =
    Number.isFinite(solPriceUsd) && solPriceUsd > 0 ? solPriceUsd : DEFAULT_SOL_PRICE_USD;

  // Default: 1 in 80 per 1 SOL swap (optimized for 2.5% Gacha Treasury Fee).
  // Old system was 1 in 400, with 5x revenue increase we give 5x better odds.
  const ONE_IN_PER_SOL = 80;
  const PROBABILITY_CAP = 0.25;

  const solEquivalent = safeSolPriceUsd > 0 ? usdValue / safeSolPriceUsd : 0;
  const baseProbability = solEquivalent > 0 ? solEquivalent / ONE_IN_PER_SOL : 0;
  return eligibleForDrops ? Math.min(baseProbability * safeBoost, PROBABILITY_CAP) : 0;
}
 
function solscanTokenUrl(mint: string) {
  return `https://solscan.io/token/${mint}`;
}
 
const RACEBANK_SOLSCAN =
  "https://solscan.io/account/6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u#portfolio_nfts";
 
export default function CardDrops() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const walletAddress = wallet.publicKey?.toBase58() ?? null;
  const cachedSolPrice = useMemo(() => readCachedSolPriceUsd(), []);
 
  const { data: raceswapConfig } = useQuery({
    queryKey: ["raceswap-config"],
    queryFn: api.getRaceswapConfig,
    staleTime: 60_000,
  });
 
  const holderBoostQuery = useQuery({
    queryKey: ["raceswap-holder-boost-card-drops", walletAddress || ""],
    queryFn: () => api.getRaceswapHolderBoost(String(walletAddress)),
    enabled: Boolean(walletAddress),
    // Boost tiers rarely change; avoid refetching on quick nav away/back.
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
  });
 
  const solPriceQuery = useQuery({
    queryKey: ["token-price-usd-jupiter-v3", SOL_MINT],
    queryFn: async () => {
      const prices = await api.getTokenPricesBatch([SOL_MINT]);
      const priceUsd = prices.find((p) => p.mint === SOL_MINT)?.priceUsd ?? 0;
      // Treat 0/invalid as failure so React Query retries, but fall back to any
      // cached value so the UI stays responsive.
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        const cached = readCachedSolPriceUsd();
        if (cached?.priceUsd) return cached.priceUsd;
        throw new Error("SOL price unavailable");
      }
      writeCachedSolPriceUsd(priceUsd);
      return priceUsd;
    },
    initialData: () => cachedSolPrice?.priceUsd,
    initialDataUpdatedAt: () => cachedSolPrice?.fetchedAt,
    staleTime: SOL_PRICE_USD_CACHE_MS,
    gcTime: SOL_PRICE_USD_CACHE_MS * 2,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });
 
  const pokemonAllowlistQuery = useQuery({
    queryKey: ["pokemon-card-allowlist"],
    queryFn: () => api.getPokemonCardAllowlist(),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  });
 
  // Use droppableMints (cards that are enabled AND not yet sent/won) for display
  // This ensures won cards are immediately removed from the showcase
  const displayMints = useMemo(() => {
    const droppable = pokemonAllowlistQuery.data?.droppableMints;
    const mints = pokemonAllowlistQuery.data?.mints;
    // Prefer droppableMints if available, otherwise fall back to mints
    return Array.isArray(droppable) && droppable.length > 0 ? droppable : (mints || []);
  }, [pokemonAllowlistQuery.data]);

  const cardsQuery = useQuery({
    queryKey: ["pokemon-cards-showcase", connection.rpcEndpoint, displayMints.join(",")],
    queryFn: () => getPokemonCardsResult(connection, { allowlist: displayMints }),
    staleTime: 1000 * 60 * 60 * 12,
    gcTime: 1000 * 60 * 60 * 24,
  });
 
  const items: PokemonCardNft[] = cardsQuery.data?.items ?? [];
 
  const sortedItems = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      const av = typeof a.insuredValueUsd === "number" && Number.isFinite(a.insuredValueUsd) ? a.insuredValueUsd : -1;
      const bv = typeof b.insuredValueUsd === "number" && Number.isFinite(b.insuredValueUsd) ? b.insuredValueUsd : -1;
      if (bv !== av) return bv - av;
      return (a.name || "").localeCompare(b.name || "") || a.mint.localeCompare(b.mint);
    });
    return copy;
  }, [items]);
 
  const totalInsuredValueUsd = useMemo(() => {
    return items.reduce((sum, nft) => {
      const v = nft.insuredValueUsd;
      return typeof v === "number" && Number.isFinite(v) ? sum + v : sum;
    }, 0);
  }, [items]);
 
  const minSol = useMemo(() => {
    const raw = Number.parseFloat(String((raceswapConfig as any)?.dropMinSol ?? "0.1"));
    return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
  }, [raceswapConfig]);
 
  const eligibleAtOneSol = useMemo(() => 1 >= minSol, [minSol]);
 
  const holderBoostMultiplier = holderBoostQuery.data?.multiplier ?? 1;
  const safeHolderBoost =
    Number.isFinite(holderBoostMultiplier) && holderBoostMultiplier > 0 ? holderBoostMultiplier : 1;
 
  const solPrice = solPriceQuery.data ?? 0;
  const oneSolUsdValue =
    Number.isFinite(solPrice) && solPrice > 0 ? solPrice : cachedSolPrice?.priceUsd ?? FALLBACK_SOL_PRICE_USD;
 
  // Odds per 1 SOL swap do NOT depend on SOL/USD (the ratio cancels out).
  // Compute instantly so the headline odds never show as blank.
  const baseProb01 = useMemo(
    () => calcCardWinProbability01(1, 1, 1, eligibleAtOneSol),
    [eligibleAtOneSol]
  );

  const boostedProb01 = useMemo(
    () => calcCardWinProbability01(1, 1, safeHolderBoost, eligibleAtOneSol),
    [safeHolderBoost, eligibleAtOneSol]
  );
 
  const showBoost = Boolean(walletAddress);
  const chancePrimary = showBoost ? boostedProb01 : baseProb01;
  const chancePrimaryLabel =
    (chancePrimary ? formatOneInChance01(chancePrimary) : null) ?? (eligibleAtOneSol ? "—" : "Not eligible");
 
  const fetchedAtLabel = useMemo(() => {
    const ts = cardsQuery.data?.fetchedAt;
    if (!ts || !Number.isFinite(ts)) return "—";
    try {
      return new Date(ts).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "—";
    }
  }, [cardsQuery.data?.fetchedAt]);
 
  return (
    <div className="container mx-auto px-3 sm:px-4 py-6 max-w-7xl space-y-6">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0b0d14] shadow-2xl ring-1 ring-white/5">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(closest-side,rgba(34,197,94,0.18),transparent_55%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(closest-side,rgba(168,85,247,0.14),transparent_55%)] [transform:translateX(18%)]" />
 
        <div className="relative p-5 sm:p-7">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2">
                  <Badge className="bg-white/5 text-white/80 border-white/10">Treasury Showcase</Badge>
                  <Badge className="bg-white/5 text-white/80 border-white/10">Provably Fair</Badge>
                </div>
                <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight">
                  <span className="bg-gradient-to-r from-green-300 via-emerald-400 to-cyan-300 bg-clip-text text-transparent drop-shadow-[0_8px_24px_rgba(34,197,94,0.15)]">
                    Card Drops
                  </span>
                </h1>
                <p className="mt-2 text-sm sm:text-base text-muted-foreground max-w-2xl lg:max-w-none">
                  Every qualifying swap can roll for a real Pokémon card from the on-chain RaceBank treasury.
                </p>
              </div>
 
              <div className="shrink-0 flex gap-2">
                <Button asChild variant="outline" className="border-white/10 bg-white/5 hover:bg-white/10">
                  <a href={RACEBANK_SOLSCAN} target="_blank" rel="noopener noreferrer">
                    racebank.sol <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>
 
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <Card className="border-white/10 bg-black/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-white/70 tracking-wider">Odds per 1 SOL swap</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="text-2xl sm:text-3xl font-extrabold text-white leading-tight">
                    {chancePrimaryLabel}
                  </div>
                  <div className="mt-1 text-xs text-white/60">
                    {formatPercentSmart01(chancePrimary ?? null)} @ 1 SOL (~{formatUsd(oneSolUsdValue)})
                  </div>
                  {showBoost && holderBoostQuery.data ? (
                    <div className="mt-2 text-xs text-white/70">
                      Your $RACE boost:{" "}
                      <span className="font-mono text-white">x{holderBoostQuery.data.multiplier.toFixed(2)}</span>{" "}
                      <span className="text-white/50">(tier {holderBoostQuery.data.tier.toUpperCase()})</span>
                    </div>
                  ) : null}
                  {!showBoost ? (
                    <div className="mt-2 text-xs text-white/60">
                      Connect a wallet to show your boosted odds.
                    </div>
                  ) : null}
                </CardContent>
              </Card>
 
              <Card className="border-white/10 bg-black/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-white/70 tracking-wider">Provably fair roll</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="text-sm text-white/80 leading-relaxed">
                    Drops are determined by a deterministic roll derived from your swap receipt (transaction signature + a
                    server-provided seed). The roll and win-threshold are published with your receipt, so anyone can verify
                    the outcome.
                  </div>
                  <div className="mt-2 text-xs text-white/60 leading-relaxed">
                    Tip: after any swap, open the receipt and click <span className="text-white/80 font-semibold">verify</span>{" "}
                    to reproduce the roll locally.
                  </div>
                </CardContent>
              </Card>
 
              <Card className="border-white/10 bg-black/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-white/70 tracking-wider">Treasury stats</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <div className="text-[11px] text-white/60">Total cards</div>
                      <div className="text-2xl font-extrabold text-white">{items.length || "—"}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] text-white/60">Total value</div>
                      <div className="text-2xl font-extrabold text-green-300">{items.length ? formatUsd(totalInsuredValueUsd) : "—"}</div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-white/60">
                    Updated: <span className="font-mono">{fetchedAtLabel}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
 
            <div className="text-xs text-white/55 leading-relaxed">
              <span className="text-white/70 font-semibold">Eligibility:</span> card drops are enabled for swaps ≥{" "}
              <span className="font-mono text-white/70">{minSol}</span> SOL (or the USDC threshold set server-side). Odds shown
              above assume a 1 SOL swap.
            </div>
          </div>
        </div>
      </div>
 
      {/* Showcase grid */}
      <div className="space-y-3">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-foreground">Pokémon card treasury</h2>
            <p className="text-sm text-muted-foreground">
              High-value assets held on-chain by <span className="font-mono">racebank.sol</span>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-white/5 text-white/80 border-white/10">
              Sorted by value
            </Badge>
          </div>
        </div>
 
        <Separator className="bg-white/10" />
 
        {cardsQuery.isPending ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} className="border-white/10 bg-[#0b0d14]">
                <CardContent className="p-3 space-y-3">
                  <Skeleton className="h-44 w-full rounded-xl" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-2/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : cardsQuery.isError ? (
          <Card className="border-white/10 bg-[#0b0d14]">
            <CardContent className="p-4 text-sm text-muted-foreground">
              Couldn’t load the card treasury.{" "}
              <Button
                variant="link"
                className="px-1"
                onClick={() => cardsQuery.refetch()}
                disabled={cardsQuery.isFetching}
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : sortedItems.length === 0 ? (
          <Card className="border-white/10 bg-[#0b0d14]">
            <CardContent className="p-4 text-sm text-muted-foreground">
              No cards found for the current allowlist.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {sortedItems.map((nft) => (
              <a
                key={nft.mint}
                href={solscanTokenUrl(nft.mint)}
                target="_blank"
                rel="noopener noreferrer"
                className="group"
              >
                <Card
                  className={cn(
                    "h-full border-white/10 bg-[#0b0d14] overflow-hidden transition-all",
                    "hover:border-primary/40 hover:bg-white/[0.03] hover:shadow-[0_18px_60px_-28px_rgba(34,197,94,0.55)]"
                  )}
                >
                  <CardContent className="p-0">
                    <div className="relative aspect-[3/4] w-full overflow-hidden bg-black/30">
                      {nft.image ? (
                        <img
                          src={nft.image}
                          alt={nft.name}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                        />
                      ) : (
                        <div className="h-full w-full bg-white/5" />
                      )}
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />
                      <div className="absolute left-2 top-2 flex gap-1.5">
                        <span className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-white/80 backdrop-blur">
                          Set: {nft.set?.trim?.() ? nft.set : "N/A"}
                        </span>
                        <span className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-white/80 backdrop-blur">
                          Grade: {nft.grade?.trim?.() ? nft.grade : "N/A"}
                        </span>
                      </div>
                      <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-white">{nft.name}</div>
                          <div className="mt-0.5 truncate text-[10px] text-white/60 font-mono">
                            {nft.mint.slice(0, 6)}…{nft.mint.slice(-4)}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[10px] text-white/60">Value</div>
                          <div className="text-xs font-semibold text-green-300">{formatUsd(nft.insuredValueUsd)}</div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

