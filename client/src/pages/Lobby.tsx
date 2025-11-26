import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, leaderboardApi, type Race, type Runner, type LeaderboardResponse, type LeaderboardRow } from '@/lib/api';
import { Popover, PopoverContent, PopoverTrigger, PopoverClose } from '@/components/ui/popover';
import type { UserReceiptRow } from '@/lib/api';
import { formatLargeNumber } from '@/lib/math';
import RaceCard from '@/components/RaceCard';
import { useStore } from '@/lib/store';
import { useEffect } from 'react';
import RaceGifOverlay from '@/components/RaceGifOverlay';
import { playMusic, stopMusic, playSound, audioManager } from '@/lib/audio';
import { getCountdownTargetAndLabel } from '@/helpers/raceTiming';
import { getUniqueOverlayLabel } from '@shared/race-name';

export default function Lobby() {
  const { setRace, admin, currency } = useStore();
  
  // Initialize audio and play lobby music
  useEffect(() => {
    // Initialize audio context on first user interaction
    const initAudio = () => {
      audioManager.initialize();
      playMusic('lobby_ambient');
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
    };
    
    document.addEventListener('click', initAudio);
    document.addEventListener('keydown', initAudio);
    
    return () => {
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
      stopMusic();
    };
  }, []);

  const { data: races, isLoading: racesLoading, error: racesError } = useQuery<Race[]>({
    queryKey: ['/api/races'],
    refetchInterval: 5000, // backstop in case SSE missed
    refetchOnWindowFocus: true, // refresh when user focuses tab
  });

  const { data: recentWinners, isLoading: winnersLoading } = useQuery<Race[]>({
    queryKey: ['/api/recent-winners', currency],
    queryFn: async () => {
      // Fetch and decorate with per-currency pot fields already provided by server
      const res = await fetch('/api/recent-winners');
      return res.json();
    },
    refetchInterval: 30000,
  });

  // User receipts (last 20)
  const connectedWallet = useStore.getState().wallet.address;
  const { data: receipts } = useQuery<UserReceiptRow[]>({
    queryKey: ['/api/user', connectedWallet || 'anon', 'receipts'],
    queryFn: () => connectedWallet ? api.getUserReceipts(connectedWallet, 20) : Promise.resolve([] as UserReceiptRow[]),
    enabled: Boolean(connectedWallet),
    refetchInterval: 20000
  });

  const { data: runners, isLoading: runnersLoading } = useQuery<Runner[]>({
    queryKey: ['/api/runners/top'],
    refetchInterval: 20000, // Refresh every 20 seconds
  });

  // Treasury info
  const { data: treasury } = useQuery<{ raceMint?: string; escrowPubkey: string; treasuryPubkey: string; jackpotPubkey: string; maintenanceMode?: boolean; maintenanceMessage?: string; maintenanceAnchorRaceId?: string; jackpotBalance?: string; jackpotBalanceSol?: string }>({
    queryKey: ['/api/treasury'],
    queryFn: () => api.getTreasury(),
    refetchInterval: 15000,
  });

  // Treasury $RACE balance for treasury wallet
  const treasuryAddress = treasury?.escrowPubkey || treasury?.treasuryPubkey;
  const { data: treasuryBalances } = useQuery<{ sol: string; race: string; raceDecimals: number }>({
    queryKey: ['/api/wallet', treasuryAddress || 'none', 'balances'],
    queryFn: () => api.getWalletBalances(treasuryAddress!),
    enabled: !!treasuryAddress,
    refetchInterval: 15000,
  });

  // Clear race state when entering lobby
  useEffect(() => {
    setRace({ currentRace: null, raceTotals: null, userBets: null });
  }, [setRace]);

  // Leaderboard data (separate by currency mode)
  const { data: leaderboard } = useQuery<LeaderboardResponse>({
    queryKey: ['/api/leaderboard', currency, connectedWallet || 'anon'],
    queryFn: () => leaderboardApi.getLeaderboard(25, connectedWallet || undefined),
    refetchInterval: 15000
  });

  // Determine if current user should see admin link: allowlisted wallets in production, visible to all in dev
  const adminWalletsStr = ((import.meta as any).env?.VITE_ADMIN_WALLETS || (import.meta as any).env?.VITE_ADMIN_WALLET || '') as string;
  const adminWalletSet = new Set(
    adminWalletsStr
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const isProd = Boolean((import.meta as any).env?.PROD);
  const isAdminWallet = connectedWallet ? adminWalletSet.has(connectedWallet.toLowerCase()) : false;
  const showAdminLink = isAdminWallet || !isProd;

  // Organize races by status for proper display progression
  // Add safety check to ensure races is an array before processing
  const sortedRaces = Array.isArray(races) ? races.sort((a, b) => (a.startTs || 0) - (b.startTs || 0)) : [];
  
  // Current active race (first OPEN race). During maintenance, only the anchored OPEN (if any).
  const openRaces = sortedRaces.filter(race => {
    const s = race.computedStatus ?? race.status;
    if (race.status === 'CANCELLED') return false;
    if (s !== 'OPEN') return false;
    if (treasury?.maintenanceMode) {
      return treasury?.maintenanceAnchorRaceId && race.id === treasury.maintenanceAnchorRaceId;
    }
    return true;
  });
  const activeRace = openRaces[0];
  
  // Future races (next 2 OPEN races after the active one)
  const futureRaces = openRaces
    .filter(race => race.id !== activeRace?.id)
    .slice(0, 2);
  
  // In progress races (LOCKED or IN_PROGRESS)
  const inProgressRaces = sortedRaces
    .filter(race => (race.computedStatus ?? race.status) === 'LOCKED' || (race.computedStatus ?? race.status) === 'IN_PROGRESS')
    .slice(0, 3);
  
  // Use dedicated recent winners data, but guard against accidental non-settled items
  // Add safety check to ensure recentWinners is an array
  const settledRaces = (Array.isArray(recentWinners) ? recentWinners : [])
    .filter((r) => (r.computedStatus ?? r.status) === 'SETTLED' && r.winnerIndex !== undefined)
    .slice(0, 6);

  const LEADERBOARD_VISIBLE_ROWS = 5;
  const RECEIPT_VISIBLE_ROWS = 5;
  const LEADERBOARD_ROW_HEIGHT_REM = 3.75;
  const RECEIPT_ROW_HEIGHT_REM = 3.25;

  const leaderboardRows: LeaderboardRow[] = leaderboard?.top ?? ([] as LeaderboardRow[]);
  const treasuryRow = treasuryAddress ? leaderboardRows.find((r) => r.wallet === treasuryAddress) : undefined;
  const nonTreasuryRows = treasuryRow ? leaderboardRows.filter((r) => r.wallet !== treasuryAddress) : leaderboardRows;
  const shouldLimitLeaderboardHeight = nonTreasuryRows.length > LEADERBOARD_VISIBLE_ROWS;
  const leaderboardScrollHeight = `${(LEADERBOARD_VISIBLE_ROWS + (treasuryRow ? 1 : 0)) * LEADERBOARD_ROW_HEIGHT_REM}rem`;

  const displayedReceipts = (receipts ?? []).slice(0, 20);
  const shouldLimitReceiptsHeight = displayedReceipts.length > RECEIPT_VISIBLE_ROWS;
  const receiptsScrollHeight = `${RECEIPT_VISIBLE_ROWS * RECEIPT_ROW_HEIGHT_REM}rem`;

  if (racesError) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Card className="max-w-md mx-auto">
          <CardContent className="pt-6">
            <div className="text-center">
              <i className="fas fa-exclamation-triangle text-4xl text-destructive mb-4"></i>
              <h2 className="text-lg font-semibold mb-2">Failed to Load Races</h2>
              <p className="text-sm text-muted-foreground">
                Unable to connect to the racing server. Please try again later.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* Hero Section */}
      <div className="text-center py-4">
        <h1 className="text-3xl font-bold text-primary mb-2 neon-glow">
          Welcome to Pump Racers
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
          A prediction market where you bet on which newly launched Pump.fun meme coins will have the highest price gains over 20 minutes. Winners split the prize pool based on real market performance.
        </p>
        {/* Inline rake info + referral CTA */}
        {/* Desktop: full text with referral note inline */}
        <div className="mt-3 hidden md:flex text-xs font-semibold items-center justify-center gap-3 flex-wrap">
          {currency === 'SOL' ? (
            <span className="px-2 py-1 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
              5% rake on SOL — 2% jackpot, 3% protocol (referrals earn from protocol)
            </span>
          ) : (
            <span className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              $RACE betting coming soon — SOL live now
            </span>
          )}
          <Link href="/referrals">
            <Button size="sm" variant="outline" className="bg-primary/10 text-primary border-primary/30 hover:bg-primary/20">
              <i className="fas fa-user-friends mr-2"></i>
              Earn with Referrals
            </Button>
          </Link>
        </div>
        {/* Mobile: shorter chip + move referral note below to avoid wrapping */}
        <div className="mt-3 md:hidden flex flex-col items-center gap-2">
          <div className="flex items-center justify-center gap-2 flex-wrap text-xs font-semibold">
            {currency === 'SOL' ? (
              <span className="px-2 py-1 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
                5% rake on SOL — 2% jackpot, 3% protocol
              </span>
            ) : (
              <span className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                $RACE betting coming soon — SOL live now
              </span>
            )}
            <Link href="/referrals">
              <Button size="sm" variant="outline" className="bg-primary/10 text-primary border-primary/30 hover:bg-primary/20">
                <i className="fas fa-user-friends mr-2"></i>
                Earn with Referrals
              </Button>
            </Link>
          </div>
          <div className="text-[11px] text-muted-foreground">Referrals earn from protocol</div>
        </div>
      </div>

      {/* Live & Upcoming Races */}
      <section>
        <div className="relative flex items-center justify-between mb-4">
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2 whitespace-nowrap">
            <i className="fas fa-flag-checkered text-primary"></i>
            Live & Upcoming Races
          </h2>
          {activeRace && (
            <Badge variant="secondary" className="animate-pulse">
              <i className="fas fa-circle text-green-500 mr-1"></i>
              LIVE
            </Badge>
          )}
          {/* Car overlay lane (over heading, non-blocking) */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 z-30 overflow-hidden" aria-hidden>
            <div className="car-lane">
              <img src="/car.gif" alt="car" className="car-sprite" />
            </div>
          </div>
        </div>

        {racesLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <Card key={i}>
                <CardContent className="p-6">
                  <Skeleton className="h-6 w-32 mb-4" />
                  <Skeleton className="h-4 w-full mb-2" />
                  <Skeleton className="h-4 w-3/4 mb-4" />
                  <Skeleton className="h-10 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <>
            {!activeRace && futureRaces.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <i className="fas fa-clock text-4xl text-muted-foreground mb-4"></i>
                  <h3 className="text-lg font-semibold mb-2">No Active Races</h3>
                  <p className="text-muted-foreground">
                    {treasury?.maintenanceMode ? 'Server upgrades in progress. Please stand by.' : 'New races will appear here. Check back soon!'}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {/* Current Active Race */}
                {activeRace && (
                  <RaceCard 
                    race={activeRace} 
                    variant="upcoming"
                    allowBetting={!Boolean(treasury?.maintenanceMode)}
                    data-testid={`race-card-${activeRace.id}`}
                  />
                )}

                {/* Future Races (Blurred) */}
                {futureRaces.map((race: Race, index: number) => (
                  <div key={race.id} className="relative">
                    <div className={`opacity-60 pointer-events-none ${treasury?.maintenanceMode ? '' : 'filter blur-sm'}`}>
                      <RaceCard 
                        race={race} 
                        variant="upcoming"
                        data-testid={`future-race-card-${race.id}`}
                      />
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="bg-background/90 backdrop-blur-sm border rounded-lg px-4 py-2 text-center">
                        <div className="font-semibold">{treasury?.maintenanceMode ? 'Maintenance Window' : getUniqueOverlayLabel(race.id, index + 2)}</div>
                        <div className="text-sm text-muted-foreground">
                          {treasury?.maintenanceMode ? (treasury?.maintenanceMessage || 'Going down momentarily for updates') : `Starts: ${new Date(race.startTs || 0).toLocaleTimeString()}`}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          Tokens will be selected from latest Pump.fun migrations
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* In Progress Races */}
      {inProgressRaces.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <i className="fas fa-stopwatch text-accent"></i>
              Races In Progress
            </h2>
            <Badge variant="destructive" className="animate-pulse">
              <i className="fas fa-lock mr-1"></i>
              BETTING CLOSED
            </Badge>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {inProgressRaces.map((race: Race) => {
              const status = (race.computedStatus ?? race.status);
              const { target, label } = getCountdownTargetAndLabel(race);
              const remaining = Math.max(0, target ? target - Date.now() : 0);
              const isSettleSoon = status === 'IN_PROGRESS' && label?.toLowerCase().includes('settles') && remaining <= 30000;
              return (
                <div key={race.id} className="relative">
                  <RaceCard 
                    race={race} 
                    variant="live"
                    data-testid={`in-progress-race-card-${race.id}`}
                  />
                  {!isSettleSoon && (
                    <div className="hidden md:block pointer-events-none absolute left-full top-1/2 -translate-y-1/2 translate-x-4 md:translate-x-6 lg:translate-x-8 z-10" style={{ width: 'clamp(6rem, 22vw, 10rem)' }}>
                      <RaceGifOverlay disabled={isSettleSoon} />
                    </div>
                  )}
                  {isSettleSoon && (
                    <div className="hidden md:block pointer-events-none absolute left-full top-1/2 -translate-y-1/2 translate-x-4 md:translate-x-6 lg:translate-x-8 z-10" style={{ width: 'clamp(6rem, 22vw, 10rem)' }}>
                      <div className="relative aspect-square overflow-hidden rounded-lg ring-4 ring-green-500/70 animate-pulse shadow-[0_0_30px_rgba(34,197,94,0.6)]">
                        <img 
                          src="/settle.gif" 
                          alt="Settlement imminent" 
                          className="w-full h-full object-contain"
                        />
                        <div className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-green-400/60"></div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Top Pump.fun Tokens */}
      <section>
        <h2 className="text-2xl font-bold flex items-center gap-2 mb-4">
          <i className="fas fa-trending-up text-secondary"></i>
          Trending Meme Coins
        </h2>

        {runnersLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="w-10 h-10 rounded-full" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-16 mb-1" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : runners && runners.length > 0 ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {runners.slice(0, 8).map((runner: Runner, index: number) => (
              <a 
                key={runner.mint}
                href={`https://dexscreener.com/solana/${runner.mint}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block hover:scale-105 transition-transform"
                data-testid={`token-link-${runner.symbol}`}
              >
                <Card className="hover:bg-card/80 hover:border-primary/50 transition-colors h-full cursor-pointer">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        {runner.logoURI ? (
                          <img 
                            src={runner.logoURI} 
                            alt={runner.symbol}
                            className="w-10 h-10 rounded-full border border-border"
                            onError={(e) => {
                              const target = e.currentTarget as HTMLImageElement;
                              target.style.display = 'none';
                              const nextElement = target.nextElementSibling as HTMLElement;
                              if (nextElement) nextElement.style.display = 'flex';
                            }}
                          />
                        ) : null}
                        <div 
                          className="w-10 h-10 rounded-full bg-gradient-to-r from-primary to-secondary flex items-center justify-center text-xs font-bold"
                          style={{ display: runner.logoURI ? 'none' : 'flex' }}
                        >
                          {runner.symbol.substring(0, 2)}
                        </div>
                        <div className="absolute -top-1 -right-1 w-5 h-5 bg-muted rounded-full flex items-center justify-center text-xs font-bold">
                          {index + 1}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate flex items-center gap-1" data-testid={`token-symbol-${runner.symbol}`}>
                          {runner.symbol}
                          <i className="fas fa-external-link-alt text-xs text-muted-foreground"></i>
                        </div>
                        <div className="text-xs text-muted-foreground" data-testid={`token-marketcap-${runner.symbol}`}>
                          ${formatLargeNumber(runner.marketCap || 0)}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-8 text-center">
              <i className="fas fa-exclamation-circle text-4xl text-muted-foreground mb-4"></i>
              <h3 className="text-lg font-semibold mb-2">Unable to Load Tokens</h3>
              <p className="text-muted-foreground">
                Failed to fetch Pump.fun token data. Please check your API configuration.
              </p>
            </CardContent>
          </Card>
        )}
      </section>

      {/* Admin Controls (Lobby) */}
      {admin?.authenticated && (
        <section>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <i className="fas fa-tools text-destructive"></i>
                Admin Controls
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-sm text-muted-foreground">Treasury $RACE Balance</div>
                  <div className="text-xl font-semibold">
                    {treasuryBalances ? `${formatLargeNumber(treasuryBalances.race || '0')} $RACE` : '...'}
                  </div>
                  {treasuryAddress && (
                    <div className="text-xs text-muted-foreground font-mono break-all">
                      {treasuryAddress}
                    </div>
                  )}
                </div>
                <div>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      try {
                        const resp = await api.emergency.clearRaces();
                        console.log('Emergency reset response', resp);
                        // Best-effort refresh
                        window.location.reload();
                      } catch (e) {
                        console.error(e);
                      }
                    }}
                  >
                    <i className="fas fa-exclamation-triangle mr-2"></i>
                    Emergency: Reset Races
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Recent Winners */}
      {/* Recent Winners - Always show section */}
      <section>
        <h2 className="text-2xl font-bold flex items-center gap-2 mb-4">
          <i className="fas fa-trophy text-accent"></i>
          Recent Winners
        </h2>
        
        {settledRaces.length === 0 ? (
          <Card className="bg-muted/20">
            <CardContent className="p-6 text-center">
              <i className="fas fa-hourglass-half text-4xl text-muted-foreground mb-4"></i>
              <p className="text-muted-foreground">No completed races yet. Winners will appear here after races finish!</p>
            </CardContent>
          </Card>
        ) : (

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {settledRaces.map((race: Race) => (
              <Card key={race.id} className="bg-gradient-to-r from-accent/10 to-primary/10 border-accent/30">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">{getUniqueOverlayLabel(race.id)}</span>
                    <Badge variant="outline" className="text-accent border-accent/50">
                      <i className="fas fa-crown mr-1"></i>
                      Winner
                    </Badge>
                  </div>
                  
                  {race.winnerIndex !== undefined && race.runners[race.winnerIndex] && (
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        {race.runners[race.winnerIndex].logoURI ? (
                          <img 
                            src={race.runners[race.winnerIndex].logoURI} 
                            alt={race.runners[race.winnerIndex].symbol}
                            className="w-8 h-8 rounded-full border border-accent"
                            onError={(e) => {
                              const target = e.currentTarget as HTMLImageElement;
                              target.style.display = 'none';
                              const nextElement = target.nextElementSibling as HTMLElement;
                              if (nextElement) nextElement.style.display = 'flex';
                            }}
                          />
                        ) : null}
                        <div 
                          className="w-8 h-8 rounded-full bg-gradient-to-r from-accent to-primary flex items-center justify-center text-xs font-bold"
                          style={{ display: race.runners[race.winnerIndex].logoURI ? 'none' : 'flex' }}
                        >
                          {race.runners[race.winnerIndex].symbol.substring(0, 2)}
                        </div>
                      </div>
                      <div className="flex-1">
                        <div className="font-semibold text-accent" data-testid={`winner-symbol-${race.id}`}>
                          {race.runners[race.winnerIndex].symbol}
                        </div>
                    <div className="text-xs text-muted-foreground">
                      {(() => {
                        const isSol = currency === 'SOL';
                        const pot = isSol ? (race as any).totalPotSol || '0' : (race as any).totalPotRace || '0';
                        return `Pot: ${formatLargeNumber(pot)} ${isSol ? 'SOL' : '$RACE'}`;
                      })()}
                    </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 mt-3">
                    <Link href={`/race/${race.id}/results`}>
                      <Button variant="ghost" size="sm" className="w-full text-accent hover:text-accent" data-testid={`view-results-${race.id}`}>
                        <i className="fas fa-eye mr-2"></i>
                        View Results
                      </Button>
                    </Link>
                    
                    {race.winnerIndex !== undefined && race.runners[race.winnerIndex] && (
                      <div className="grid grid-cols-3 gap-1">
                        <a 
                          href={`https://www.geckoterminal.com/solana/pools?search=${race.runners[race.winnerIndex].mint}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Button variant="outline" size="sm" className="w-full text-xs" data-testid={`verify-gecko-${race.id}`}>
                            <i className="fas fa-chart-area mr-1"></i>
                            Gecko
                          </Button>
                        </a>
                        <a 
                          href={race.runners[race.winnerIndex].geckoTerminalUrl || `https://www.geckoterminal.com/solana/pools/${race.runners[race.winnerIndex].mint}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Button variant="outline" size="sm" className="w-full text-xs" data-testid={`verify-geckoterminal-${race.id}`}>
                            <i className="fas fa-chart-bar mr-1"></i>
                            Chart
                          </Button>
                        </a>
                        <a 
                          href={`https://birdeye.so/token/${race.runners[race.winnerIndex].mint}?chain=solana`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Button variant="outline" size="sm" className="w-full text-xs" data-testid={`verify-birdeye-${race.id}`}>
                            <i className="fas fa-feather mr-1"></i>
                            Bird
                          </Button>
                        </a>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Global Leaderboard (switches with currency mode) */}
      <section>
        <h2 className="text-2xl font-bold flex items-center gap-2 mb-4">
          <i className="fas fa-list-ol text-primary"></i>
          {currency === 'SOL' ? 'SOL Leaderboard' : '$RACE Leaderboard'}
        </h2>

        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-7 text-xs uppercase text-muted-foreground px-3">
              <div className="py-2">Rank</div>
              <div className="py-2">Wallet</div>
              <div className="py-2 text-right">Win Rate</div>
              <div className="py-2 text-right">Races</div>
              <div className="py-2 text-right">{currency === 'SOL' ? 'SOL Awarded' : '$RACE Awarded'}</div>
              <div className="py-2 text-right">{currency === 'SOL' ? 'SOL Wagered' : '$RACE Wagered'}</div>
              <div className="py-2 text-right">Edge Points</div>
            </div>
              <div
                className={`divide-y divide-border rounded border border-border ${shouldLimitLeaderboardHeight ? 'overflow-y-auto no-scrollbar' : ''}`}
                style={shouldLimitLeaderboardHeight ? { maxHeight: leaderboardScrollHeight } : undefined}
              >
                {treasuryRow && (
                  <div key={treasuryRow.wallet} className="grid grid-cols-7 items-center px-3 bg-amber-500/5">
                    {/* Rank column replaced with bank emoji */}
                    <div className="py-3 font-semibold flex items-center gap-2 text-amber-300">
                      <span role="img" aria-label="bank">🏦</span>
                    </div>
                    <div className="py-3 font-mono text-xs truncate flex items-center gap-1 text-amber-300">
                      {'racepumpBank'}
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center p-0 text-amber-300/80 hover:text-amber-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-border rounded-sm"
                            aria-label="Treasury info"
                          >
                            <i className="fas fa-info-circle"></i>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent side="top" align="start" className="w-[min(90vw,32rem)] max-w-[90vw] relative pl-4 pr-10 py-5 text-left">
                          <PopoverClose
                            className="absolute right-2 top-2 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                            aria-label="Close"
                          >
                            <i className="fas fa-times"></i>
                          </PopoverClose>
                          <div className="space-y-3.5">
                            <div className="flex items-center gap-2 border-b border-border pb-2">
                              <span className="text-lg">🏦</span>
                              <h3 className="text-base font-bold">RacePump Bank</h3>
                            </div>
                            
                            <div className="space-y-2.5">
                              <p className="text-sm leading-relaxed text-muted-foreground">
                                The protocol's escrow wallet automatically seeds every race to ensure exciting gameplay and fair payouts.
                              </p>
                              
                              <div className="space-y-2">
                                <h4 className="text-sm font-semibold flex items-center gap-1.5">
                                  <i className="fas fa-seedling text-primary text-xs"></i>
                                  What It Does
                                </h4>
                                <ul className="text-sm leading-relaxed space-y-1.5 pl-1">
                                  <li className="flex items-start gap-2">
                                    <i className="fas fa-check text-green-500 text-xs mt-0.5"></i>
                                    <span>Seeds all races with balanced bets across every runner</span>
                                  </li>
                                  <li className="flex items-start gap-2">
                                    <i className="fas fa-check text-green-500 text-xs mt-0.5"></i>
                                    <span>Prevents dust-only winners by guaranteeing minimum pot size</span>
                                  </li>
                                  <li className="flex items-start gap-2">
                                    <i className="fas fa-check text-green-500 text-xs mt-0.5"></i>
                                    <span>Encourages early participation with guaranteed liquidity</span>
                                  </li>
                                </ul>
                              </div>
                              
                              <div className="pt-2 border-t border-border/50">
                                <p className="text-xs text-muted-foreground italic">
                                  <i className="fas fa-info-circle mr-1"></i>
                                  This wallet does not earn Edge Points. All displayed statistics reflect actual on-chain activity.
                                </p>
                              </div>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="py-3 text-right text-amber-300">{treasuryRow.totalRaces > 0 ? Math.round((treasuryRow.wins / treasuryRow.totalRaces) * 100) : 0}%</div>
                    <div className="py-3 text-right text-amber-300">{treasuryRow.totalRaces}</div>
                    <div className="py-3 text-right text-amber-300">{formatLargeNumber(treasuryRow.totalAwarded)} </div>
                    <div className="py-3 text-right text-amber-300/80">{formatLargeNumber(treasuryRow.totalWagered)}</div>
                    <div className="py-3 text-right font-bold text-amber-300">{formatLargeNumber(treasuryRow.edgePoints)}</div>
                  </div>
                )}

                {nonTreasuryRows.map((row, idx) => {
                  const isYou = connectedWallet && row.wallet === connectedWallet;
                  const rank = idx + 1; // rank among non-treasury rows
                  const winRate = row.totalRaces > 0 ? Math.round((row.wins / row.totalRaces) * 100) : 0;
                  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
                  return (
                    <div key={row.wallet} className={`grid grid-cols-7 items-center px-3 ${isYou ? 'bg-primary/5' : ''}`}>
                      <div className="py-3 font-semibold flex items-center gap-2">
                        <span>{rank}</span>
                        {medal && <span className="text-lg" aria-label={`rank-${rank}`}>{medal}</span>}
                      </div>
                      <div className="py-3 font-mono text-xs truncate flex items-center gap-1">
                        {row.wallet}
                        {isYou && (
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded bg-secondary/30 text-secondary text-[10px] uppercase tracking-wide">This is you</span>
                        )}
                      </div>
                      <div className="py-3 text-right">{winRate}%</div>
                      <div className="py-3 text-right">{row.totalRaces}</div>
                      <div className="py-3 text-right">{formatLargeNumber(row.totalAwarded)} </div>
                      <div className="py-3 text-right text-muted-foreground">{formatLargeNumber(row.totalWagered)}</div>
                      <div className="py-3 text-right font-bold text-primary">{formatLargeNumber(row.edgePoints)}</div>
                    </div>
                  );
                })}

                {leaderboardRows.length === 0 && (
                  <div className="p-4 text-center text-muted-foreground">No leaderboard data yet. Place bets to climb the ranks.</div>
                )}
              </div>
          </div>
        </div>

        {connectedWallet && leaderboard?.you && leaderboard.rank && (
          <div className="mt-3 text-xs text-muted-foreground">
            Your rank: <span className="font-semibold text-foreground">#{leaderboard.rank}</span> • Edge Points: <span className="font-semibold text-primary">{formatLargeNumber(leaderboard.you.edgePoints)}</span>
          </div>
        )}
      </section>
        {/* Your Recent Receipts */}
        {connectedWallet && displayedReceipts.length > 0 && (
          <section>
            <h2 className="text-2xl font-bold flex items-center gap-2 mb-4">
              <i className="fas fa-receipt text-secondary"></i>
              Your Recent Receipts
            </h2>
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className="grid grid-cols-7 text-xs uppercase text-muted-foreground px-3">
                  <div className="py-2">Race</div>
                  <div className="py-2 text-right">Bet</div>
                  <div className="py-2 text-right">Payout</div>
                  <div className="py-2 text-right">Edge Pts</div>
                  <div className="py-2 text-right">Result</div>
                  <div className="py-2">Time</div>
                  <div className="py-2 text-right">Tx</div>
                </div>
                <div
                  className={`divide-y divide-border rounded border border-border ${shouldLimitReceiptsHeight ? 'overflow-y-auto no-scrollbar' : ''}`}
                  style={shouldLimitReceiptsHeight ? { maxHeight: receiptsScrollHeight } : undefined}
                >
                  {displayedReceipts.map((r) => {
                    const isWin = !!(r.win as any);
                    const idShort = r.raceId.slice(-6);
                    const explorer = r.txSig ? `https://solscan.io/tx/${r.txSig}` : undefined;
                    return (
                      <div key={`${r.raceId}-${r.ts}`} className="grid grid-cols-7 items-center px-3">
                        <div className="py-2 font-mono text-xs">{idShort}</div>
                        <div className="py-2 text-right text-muted-foreground">
                          {formatLargeNumber(r.betAmount)} <span className="text-[10px] text-muted-foreground">{(r as any).currency === 'SOL' ? 'SOL' : '$RACE'}</span>
                        </div>
                        <div className={`py-2 text-right ${isWin ? 'text-primary' : 'text-muted-foreground'}`}>
                          {formatLargeNumber(r.payoutAmount)} <span className="text-[10px] text-muted-foreground">{(r as any).currency === 'SOL' ? 'SOL' : '$RACE'}</span>
                        </div>
                        <div className="py-2 text-right">{formatLargeNumber((r as any).edgePoints || '0')}</div>
                        <div className="py-2 text-right">{isWin ? 'WIN' : 'LOSS'}</div>
                        <div className="py-2 text-xs text-muted-foreground">{new Date(r.ts).toLocaleString()}</div>
                        <div className="py-2 text-right">
                          {explorer ? (
                            <a href={explorer} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">View</a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        )}

      {/* Admin Access */}
      {showAdminLink && (
        <div className="text-center py-4">
          <Link href="/admin">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="admin-link">
              <i className="fas fa-cog mr-2"></i>
              Admin Panel
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}
