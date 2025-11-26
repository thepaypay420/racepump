import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Race, RaceTotals, api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { formatLargeNumber, calculatePayout } from '@/lib/math';
import { useQueries } from '@tanstack/react-query';

interface RunnerGridProps {
  race: Race;
  totals?: RaceTotals;
  isLoading?: boolean;
  canBet?: boolean;
  className?: string;
}

export default function RunnerGrid({ 
  race, 
  totals, 
  isLoading = false, 
  canBet = false,
  className = "",
  ...props 
}: RunnerGridProps) {
  const { betSlip, selectRunner } = useStore();

  // Fetch live token stats for all runners so Market Cap stays fresh
  const tokenStatsQueries = useQueries({
    queries: (race?.runners || []).map((runner) => ({
      queryKey: ['/api/token-stats', runner.mint],
      enabled: Boolean(runner.mint),
      queryFn: async () => api.getTokenStats(runner.mint, (runner as any).poolAddress),
      refetchInterval: 45000,
      staleTime: 30000,
    })),
  });

  const handleSelectRunner = (runner: any, index: number) => {
    if (!canBet) return;
    selectRunner(race, runner, index);
  };

  if (isLoading) {
    return (
      <div className={`racing-track rounded-lg p-4 min-h-[400px] ${className}`} {...props}>
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="runner-lane h-12 rounded flex items-center px-4">
              <Skeleton className="w-8 h-8 rounded-full mr-3" />
              <Skeleton className="w-8 h-8 rounded-full mr-3" />
              <div className="flex-1">
                <Skeleton className="h-4 w-16 mb-1" />
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="text-right">
                <Skeleton className="h-4 w-12 mb-1" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`racing-track rounded-lg p-4 min-h-[400px] relative overflow-hidden ${className}`} {...props}>
      <div className="absolute top-2 left-4 text-xs text-primary font-semibold">START</div>
      <div className="absolute top-2 right-4 text-xs text-accent font-semibold">FINISH</div>
      
      <div className="space-y-2 mt-6">
        {race.runners.map((runner, index) => {
          const isSelected = betSlip.selectedRunnerIndex === index;
          const runnerTotal = totals?.runnerTotals[index] || '0';
          const impliedOdds = totals?.impliedOdds[index] || '∞';
          const isWinner = race.winnerIndex === index;
          
          return (
            <div
              key={runner.mint}
              className={`relative h-12 mb-2 rounded flex items-center cursor-pointer transition-all ${
                isWinner ? 'winner-lane animate-winner-glow' :
                isSelected ? 'runner-lane border border-accent/50 bg-accent/10' :
                'runner-lane hover:bg-muted/20'
              } ${canBet ? 'hover:border-accent/30' : ''}`}
              onClick={() => handleSelectRunner(runner, index)}
              data-testid={`runner-${index}`}
            >
              <div className="absolute left-2 flex items-center gap-2 z-10">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                  isWinner ? 'bg-gradient-to-r from-accent to-primary animate-pulse' :
                  isSelected ? 'bg-gradient-to-r from-accent to-primary' :
                  index === 0 ? 'bg-gradient-to-r from-primary to-secondary' :
                  index === 1 ? 'bg-gradient-to-r from-secondary to-accent' :
                  'bg-gradient-to-r from-muted to-secondary'
                }`}>
                  {index + 1}
                </div>
                
                {runner.logoURI ? (
                  <img 
                    src={runner.logoURI} 
                    alt={runner.symbol}
                    className={`w-8 h-8 rounded-full border ${
                      isWinner ? 'border-accent border-2 pulse-glow' :
                      isSelected ? 'border-accent' :
                      'border-primary/30'
                    }`}
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                      e.currentTarget.nextElementSibling!.style.display = 'flex';
                    }}
                    data-testid={`runner-logo-${index}`}
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
                    isWinner ? 'text-accent animate-winner-glow' :
                    isSelected ? 'text-accent' :
                    'text-foreground'
                  }`} data-testid={`runner-symbol-${index}`}>
                    {runner.symbol}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono" data-testid={`runner-marketcap-${index}`}>
                    {(() => {
                      const live = tokenStatsQueries[index]?.data?.fdvUsd as number | undefined;
                      const mc = live ?? (runner as any).marketCap ?? 0;
                      return `$${formatLargeNumber(mc)}`;
                    })()}
                  </div>
                </div>
              </div>
              
              <div className="absolute right-4 text-right">
                <div className={`text-sm font-bold ${
                  isWinner ? 'text-accent animate-pulse' :
                  isSelected ? 'text-accent' :
                  parseFloat(impliedOdds) > 10 ? 'text-muted-foreground' :
                  parseFloat(impliedOdds) > 5 ? 'text-secondary' :
                  'text-primary'
                }`} data-testid={`runner-odds-${index}`}>
                  {impliedOdds}x
                </div>
                <div className="text-xs text-muted-foreground" data-testid={`runner-total-${index}`}>
                  {formatLargeNumber(runnerTotal)} {useStore.getState().currency === 'SOL' ? 'SOL' : '$RACE'}
                </div>
              </div>
              
              {/* Selection indicator */}
              {isSelected && (
                <div className="absolute inset-0 bg-accent/5 rounded animate-neon-pulse"></div>
              )}
              
              {/* Winner effect */}
              {isWinner && (
                <div className="absolute inset-0 bg-accent/5 rounded animate-neon-pulse"></div>
              )}
            </div>
          );
        })}
      </div>
      
      {/* Click to select hint */}
      {canBet && !betSlip.selectedRunner && (
        <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded">
          <i className="fas fa-mouse-pointer mr-1"></i>
          Click a runner to place a bet
        </div>
      )}
    </div>
  );
}
