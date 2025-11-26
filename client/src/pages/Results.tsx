import { useEffect, useState } from 'react';
import { useParams, Link } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
// Removed wallet adapter import for browser compatibility
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { api, type Race, type RaceTotals, type UserBets, type RaceHistoryResponse } from '@/lib/api';
import { getRaceDisplayName } from '@shared/race-name';
import { useStore } from '@/lib/store';
import { formatLargeNumber, calculatePayout } from '@/lib/math';

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

export default function Results() {
  const { raceId } = useParams();
  const { wallet, showToast, currency } = useStore();
  const publicKey = wallet.address; // Use connected wallet if available
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showOHLCVVerification, setShowOHLCVVerification] = useState(false);

  // Fetch race data and also check SSE store for updates
  const { data: raceData, isLoading: raceLoading, error: raceError } = useQuery<Race>({
    queryKey: ['/api/races', raceId],
    enabled: !!raceId,
  });
  
  // Also get current race from SSE store for real-time updates
  const { race } = useStore();
  const sseRace = race; // SSE store only tracks current race

  // Fetch race totals for final calculations
  const { data: totals, isLoading: totalsLoading } = useQuery<RaceTotals>({
    queryKey: ['/api/races', raceId, 'totals', currency],
    enabled: !!raceId,
    queryFn: async () => {
      const url = new URL(`/api/races/${raceId}/totals`, window.location.origin);
      url.searchParams.set('currency', currency);
      const res = await fetch(url.pathname + url.search);
      return res.json();
    }
  });

  // Fetch user bets
  const { data: userBets, isLoading: userBetsLoading } = useQuery<UserBets | null>({
    queryKey: ['/api/races', raceId, 'bets', currency],
    queryFn: async () => {
      if (!publicKey || !raceId) return null;
      const url = new URL(`/api/races/${raceId}/bets`, window.location.origin);
      url.searchParams.set('wallet', publicKey);
      url.searchParams.set('currency', currency);
      const resp = await fetch(url.pathname + url.search);
      return resp.json();
    },
    enabled: !!publicKey && !!raceId,
    refetchInterval: 5000,
  });

  // Replay chart data (server-provided simplified history)
  const { data: history } = useQuery<RaceHistoryResponse>({
    queryKey: ['/api/races', raceId, 'history'],
    enabled: !!raceId,
    staleTime: 60000,
  });

  // Fetch OHLCV verification data
  const { data: ohlcvData, isLoading: ohlcvLoading } = useQuery({
    queryKey: ['/api/races', raceId, 'ohlcv'],
    enabled: !!raceId && raceData?.status === 'SETTLED' && showOHLCVVerification,
  });

  // Remove manual claim flow: winnings are auto-paid on settlement. We still fetch result to show tx link.
  const claimMutation = useMutation({
    mutationFn: async () => {
      if (!publicKey || !raceId) throw new Error('Wallet not connected');
      // Query race result for tx link; server auto-pays
      return api.getRaceResult(raceId!, publicKey!, currency as any);
    },
    onSuccess: (data: any) => {
      const amt = data?.payoutAmount || '0';
      const tx = data?.txSig as string | undefined;
      const unit = currency === 'SOL' ? 'SOL' : '$RACE';
      showToast('Paid Automatically', `${formatLargeNumber(amt)} ${unit}${tx ? ' • Tx posted' : ''}`, 'success');
      queryClient.invalidateQueries({ queryKey: ['/api/races', raceId, 'bets'] });
    },
    onError: (error: any) => {
      showToast('Claim Lookup Failed', error?.message || String(error), 'error');
    },
  });

  // Calculate user winnings
  const calculateUserWinnings = () => {
    if (!raceData || !userBets || !totals || raceData.winnerIndex === undefined) {
      return { totalWinnings: '0', winningBets: [], hasWinnings: false };
    }

    const winningBets = userBets.bets.filter(bet => bet.runnerIdx === raceData.winnerIndex);
    
    if (winningBets.length === 0) {
      return { totalWinnings: '0', winningBets: [], hasWinnings: false };
    }

    // Calculate total winnings based on parimutuel odds
    let totalWinnings = 0;
    winningBets.forEach(bet => {
      const payout = calculatePayout(bet.amount, totals.impliedOdds[bet.runnerIdx]);
      totalWinnings += parseFloat(payout);
    });

    return { 
      totalWinnings: totalWinnings.toString(), 
      winningBets, 
      hasWinnings: true 
    };
  };

  const userWinnings = calculateUserWinnings();

  if (raceError) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Card className="max-w-md mx-auto">
          <CardContent className="pt-6 text-center">
            <i className="fas fa-exclamation-triangle text-4xl text-destructive mb-4"></i>
            <h2 className="text-lg font-semibold mb-2">Race Not Found</h2>
            <p className="text-sm text-muted-foreground mb-4">
              The requested race could not be found.
            </p>
            <Link href="/">
              <Button data-testid="back-to-lobby">
                <i className="fas fa-arrow-left mr-2"></i>
                Back to Lobby
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Race Replay (winner series) */}
        {history && winnerIndex !== null && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <i className="fas fa-history text-secondary"></i>
                Race Replay
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const series = history.runners?.find(r => r.runnerIndex === (winnerIndex as number))?.points || [];
                const data = series.map(p => ({ t: p.t, pct: (p.v - 1) * 100 }));
                return (
                  <div style={{ width: '100%', height: 280 }}>
                    <ResponsiveContainer>
                      <LineChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="t" tickFormatter={(v: number) => `${v}s`} />
                        <YAxis domain={[-50, 50]} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                        <Tooltip formatter={(v: any) => [`${Number(v).toFixed(2)}%`, 'Change']} labelFormatter={(l: any) => `t=${l}s`} />
                        <Line type="monotone" dataKey="pct" stroke="#10b981" dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  if (raceLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="max-w-4xl mx-auto space-y-6">
          <Card>
            <CardContent className="p-6">
              <Skeleton className="h-8 w-48 mb-4" />
              <Skeleton className="h-24 mb-4" />
              <Skeleton className="h-32" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!raceData) return null;
  
  // Check both API data and SSE store for race completion
  const isRaceSettled = raceData.status === 'SETTLED' || 
                       (raceData.winnerIndex !== undefined && raceData.winnerIndex !== null) ||
                       (sseRace && sseRace.winnerIndex !== undefined && sseRace.winnerIndex !== null);
                       
  console.log('Results page race status check:', {
    raceId,
    apiStatus: raceData.status,
    apiWinner: raceData.winnerIndex,
    sseWinner: sseRace?.winnerIndex,
    isRaceSettled
  });

  if (!isRaceSettled) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Card className="max-w-md mx-auto">
          <CardContent className="pt-6 text-center">
            <i className="fas fa-clock text-4xl text-muted-foreground mb-4"></i>
            <h2 className="text-lg font-semibold mb-2">Race Not Finished</h2>
            <p className="text-sm text-muted-foreground mb-4">
              This race has not finished yet. Results will be available once the race is complete.
            </p>
            <Link href={`/race/${raceId}`}>
              <Button data-testid="back-to-race">
                <i className="fas fa-arrow-left mr-2"></i>
                Back to Race
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Get winner from either API or SSE store
  const winnerIndex = raceData.winnerIndex !== undefined ? raceData.winnerIndex : sseRace?.winnerIndex;
  const winner = winnerIndex !== undefined && winnerIndex !== null && raceData.runners ? raceData.runners[winnerIndex] : null;

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Winner Announcement */}
        <Card className="bg-gradient-to-r from-accent/20 to-primary/20 border-accent/50">
          <CardContent className="py-8 text-center">
            <div className="w-16 h-16 bg-gradient-to-r from-accent to-primary rounded-full flex items-center justify-center mx-auto mb-4 animate-neon-pulse">
              <i className="fas fa-trophy text-2xl text-white"></i>
            </div>
            
            <h1 className="text-3xl font-bold text-accent mb-2 animate-winner-glow" data-testid="race-complete-title">
              {getRaceDisplayName(raceData.id)} Complete!
            </h1>
            
            {/* GeckoTerminal Price Verification */}
            {winner && (
              <div className="mb-4">
                <button
                  onClick={() => setShowOHLCVVerification(!showOHLCVVerification)}
                  className="inline-flex items-center gap-2 px-3 py-1 bg-blue-500/20 border border-blue-500/50 rounded-md text-blue-400 hover:bg-blue-500/30 transition-colors text-sm mr-2"
                  data-testid="verify-ohlcv-data"
                >
                  <i className="fas fa-chart-area"></i>
                  {showOHLCVVerification ? 'Hide' : 'Verify'} OHLCV Data
                  <i className={`fas ${showOHLCVVerification ? 'fa-chevron-up' : 'fa-chevron-down'} text-xs`}></i>
                </button>
                <a 
                  href={winner.geckoTerminalUrl || `https://www.geckoterminal.com/solana/pools/${winner.mint}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-1 bg-green-500/20 border border-green-500/50 rounded-md text-green-400 hover:bg-green-500/30 transition-colors text-sm"
                  data-testid="verify-geckoterminal"
                >
                  <i className="fas fa-chart-bar"></i>
                  Price Chart
                  <i className="fas fa-external-link-alt text-xs"></i>
                </a>
                <div className="text-xs text-muted-foreground mt-1">
                  Race settled using live GeckoTerminal API price data • Winner had highest % gain
                  {raceData.drandSignature && (
                    <div className="mt-1 font-mono text-xs">
                      Settlement: {raceData.drandSignature}
                    </div>
                  )}
                </div>
                
                {/* Display actual price performance if available */}
                {raceData.drandRandomness && (
                  <div className="mt-3 p-3 bg-card/50 rounded-lg text-left">
                    <div className="text-xs font-semibold text-muted-foreground mb-2">
                      <i className="fas fa-chart-line mr-1"></i>
                      Price Performance During Race
                    </div>
                    {(() => {
                      try {
                        const priceData = JSON.parse(raceData.drandRandomness);
                        return (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                            {priceData.map((data: any, idx: number) => (
                              <div 
                                key={idx} 
                                className={`flex justify-between p-2 rounded ${
                                  idx === raceData.winnerIndex ? 'bg-accent/20 text-accent' : 'bg-muted/30'
                                }`}
                              >
                                <span className="font-mono">{data.symbol}:</span>
                                <span className={`font-mono ${
                                  data.priceChange >= 0 ? 'text-green-400' : 'text-red-400'
                                }`}>
                                  {data.priceChange >= 0 ? '+' : ''}{data.priceChange.toFixed(2)}%
                                </span>
                              </div>
                            ))}
                          </div>
                        );
                      } catch {
                        return <div className="text-xs text-muted-foreground">Price data unavailable</div>;
                      }
                    })()}
                  </div>
                )}

                {/* GeckoTerminal OHLCV Verification Panel */}
                {showOHLCVVerification && (
                  <div className="mt-4 p-4 bg-card/30 border border-accent/20 rounded-lg">
                    <div className="text-sm font-semibold text-accent mb-3">
                      <i className="fas fa-chart-area mr-2"></i>
                      GeckoTerminal OHLCV Verification
                    </div>
                    
                    {ohlcvLoading ? (
                      <div className="text-center py-4">
                        <i className="fas fa-spinner fa-spin text-accent mr-2"></i>
                        Loading minute-level price data...
                      </div>
                    ) : ohlcvData ? (
                      <div>
                        <div className="text-xs text-muted-foreground mb-3">
                          <div className="flex items-center gap-2 mb-1">
                            <i className="fas fa-chart-bar text-accent"></i>
                            <span className="font-semibold">GeckoTerminal OHLCV Data</span>
                          </div>
                          Duration: {ohlcvData.raceDuration} • Data Source: {ohlcvData.dataSource}
                        </div>
                        <div className="grid gap-2">
                          {ohlcvData.verificationData.map((token: any, idx: number) => (
                            <div 
                              key={token.mint}
                              className={`flex justify-between items-center p-3 rounded ${
                                idx === ohlcvData.winnerIndex ? 'bg-accent/10 border border-accent/30' : 'bg-muted/20'
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-semibold">{token.symbol}</span>
                                {token.verified ? (
                                  <i className="fas fa-check-circle text-green-400 text-xs"></i>
                                ) : (
                                  <i className="fas fa-exclamation-circle text-yellow-400 text-xs" title="No pool data available"></i>
                                )}
                              </div>
                              <div className="text-right">
                                <div className="space-y-1">
                                  {token.candles > 0 ? (
                                    <div>
                                      <div className={`font-mono text-sm ${
                                        token.priceChange >= 0 ? 'text-green-400' : 'text-red-400'
                                      }`}>
                                        {token.priceChange >= 0 ? '+' : ''}{token.priceChange.toFixed(2)}%
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        Start: ${token.startPrice?.toFixed(6) || '0.000000'}
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        End: ${token.endPrice?.toFixed(6) || '0.000000'}
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        {token.candles} data points
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-muted-foreground">
                                      Pool found, fetching data...
                                    </div>
                                  )}
                                  <a
                                    href={token.chartUrl.includes('/pools/') ? 
                                      token.chartUrl.replace('https://www.geckoterminal.com/solana/pools/', 'https://api.geckoterminal.com/api/v2/networks/solana/pools/') + '/ohlcv/minute?aggregate=1' :
                                      token.chartUrl
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-accent hover:underline inline-block"
                                  >
                                    <i className="fas fa-chart-line mr-1"></i>
                                    OHLCV API Data
                                  </a>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-4 text-muted-foreground">
                        <i className="fas fa-exclamation-triangle mr-2"></i>
                        OHLCV verification data unavailable
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            
            {winner && (
              <div className="mb-6">
                <div className="flex items-center justify-center gap-3 mb-2">
                  {winner.logoURI ? (
                    <img 
                      src={winner.logoURI} 
                      alt={winner.symbol}
                      className="w-12 h-12 rounded-full border-2 border-accent"
                      onError={(e) => {
                        const target = e.currentTarget as HTMLImageElement;
                        target.style.display = 'none';
                        const nextElement = target.nextElementSibling as HTMLElement;
                        if (nextElement) nextElement.style.display = 'flex';
                      }}
                    />
                  ) : null}
                  <div 
                    className="w-12 h-12 rounded-full bg-gradient-to-r from-accent to-primary flex items-center justify-center text-lg font-bold"
                    style={{ display: winner.logoURI ? 'none' : 'flex' }}
                  >
                    {winner.symbol.substring(0, 2)}
                  </div>
                  <span className="text-2xl font-bold text-accent" data-testid="winner-symbol">
                    {winner.symbol}
                  </span>
                  <span className="text-xl text-foreground">Wins!</span>
                </div>
                <div className="text-sm text-muted-foreground" data-testid="winner-name">
                  {winner.name}
                </div>
              </div>
            )}

            {/* Race Stats */}
            <div className="grid grid-cols-3 gap-4 max-w-md mx-auto">
              <div className="text-center">
                <div className="text-lg font-bold text-primary" data-testid="final-pot">
                  {formatLargeNumber(raceData.totalPot || '0')}
                </div>
                <div className="text-xs text-muted-foreground">Total Pot</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-secondary" data-testid="final-bets">
                  {raceData.betCount || 0}
                </div>
                <div className="text-xs text-muted-foreground">Total Bets</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-accent">
                  {raceData.jackpotFlag ? 'YES' : 'NO'}
                </div>
                <div className="text-xs text-muted-foreground">Jackpot</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Meme Reward Winner */}
        {raceData.memeRewardEnabled && raceData.memeRewardRecipient && winner && (
          <Card className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 border-orange-500/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-orange-600 dark:text-orange-400">
                <i className="fas fa-coins"></i>
                Meme Reward Winner
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="bg-card/50 rounded-lg p-4 border border-orange-500/20">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-gradient-to-r from-orange-500 to-amber-500 rounded-full flex items-center justify-center">
                      <i className="fas fa-trophy text-white"></i>
                    </div>
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground mb-1">Lucky Winner</div>
                      <div className="font-mono text-sm break-all" data-testid="meme-reward-winner">
                        {raceData.memeRewardRecipient.slice(0, 8)}...{raceData.memeRewardRecipient.slice(-8)}
                      </div>
                    </div>
                    {publicKey === raceData.memeRewardRecipient && (
                      <Badge variant="outline" className="bg-green-500/20 text-green-500 border-green-500/50">
                        <i className="fas fa-check mr-1"></i>
                        You Won!
                      </Badge>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="bg-muted/30 rounded p-3">
                      <div className="text-xs text-muted-foreground mb-1">Tokens Received</div>
                      <div className="font-mono text-sm font-semibold text-orange-600 dark:text-orange-400" data-testid="meme-reward-amount">
                        {raceData.memeRewardTokenAmount} {winner.symbol}
                      </div>
                    </div>
                    <div className="bg-muted/30 rounded p-3">
                      <div className="text-xs text-muted-foreground mb-1">SOL Spent</div>
                      <div className="font-mono text-sm font-semibold">
                        {raceData.memeRewardSolSpent} SOL
                      </div>
                    </div>
                  </div>
                  
                  {raceData.memeRewardTxSig && (
                    <div className="flex gap-2">
                      <a 
                        href={`https://solscan.io/tx/${raceData.memeRewardTxSig}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-orange-500/20 border border-orange-500/50 rounded-md text-orange-400 hover:bg-orange-500/30 transition-colors text-sm font-medium"
                        data-testid="meme-reward-tx-link"
                      >
                        <i className="fas fa-external-link-alt"></i>
                        View Transaction
                      </a>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(raceData.memeRewardTxSig!);
                          toast({
                            title: "Copied!",
                            description: "Transaction signature copied to clipboard",
                          });
                        }}
                        className="px-4 py-2 bg-muted/50 border border-muted rounded-md hover:bg-muted/70 transition-colors"
                        data-testid="copy-meme-reward-tx"
                      >
                        <i className="fas fa-copy"></i>
                      </button>
                    </div>
                  )}
                  
                  <div className="mt-3 text-xs text-muted-foreground text-center">
                    <i className="fas fa-info-circle mr-1"></i>
                    Random bettor selected to receive {raceData.memeRewardSolSpent} SOL worth of {winner.symbol} tokens
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* User Results */}
        {publicKey && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <i className="fas fa-user text-primary"></i>
                Your Results
              </CardTitle>
            </CardHeader>
            <CardContent>
              {userBetsLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-16" />
                  <Skeleton className="h-12" />
                </div>
              ) : !userBets || userBets.bets.length === 0 ? (
                <div className="text-center py-8">
                  <i className="fas fa-info-circle text-4xl text-muted-foreground mb-4"></i>
                  <h3 className="text-lg font-semibold mb-2">No Bets Placed</h3>
                  <p className="text-muted-foreground">
                    You didn't place any bets on this race.
                  </p>
                </div>
              ) : userWinnings.hasWinnings ? (
                <>
                  {/* Winnings Display */}
                  <div className="bg-primary/10 border border-primary/30 rounded-lg p-6 mb-6 text-center">
                    <h3 className="text-lg font-semibold text-primary mb-2">
                      🎉 Congratulations! You Won! 🎉
                    </h3>
                    <div className="text-3xl font-bold text-primary font-mono mb-2" data-testid="user-winnings">
                      {formatLargeNumber(userWinnings.totalWinnings)} {currency === 'SOL' ? 'SOL' : '$RACE'}
                    </div>
                    <div className="text-sm text-muted-foreground mb-4">
                      Total Winnings from {userWinnings.winningBets.length} winning bet{userWinnings.winningBets.length > 1 ? 's' : ''}
                    </div>
                    
                    <div className="flex flex-col items-center gap-2">
                      <div className="text-xs text-muted-foreground">
                        Payouts are auto-sent from escrow on settlement.
                      </div>
                      <Button 
                        onClick={() => claimMutation.mutate()}
                        disabled={claimMutation.isPending}
                        variant="secondary"
                        className="hover:bg-secondary/80"
                        data-testid="view-payout-tx-btn"
                      >
                        {claimMutation.isPending ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
                            Checking payment…
                          </>
                        ) : (
                          <>
                            <i className="fas fa-receipt mr-2"></i>
                            View Payment
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Winning Bets Details */}
                  <div className="space-y-2">
                    <h4 className="font-semibold mb-2">Winning Bets:</h4>
                    {userWinnings.winningBets.map((bet) => (
                      <div key={bet.id} className="flex items-center justify-between p-3 bg-primary/5 border border-primary/20 rounded" data-testid={`winning-bet-${bet.id}`}>
                        <div className="flex items-center gap-3">
                          {bet.runner?.logoURI ? (
                            <img 
                              src={bet.runner.logoURI} 
                              alt={bet.runner.symbol}
                              className="w-6 h-6 rounded-full"
                            />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-gradient-to-r from-primary to-secondary flex items-center justify-center text-xs font-bold">
                              {bet.runner?.symbol.substring(0, 2) || '?'}
                            </div>
                          )}
                          <div>
                            <div className="text-sm font-semibold">{bet.runner?.symbol || 'Unknown'}</div>
                            <div className="text-xs text-muted-foreground">
                              Bet: {formatLargeNumber(bet.amount)} {currency === 'SOL' ? 'SOL' : '$RACE'}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold text-primary">
                            {totals ? calculatePayout(bet.amount, totals.impliedOdds[bet.runnerIdx]) : '0'} {currency === 'SOL' ? 'SOL' : '$RACE'}
                          </div>
                          <div className="text-xs text-muted-foreground">Winnings</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {/* No Winnings */}
                  <div className="text-center py-6 mb-6">
                    <i className="fas fa-sad-tear text-4xl text-muted-foreground mb-4"></i>
                    <h3 className="text-lg font-semibold mb-2">Better Luck Next Time</h3>
                    <p className="text-muted-foreground">
                      Your runner didn't win this race. Try again in the next race!
                    </p>
                  </div>

                  {/* Losing Bets */}
                  <div className="space-y-2">
                    <h4 className="font-semibold mb-2">Your Bets:</h4>
                    {userBets.bets.map((bet) => (
                      <div key={bet.id} className="flex items-center justify-between p-3 bg-muted/10 rounded" data-testid={`losing-bet-${bet.id}`}>
                        <div className="flex items-center gap-3">
                          {bet.runner?.logoURI ? (
                            <img 
                              src={bet.runner.logoURI} 
                              alt={bet.runner.symbol}
                              className="w-6 h-6 rounded-full opacity-50"
                            />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-gradient-to-r from-muted to-muted-foreground flex items-center justify-center text-xs font-bold opacity-50">
                              {bet.runner?.symbol.substring(0, 2) || '?'}
                            </div>
                          )}
                          <div>
                            <div className="text-sm font-semibold opacity-75">{bet.runner?.symbol || 'Unknown'}</div>
                            <div className="text-xs text-muted-foreground">
                              Finished: #{bet.runnerIdx + 1}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-mono text-muted-foreground">
                            {formatLargeNumber(bet.amount)} {currency === 'SOL' ? 'SOL' : '$RACE'}
                          </div>
                          <div className="text-xs text-destructive">Lost</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Final Race Standings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <i className="fas fa-list-ol text-secondary"></i>
              Final Standings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {raceData.runners.map((runner, index) => (
                <div 
                  key={runner.mint}
                  className={`flex items-center justify-between p-3 rounded-lg ${
                    index === raceData.winnerIndex ? 'winner-lane' : 'runner-lane'
                  }`}
                  data-testid={`final-standing-${index}`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                      index === raceData.winnerIndex 
                        ? 'bg-gradient-to-r from-accent to-primary text-white' 
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {index + 1}
                    </div>
                    {runner.logoURI ? (
                      <img 
                        src={runner.logoURI} 
                        alt={runner.symbol}
                        className={`w-8 h-8 rounded-full border ${
                          index === raceData.winnerIndex ? 'border-accent border-2' : 'border-border'
                        }`}
                        onError={(e) => {
                          const target = e.currentTarget as HTMLImageElement;
                          target.style.display = 'none';
                          const nextElement = target.nextElementSibling as HTMLElement;
                          if (nextElement) nextElement.style.display = 'flex';
                        }}
                      />
                    ) : null}
                    <div 
                      className="w-8 h-8 rounded-full bg-gradient-to-r from-primary to-secondary flex items-center justify-center text-xs font-bold"
                      style={{ display: runner.logoURI ? 'none' : 'flex' }}
                    >
                      {runner.symbol.substring(0, 2)}
                    </div>
                    <div>
                      <div className={`text-sm font-semibold ${
                        index === raceData.winnerIndex ? 'text-accent' : 'text-foreground'
                      }`}>
                        {runner.symbol}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {runner.name} • ${formatLargeNumber(runner.marketCap)}
                      </div>
                    </div>
                  </div>
                  
                  <div className="text-right">
                    {index === raceData.winnerIndex && (
                      <Badge variant="secondary" className="bg-accent/20 text-accent border-accent">
                        <i className="fas fa-crown mr-1"></i>
                        WINNER
                      </Badge>
                    )}
                    {totals && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Final odds: {totals.impliedOdds[index]}x
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex justify-center gap-4">
          <Link href="/">
            <Button variant="outline" data-testid="back-to-lobby-results">
              <i className="fas fa-home mr-2"></i>
              Back to Lobby
            </Button>
          </Link>
          
          <Button variant="secondary" onClick={() => window.open(`/api/share/race/${raceId}/win/${publicKey || 'anonymous'}`, '_blank')} data-testid="share-results">
            <i className="fas fa-share mr-2"></i>
            Share Results
          </Button>
        </div>
      </div>
    </div>
  );
}
