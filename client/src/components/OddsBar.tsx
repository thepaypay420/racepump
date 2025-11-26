import { Runner, RaceTotals } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Decimal } from '@/lib/math';

interface OddsBarProps {
  runners: Runner[];
  totals: RaceTotals;
  className?: string;
}

export default function OddsBar({ runners, totals, className = "", ...props }: OddsBarProps) {
  // Calculate percentage distribution of bets
  const totalPot = new Decimal(totals.totalPot);
  const runnerPercentages = totals.runnerTotals.map(total => {
    if (totalPot.eq(0)) return 0;
    return new Decimal(total).div(totalPot).mul(100).toNumber();
  });

  return (
    <div className={`bg-muted/20 rounded-lg p-3 ${className}`} {...props}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-muted-foreground">BET DISTRIBUTION</span>
        <span className="text-xs text-muted-foreground">
          Total: {totals.totalPot} {useStore.getState().currency === 'SOL' ? 'SOL' : '$RACE'}
        </span>
      </div>
      
      <div className="relative h-6 bg-background rounded overflow-hidden">
        {/* Render each runner's portion */}
        {runners.map((runner, index) => {
          const percentage = runnerPercentages[index];
          const leftOffset = runnerPercentages
            .slice(0, index)
            .reduce((sum, p) => sum + p, 0);
          
          if (percentage === 0) return null;
          
          return (
            <div
              key={runner.mint}
              className={`absolute top-0 h-full transition-all duration-300 ${
                index === 0 ? 'bg-gradient-to-r from-primary to-primary/80' :
                index === 1 ? 'bg-gradient-to-r from-secondary to-secondary/80' :
                index === 2 ? 'bg-gradient-to-r from-accent to-accent/80' :
                'bg-gradient-to-r from-muted-foreground to-muted-foreground/80'
              }`}
              style={{
                left: `${leftOffset}%`,
                width: `${percentage}%`,
              }}
              title={`${runner.symbol}: ${percentage.toFixed(1)}% of total bets`}
              data-testid={`odds-bar-segment-${index}`}
            >
              {/* Runner symbol if segment is large enough */}
              {percentage > 8 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xs font-bold text-white drop-shadow-sm">
                    {runner.symbol}
                  </span>
                </div>
              )}
            </div>
          );
        })}
        
        {/* Empty state */}
        {totalPot.eq(0) && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            No bets placed yet
          </div>
        )}
      </div>
      
      {/* Legend */}
      <div className="flex flex-wrap gap-2 mt-2">
        {runners.map((runner, index) => {
          const percentage = runnerPercentages[index];
          if (percentage === 0) return null;
          
          return (
            <div key={runner.mint} className="flex items-center gap-1">
              <div className={`w-3 h-3 rounded ${
                index === 0 ? 'bg-primary' :
                index === 1 ? 'bg-secondary' :
                index === 2 ? 'bg-accent' :
                'bg-muted-foreground'
              }`}></div>
              <span className="text-xs text-muted-foreground" data-testid={`odds-legend-${index}`}>
                {runner.symbol} ({percentage.toFixed(1)}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
