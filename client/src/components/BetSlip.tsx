import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStore } from '@/lib/store';
// Removed wallet adapter import for browser compatibility
import { formatLargeNumber, calculatePayout, validateAmount, Decimal } from '@/lib/math';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface BetSlipProps {
  canBet?: boolean;
  onPlaceBet?: () => void;
  isPlacing?: boolean;
  className?: string;
}

export default function BetSlip({ 
  canBet = false, 
  onPlaceBet, 
  isPlacing = false,
  className = "",
  ...props 
}: BetSlipProps) {
  const { betSlip, setBetSlip, race, wallet, currency } = useStore();
  const connected = wallet.connected; // Use actual wallet connection state
  
  // Get the latest runner data from current race (updates with 30-second API refresh)
  const selectedRunner = betSlip.selectedRunnerIndex !== null && race.currentRace?.runners
    ? race.currentRace.runners[betSlip.selectedRunnerIndex] 
    : betSlip.selectedRunner;
  
  // Remove debug logging
  
  const [betAmount, setBetAmount] = useState('');
  const [potentialPayout, setPotentialPayout] = useState('0');

  // Periodically fetch token stats (price, 1h change, 24h volume, FDV) for selected runner
  const { data: tokenStats } = useQuery({
    queryKey: ['/api/token-stats', (selectedRunner as any)?.mint],
    enabled: Boolean((selectedRunner as any)?.mint),
    queryFn: async () => api.getTokenStats((selectedRunner as any).mint, (selectedRunner as any).poolAddress),
    refetchInterval: 45000,
    staleTime: 30000,
  });

  // Update bet amount in store when local state changes
  useEffect(() => {
    setBetSlip({ betAmount });
  }, [betAmount, setBetSlip]);

  // Calculate potential payout when amount or odds change
  useEffect(() => {
    const hasSelection = betSlip.selectedRunnerIndex !== null && race.raceTotals;
    const odds = hasSelection ? race.raceTotals!.impliedOdds[betSlip.selectedRunnerIndex!] : undefined;
    const isValidNumber = betAmount !== '' && betAmount !== '.' && Number.isFinite(Number(betAmount)) && Number(betAmount) > 0;
    if (hasSelection && isValidNumber) {
      const payout = calculatePayout(betAmount, odds!);
      setPotentialPayout(payout);
      setBetSlip({ potentialPayout: payout });
    } else {
      setPotentialPayout('0');
      setBetSlip({ potentialPayout: '0' });
    }
  }, [betAmount, betSlip.selectedRunnerIndex, race.raceTotals, setBetSlip]);

  const handleAmountChange = (value: string) => {
    // Allow only numbers and decimal point
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setBetAmount(value);
    }
  };

  const setQuickAmount = (amount: string) => {
    setBetAmount(amount);
  };

  const setMaxAmount = () => {
    try {
      const have = new Decimal(currency === 'SOL' ? (wallet.solBalance || '0') : (wallet.raceBalance || '0'));
      // Use 4 decimals for SOL, integer for RACE
      const decimals = currency === 'SOL' ? 4 : 0;
      setBetAmount(have.toFixed(decimals));
    } catch {
      setBetAmount('0');
    }
  };

  const validation = validateAmount(betAmount, '1000000', '0'); // Allow up to 1M units for testing
  const exceedsBalance = (() => {
    try {
      const have = new Decimal(currency === 'SOL' ? (wallet.solBalance || '0') : (wallet.raceBalance || '0'));
      const want = new Decimal(betAmount || '0');
      return want.gt(have);
    } catch { return false; }
  })();

  const RACE_DISABLED = !(((import.meta as any).env?.VITE_ENABLE_RACE_BETS || '').toString() === '1' || ((import.meta as any).env?.VITE_ENABLE_RACE_BETS || '').toString().toLowerCase() === 'true');
  const canSubmitBet = canBet && 
                       connected && 
                       betSlip.selectedRunner && 
                       betAmount && 
                       parseFloat(betAmount) > 0 && 
                       validation.valid &&
                       !exceedsBalance &&
                       !(RACE_DISABLED && currency === 'RACE');

  if (!betSlip.selectedRunner) {
    return (
      <Card className={`bet-slip-glow ${className}`} {...props}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <i className="fas fa-dice text-primary"></i>
            Place Your Bet
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <i className="fas fa-mouse-pointer text-4xl text-muted-foreground mb-4"></i>
            <h3 className="text-lg font-semibold mb-2">Select a Runner</h3>
            <p className="text-muted-foreground text-sm">
              Choose a runner from the race track to place your bet
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={`bet-slip-glow ${className}`} {...props}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <i className="fas fa-dice text-primary"></i>
          Place Your Bet
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Selected Runner - Enhanced Token Info */}
        <div className="p-4 bg-accent/10 border border-accent/30 rounded space-y-3">
          {/* Header with token info */}
          <div className="flex items-center gap-3">
            {selectedRunner.logoURI ? (
              <img 
                src={selectedRunner.logoURI} 
                alt={selectedRunner.symbol}
                className="w-10 h-10 rounded-full border border-accent"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                  (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                }}
                data-testid="selected-runner-logo"
              />
            ) : null}
            <div 
              className="w-10 h-10 rounded-full bg-gradient-to-r from-accent to-primary flex items-center justify-center text-sm font-bold"
              style={{ display: selectedRunner.logoURI ? 'none' : 'flex' }}
            >
              {selectedRunner.symbol.substring(0, 2)}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <div className="font-semibold text-accent text-lg" data-testid="selected-runner-symbol">
                  {selectedRunner.symbol}
                </div>
                <div className="text-xs text-accent/70">#{betSlip.selectedRunnerIndex! + 1}</div>
              </div>
              <div className="text-sm text-muted-foreground" data-testid="selected-runner-name">
                {selectedRunner.name}
              </div>
            </div>
          </div>

          {/* Market Data Grid */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            {/* Market Cap */}
            <div className="bg-muted/20 p-2 rounded">
              <div className="text-muted-foreground">Market Cap</div>
              <div className="font-semibold text-foreground">
                ${(() => {
                  const mc = tokenStats?.fdvUsd ?? (selectedRunner.marketCap || 0);
                  return Number(mc || 0).toLocaleString();
                })()}
              </div>
            </div>
            
            {/* 24h Volume */}
            <div className="bg-muted/20 p-2 rounded">
              <div className="text-muted-foreground">24h Volume</div>
              <div className="font-semibold text-foreground">
                ${(() => {
                  const vol = tokenStats?.volumeUsd24h ?? (selectedRunner.volume24h || 0);
                  return Number(vol || 0).toLocaleString();
                })()}
              </div>
            </div>
            
            {/* Price Change (1h from GeckoTerminal for display only) */}
            <div className="bg-muted/20 p-2 rounded">
              <div className="text-muted-foreground">1h Change</div>
              <div className={`font-semibold ${
                ((tokenStats?.priceChangeH1Pct ?? (selectedRunner.priceChangeH1 ?? selectedRunner.priceChange ?? 0)) >= 0) ? 'text-green-400' : 'text-red-400'
              }`}>
                {(() => {
                  const v = Number(tokenStats?.priceChangeH1Pct ?? (selectedRunner.priceChangeH1 ?? selectedRunner.priceChange ?? 0));
                  const sign = v >= 0 ? '+' : '';
                  return `${sign}${v.toFixed(1)}%`;
                })()}
              </div>
            </div>
            
            {/* Current Price */}
            <div className="bg-muted/20 p-2 rounded">
              <div className="text-muted-foreground">Current Price</div>
              <div className="font-semibold text-foreground font-mono">
                {(() => {
                  const p = Number(tokenStats?.currentPriceUsd ?? (selectedRunner.currentPrice || selectedRunner.initialPrice || 0));
                  return `$${p.toFixed(6)}`;
                })()}
              </div>
            </div>
          </div>

          {/* Token Age */}
          {selectedRunner.createdAt && (
            <div className="bg-muted/20 p-2 rounded">
              <div className="text-muted-foreground text-xs">Token Age</div>
              <div className="font-semibold text-foreground text-sm">
                {(() => {
                  const ageMs = Date.now() - selectedRunner.createdAt!;
                  const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
                  const ageDays = Math.floor(ageHours / 24);
                  if (ageDays > 0) return `${ageDays}d ${ageHours % 24}h`;
                  return `${ageHours}h`;
                })()}
              </div>
            </div>
          )}

          {/* External Links */}
          <div className="flex gap-2">
            {selectedRunner.geckoTerminalUrl && (
              <a
                href={selectedRunner.geckoTerminalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 bg-primary/20 hover:bg-primary/30 text-primary text-xs py-2 px-3 rounded transition-colors text-center"
                data-testid="gecko-terminal-link"
              >
                <i className="fas fa-chart-line mr-1"></i>
                GeckoTerminal
              </a>
            )}
            <a
              href={`https://dexscreener.com/solana/${selectedRunner.mint}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 bg-secondary/20 hover:bg-secondary/30 text-secondary text-xs py-2 px-3 rounded transition-colors text-center"
              data-testid="dexscreener-link"
            >
              <i className="fas fa-external-link-alt mr-1"></i>
              DexScreener
            </a>
          </div>

          {/* Betting Odds */}
          <div className="bg-accent/20 p-3 rounded text-center">
            <div className="text-accent text-sm font-medium">Current Betting Odds</div>
            <div className="text-accent text-xl font-bold" data-testid="selected-runner-odds">
              {race.raceTotals?.impliedOdds[betSlip.selectedRunnerIndex!] || '∞'}x
            </div>
            <div className="text-accent/70 text-xs">payout per 1 {currency === 'SOL' ? 'SOL' : '$RACE'}</div>
          </div>
        </div>

        {/* Bet Amount Input */}
        <div>
          <Label htmlFor="bet-amount">Bet Amount</Label>
          <div className="relative">
            <Input
              id="bet-amount"
              type="text"
              placeholder="0.00"
              value={betAmount}
              onChange={(e) => handleAmountChange(e.target.value)}
              className="text-lg font-mono pr-16 focus:border-primary focus:ring-primary"
              disabled={!canBet}
              data-testid="bet-amount-input"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              {currency === 'SOL' ? 'SOL' : '$RACE'}
            </div>
          </div>
          
          {/* Validation Error */}
          {betAmount && (
            !validation.valid ? (
              <div className="text-xs text-destructive mt-1" data-testid="bet-amount-error">
                {validation.error}
              </div>
            ) : exceedsBalance ? (
              <div className="text-xs text-destructive mt-1" data-testid="bet-amount-error">
                Amount exceeds available {currency === 'SOL' ? 'SOL' : '$RACE'} balance
              </div>
            ) : null
          )}
          
          {/* Quick Bet Amounts */}
          <div className="grid grid-cols-4 gap-2 mt-2">
            {currency === 'SOL' ? (
              <>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setQuickAmount('0.05')}
                  className="bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                  disabled={!canBet}
                >
                  0.05
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setQuickAmount('0.1')}
                  className="bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                  disabled={!canBet}
                >
                  0.1
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setQuickAmount('0.25')}
                  className="bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                  disabled={!canBet}
                >
                  0.25
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={setMaxAmount}
                  className="bg-primary/20 hover:bg-primary/30 text-primary hover:text-primary"
                  disabled={!canBet}
                  data-testid="quick-bet-max"
                >
                  MAX
                </Button>
              </>
            ) : (
              <>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setQuickAmount('100')}
                  className="bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                  disabled={!canBet}
                  data-testid="quick-bet-100"
                >
                  100
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setQuickAmount('500')}
                  className="bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                  disabled={!canBet}
                  data-testid="quick-bet-500"
                >
                  500
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setQuickAmount('1000')}
                  className="bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                  disabled={!canBet}
                  data-testid="quick-bet-1000"
                >
                  1K
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={setMaxAmount}
                  className="bg-primary/20 hover:bg-primary/30 text-primary hover:text-primary"
                  disabled={!canBet}
                  data-testid="quick-bet-max"
                >
                  MAX
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Available Balance */}
        {connected && (
          <div className="text-xs text-muted-foreground">
            Available: <span className="font-mono" data-testid="available-balance">
              {currency === 'SOL' ? `${formatLargeNumber(wallet.solBalance || '0')} SOL` : `${formatLargeNumber(wallet.raceBalance || '0')} $RACE`}
            </span>
          </div>
        )}

        {/* Potential Payout */}
        <div className="p-3 bg-primary/10 border border-primary/30 rounded">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Potential Payout:</span>
            <span className="text-lg font-bold text-primary font-mono" data-testid="potential-payout">
              {formatLargeNumber(potentialPayout)} {currency === 'SOL' ? 'SOL' : '$RACE'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Odds may change before race starts
          </div>
        </div>

        {/* RACE Coming Soon notice */}
        {currency === 'RACE' && RACE_DISABLED && (
          <div className="p-3 bg-emerald-900/30 border border-emerald-700/40 rounded text-emerald-300 text-xs">
            $RACE betting is coming soon. SOL betting is live on mainnet now.
          </div>
        )}

        {/* Place Bet Button */}
        <Button 
          onClick={onPlaceBet}
          disabled={!canSubmitBet || isPlacing}
          className="w-full bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors neon-glow btn-glow"
          data-testid="place-bet-btn"
        >
          {isPlacing ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
              Placing Bet...
            </>
          ) : !connected ? (
            <>
              <i className="fas fa-wallet mr-2"></i>
              Connect Wallet to Bet
            </>
          ) : !canBet ? (
            <>
              <i className="fas fa-lock mr-2"></i>
              Betting Closed
            </>
          ) : (
            <>
              <i className="fas fa-rocket mr-2"></i>
              Place Bet
            </>
          )}
        </Button>

        <div className="text-xs text-muted-foreground text-center">
          {currency === 'SOL' 
            ? '5% rake (SOL): 2% jackpot, 3% protocol' 
            : '3% rake (RACE): 1% jackpot, 2% protocol'}
        </div>
      </CardContent>
    </Card>
  );
}
