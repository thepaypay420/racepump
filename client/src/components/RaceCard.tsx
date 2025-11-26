import { useState, useEffect, useRef } from 'react';
import { Link } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Race, type ProgressData } from '@/lib/api';
import { getRaceDisplayName } from '@shared/race-name';
import { formatLargeNumber } from '@/lib/math';
import { useStore } from '@/lib/store';
// removed unused pctGain/formatPercent imports
import { getCountdownTargetAndLabel } from '@/helpers/raceTiming';
import Countdown from './Countdown';
import { useQuery } from '@tanstack/react-query';

interface RaceCardProps {
  race: Race;
  variant?: 'upcoming' | 'live' | 'finished';
  // When true, allow betting UI even if maintenance mode is active (for the primary OPEN race)
  allowBetting?: boolean;
}

export default function RaceCard({ race, variant = 'upcoming', allowBetting = false }: RaceCardProps) {
  const { currency } = useStore();
  const [leaderPercent, setLeaderPercent] = useState(0);
  const [currentLeader, setCurrentLeader] = useState<{ symbol: string; logoURI?: string } | null>(null);
  const [, setBaselineByMint] = useState<Record<string, number>>({});
  const baselineRaceIdRef = useRef<string | null>(null);

  // removed unused currentTime tick

  // Handle baseline reset on OPEN → LOCKED transition (run once per race)
  useEffect(() => {
    const status = race.computedStatus ?? race.status;
    if (status === 'LOCKED' && race.runners.some(r => r.initialPriceTs) && baselineRaceIdRef.current !== race.id) {
      // Set baseline map when race transitions to LOCKED with USD price snapshots
      const baseline = Object.fromEntries(
        race.runners.map(r => [r.mint, r.initialPriceUsd || r.initialPrice || 0])
      );
      setBaselineByMint(baseline);
      setLeaderPercent(0); // Force 0% at LOCK
      setCurrentLeader(race.runners[0] || null);
      baselineRaceIdRef.current = race.id;
      console.log('Baseline reset for LOCKED race:', baseline);
    }
  }, [race.status, race.computedStatus, race.runners]);
  
  // Get real-time race progress via react-query (aligned with LiveRace + cache)
  const liveStatus = (race.computedStatus ?? race.status);
  const { data: progressData } = useQuery<ProgressData>({
    queryKey: ['/api/races', race.id, 'progress'],
    enabled: liveStatus === 'LOCKED' || liveStatus === 'IN_PROGRESS',
    refetchInterval: 5000,
    staleTime: 15000,
    gcTime: 120000,
  });

  // Maintenance mode from server (piggyback on treasury endpoint)
  const { data: treasury } = useQuery<{ 
    raceMint?: string; 
    escrowPubkey: string; 
    treasuryPubkey: string; 
    jackpotPubkey: string; 
    maintenanceMode?: boolean; 
    maintenanceMessage?: string;
    memeRewardEnabled?: boolean;
    memeRewardSolAmount?: string;
  }>({
    queryKey: ['/api/treasury'],
    refetchInterval: 15000,
  });

  // Apply progress updates, preserving last good value on gaps/errors
  useEffect(() => {
    if (!progressData?.currentLeader) return;
    const pct = Number(progressData.currentLeader.priceChange ?? 0);
    if (Number.isFinite(pct)) {
      setLeaderPercent(pct);
      setCurrentLeader({
        symbol: progressData.currentLeader.symbol,
        logoURI: progressData.currentLeader.logoURI,
      });
    }
  }, [progressData]);

  // Fallback: derive leader from race.runners if API data temporarily unavailable
  useEffect(() => {
    if (!(liveStatus === 'LOCKED' || liveStatus === 'IN_PROGRESS')) return;
    if (progressData?.currentLeader) return; // prefer API when present
    if (!race.runners || race.runners.length === 0) return;
    const best = race.runners.reduce((best, r) => {
      const pc = Number(r.priceChange ?? -Infinity);
      if (pc > best.val) return { val: pc, sym: r.symbol, logo: r.logoURI };
      return best;
    }, { val: -Infinity as number, sym: (race.runners[0]?.symbol || ''), logo: (race.runners[0]?.logoURI) });
    if (Number.isFinite(best.val) && best.val !== -Infinity) {
      setLeaderPercent(best.val);
      setCurrentLeader({ symbol: best.sym, logoURI: best.logo });
    }
  }, [race.runners, liveStatus, progressData?.currentLeader]);
  const getStatusColor = () => {
    const status = race.computedStatus ?? race.status;
    switch (status) {
      case 'OPEN':
        return 'bg-primary/20 text-primary border-primary/50';
      case 'LOCKED':
      case 'IN_PROGRESS':
        return 'bg-destructive/20 text-destructive border-destructive/50 animate-pulse';
      case 'SETTLED':
        return 'bg-secondary/20 text-secondary border-secondary/50';
      case 'CANCELLED':
        return 'bg-muted/20 text-muted-foreground border-muted/50';
      default:
        return 'bg-muted/20 text-muted-foreground border-muted/50';
    }
  };

  const getActionButton = () => {
    const status = race.computedStatus ?? race.status;
    const maintenance = (treasury as any)?.maintenanceMode;
    const maintenanceMessage = (treasury as any)?.maintenanceMessage as string | undefined;
    switch (status) {
      case 'OPEN':
        if (maintenance && !allowBetting) {
          return (
            <div className="text-center text-xs text-muted-foreground">
              <div className="bg-muted/30 border rounded p-2">
                <div className="font-semibold mb-1">Maintenance</div>
                <div>{maintenanceMessage || 'Server upgrades in progress. Please stand by.'}</div>
              </div>
            </div>
          );
        }
        return (
          <Link href={`/race/${race.id}`}>
            <Button size="sm" className="w-full bg-primary text-primary-foreground hover:bg-primary/90 translate-y-[2px]" data-testid={`place-bets-${race.id}`}>
              <i className="fas fa-dice mr-2"></i>
              Place Bets
            </Button>
          </Link>
        );
      
      case 'LOCKED':
      case 'IN_PROGRESS':
        return (
          <Link href={`/race/${race.id}/live`}>
            <Button size="sm" variant="destructive" className="w-full animate-pulse" data-testid={`watch-live-${race.id}`}>
              <i className="fas fa-eye mr-2"></i>
              Watch Live
            </Button>
          </Link>
        );
      
      case 'SETTLED':
        return (
          <Link href={`/race/${race.id}/results`}>
            <Button size="sm" variant="secondary" className="w-full" data-testid={`view-results-${race.id}`}>
              <i className="fas fa-trophy mr-2"></i>
              View Results
            </Button>
          </Link>
        );
      
      default:
        return (
          <Button size="sm" variant="ghost" className="w-full" disabled>
            <i className="fas fa-ban mr-2"></i>
            Unavailable
          </Button>
        );
    }
  };

  const winner = race.winnerIndex !== undefined ? race.runners[race.winnerIndex] : null;

  return (
    <Card className={`relative transition-all hover:shadow-lg ${
      variant === 'live' ? 'border-destructive/50 bg-destructive/5' :
      variant === 'finished' ? 'border-secondary/50 bg-secondary/5' :
      'border-primary/30 hover:border-primary/50'
    } ${race.jackpotFlag ? 'jackpot-glow' : ''}`}>
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 items-end">
        {treasury?.memeRewardEnabled && (
          <Popover>
            <PopoverTrigger asChild>
              <button className="outline-none focus:outline-none">
                <Badge 
                  variant="outline" 
                  className="bg-orange-500/20 text-orange-500 border-orange-500/50 shadow cursor-pointer hover:bg-orange-500/30 transition-colors"
                  data-testid={`meme-reward-badge-${race.id}`}
                >
                  <i className="fas fa-coins mr-1"></i>
                  Meme Reward
                  <i className="fas fa-question-circle ml-1 text-xs"></i>
                </Badge>
              </button>
            </PopoverTrigger>
            <PopoverContent 
              className="w-[90vw] max-w-sm md:w-80 p-4" 
              side="bottom" 
              align="end"
              sideOffset={5}
            >
              <div className="space-y-2">
                <h4 className="font-semibold text-sm flex items-center gap-2">
                  <i className="fas fa-coins text-orange-500"></i>
                  Meme Reward Race
                </h4>
                <p className="text-xs text-muted-foreground">
                  After this race settles, the winning coin will be purchased with {treasury?.memeRewardSolAmount || '0.1'} SOL using Jupiter Swap.
                </p>
                <p className="text-xs text-muted-foreground">
                  The purchased tokens will be sent to a randomly selected bettor (excluding the house).
                </p>
                <p className="text-xs text-orange-600 dark:text-orange-400 font-medium">
                  Every bettor has a chance to receive the winning coin's tokens!
                </p>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="min-h-[3rem] flex flex-col justify-center">
            <CardTitle className="text-lg flex items-center gap-2">
              <i className="fas fa-flag-checkered text-primary"></i>
              {getRaceDisplayName(race.id)}
            </CardTitle>
            <div className="h-5 flex items-center">
              {race.jackpotFlag && (
                <Badge variant="outline" className="text-accent border-accent/50 bg-accent/10 animate-pulse text-xs">
                  <i className="fas fa-gem mr-1"></i>
                  JACKPOT RACE
                </Badge>
              )}
            </div>
          </div>
          <Badge className={getStatusColor()} data-testid={`race-status-${race.id}`}>
            {race.status === "OPEN" && "OPEN"}
            {race.status === "LOCKED" && "LOCKED"}
            {race.status === "IN_PROGRESS" && "LIVE"}
            {race.status === "SETTLED" && "SETTLED"}
            {race.status === "CANCELLED" && "CANCELLED"}
          </Badge>
        </div>
        
        {(() => {
          const { target, label } = getCountdownTargetAndLabel(race);
          if (target > 0 && label) {
            return (
              <div className="text-right">
                <Countdown 
                  targetTime={target}
                  prefix={label}
                  className="text-sm font-mono text-secondary"
                  data-testid={`race-countdown-${race.id}`}
                />
              </div>
            );
          }
          return null;
        })()}
      </CardHeader>

      {race.jackpotFlag && (
        <div className="sparkle-container" aria-hidden>
          <div className="sparkle s1"></div>
          <div className="sparkle s2"></div>
          <div className="sparkle s3"></div>
          <div className="sparkle s4"></div>
          <div className="sparkle s5"></div>
          <div className="sparkle s6"></div>
        </div>
      )}
      
      <CardContent className="space-y-2">
        {/* Race Stats */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-muted/20 rounded p-1.5">
            <div className="text-sm font-bold text-primary" data-testid={`race-pot-${race.id}`}>
              {currency === 'SOL' ? formatLargeNumber((race as any).totalPotSol || '0') : formatLargeNumber((race as any).totalPotRace || '0')}
            </div>
            <div className="text-xs text-muted-foreground">Pot ({currency === 'SOL' ? 'SOL' : '$RACE'})</div>
          </div>
          <div className="bg-muted/20 rounded p-1.5">
            <div className="text-sm font-bold text-secondary" data-testid={`race-bets-${race.id}`}>
              {currency === 'SOL' ? ((race as any).betCountSol || 0) : ((race as any).betCountRace || 0)}
            </div>
            <div className="text-xs text-muted-foreground">Bets</div>
          </div>
          <div className="bg-muted/20 rounded p-1.5">
            <div className="text-sm font-bold text-accent">
              {race.runners.length}
            </div>
            <div className="text-xs text-muted-foreground">Runners</div>
          </div>
        </div>


        {/* Top Runners Preview or Current Leader */}
        <div className="space-y-1 mt-2">
          {((race.computedStatus ?? race.status) === 'LOCKED' || (race.computedStatus ?? race.status) === 'IN_PROGRESS') ? (
            <>
              <div className="text-xs text-muted-foreground mb-1">Current Leader:</div>
              <div className="bg-gradient-to-r from-accent/20 to-primary/20 border border-accent/50 rounded-lg p-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <div className="w-5 h-5 rounded-full bg-gradient-to-r from-accent to-primary flex items-center justify-center text-[10px] font-bold text-white animate-pulse">
                    <i className="fas fa-crown"></i>
                  </div>
                  {(currentLeader || race.runners[0])?.logoURI ? (
                    <img 
                      src={(currentLeader || race.runners[0])?.logoURI} 
                      alt={(currentLeader || race.runners[0])?.symbol}
                      className="w-4 h-4 rounded-full"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                        const nextElement = (e.currentTarget as HTMLImageElement).nextElementSibling as HTMLElement;
                        if (nextElement) nextElement.style.display = 'flex';
                      }}
                    />
                  ) : null}
                  <div 
                    className="w-4 h-4 rounded-full bg-gradient-to-r from-accent to-primary flex items-center justify-center text-[10px] font-bold"
                    style={{ display: (currentLeader || race.runners[0])?.logoURI ? 'none' : 'flex' }}
                  >
                    {(currentLeader || race.runners[0])?.symbol.substring(0, 2)}
                  </div>
                  <span className="font-semibold text-accent" data-testid={`current-leader-${race.id}`}>
                    {(currentLeader || race.runners[0])?.symbol}
                  </span>
                  {(() => {
                    const value = Number(leaderPercent);
                    const isNegative = value < 0 || Object.is(value, -0);
                    const colorClass = isNegative ? 'text-red-400' : 'text-green-400';
                    const sign = isNegative ? '' : '+';
                    return (
                      <span className={`ml-auto font-mono font-bold ${colorClass}`}>
                        {`${sign}${value.toFixed(1)}%`}
                      </span>
                    );
                  })()}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-muted-foreground mb-1">Featured Runners:</div>
              {race.runners.slice(0, 3).map((runner, index) => (
                <div key={runner.mint} className="flex items-center gap-2 text-xs">
                  <div className={`w-4 h-4 rounded-full bg-gradient-to-r ${
                    index === 0 ? 'from-primary to-secondary' :
                    index === 1 ? 'from-secondary to-accent' :
                    'from-accent to-primary'
                  } flex items-center justify-center text-[10px] font-bold text-white`}>
                    {index + 1}
                  </div>
                  {runner.logoURI ? (
                    <img 
                      src={runner.logoURI} 
                      alt={runner.symbol}
                      className="w-4 h-4 rounded-full"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                        const nextElement = (e.currentTarget as HTMLImageElement).nextElementSibling as HTMLElement;
                        if (nextElement) nextElement.style.display = 'flex';
                      }}
                    />
                  ) : null}
                  <div 
                    className="w-4 h-4 rounded-full bg-gradient-to-r from-muted to-muted-foreground flex items-center justify-center text-[10px] font-bold"
                    style={{ display: runner.logoURI ? 'none' : 'flex' }}
                  >
                    {runner.symbol.substring(0, 2)}
                  </div>
                  <span className="font-semibold" data-testid={`runner-symbol-${race.id}-${index}`}>
                    {runner.symbol}
                  </span>
                  <span className="text-muted-foreground ml-auto">
                    ${formatLargeNumber(runner.marketCap)}
                  </span>
                </div>
              ))}
              {race.runners.length > 3 && (
                <div className="text-xs text-muted-foreground text-center">
                  +{race.runners.length - 3} more runners
                </div>
              )}
            </>
          )}
        </div>

        {/* Winner Display (for finished races) */}
        {winner && (race.computedStatus ?? race.status) === 'SETTLED' && (
          <div className="bg-gradient-to-r from-accent/20 to-primary/20 border border-accent/50 rounded-lg p-2">
            <div className="flex items-center gap-2 justify-center">
              <i className="fas fa-crown text-accent"></i>
              <span className="text-sm font-semibold text-accent" data-testid={`race-winner-${race.id}`}>
                {winner.symbol} WINS!
              </span>
            </div>
          </div>
        )}

        {/* Action Button */}
        {getActionButton()}
      </CardContent>
    </Card>
  );
}
