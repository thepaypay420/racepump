import { useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { formatLargeNumber } from '@/lib/math';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export default function WalletBar() {
  const { toast } = useToast();
  const { wallet, setWallet, currency, setCurrency } = useStore();
  
  // Real wallet integration
  const { publicKey, connected, wallet: walletAdapter, connect, disconnect, select } = useWallet();
  
  // Log wallet state for debugging
  useEffect(() => {
    if (connected && publicKey) {
      console.log('✅ Wallet connected:', publicKey.toString().slice(0, 8) + '...');
      // Sound removed per user request
    } else if (!connected) {
      console.log('⚠️ Wallet disconnected');
    }
  }, [connected, publicKey]);

  // Removed auto-select behavior to avoid forcing a specific wallet

  // Fetch wallet balances
  const { data: balances, isLoading: balancesLoading } = useQuery({
    queryKey: ['/api/wallet', publicKey?.toString(), 'balances'],
    queryFn: () => api.getWalletBalances(publicKey!.toString()),
    enabled: !!publicKey && connected,
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Fetch jackpot treasury for display
  const { data: treasury } = useQuery<{ jackpotBalance: string; jackpotBalanceSol?: string }>({
    queryKey: ['/api/treasury'],
    queryFn: api.getTreasury,
    staleTime: 10000,
    refetchInterval: 20000,
  });

  // Remove devnet faucet in mainnet; provide link to Pump.fun board
  const faucetMutation = { isPending: false } as any;

  // Update store when wallet state changes
  useEffect(() => {
    setWallet({
      connected,
      address: publicKey?.toString() || null,
      // Server returns { sol, race }
      raceBalance: (balances as any)?.race || '0',
      solBalance: (balances as any)?.sol || '0'
    });
    // If connecting and URL has ?ref=, persist attribution server-side
    (async () => {
      try {
        const ref = new URLSearchParams(window.location.search).get('ref');
        if (connected && publicKey && ref) {
          // First-click wins is enforced server-side; this will no-op if already referred
          await api.trackReferral(publicKey.toString(), ref, 'connect');
        }
      } catch {}
    })();
  }, [connected, publicKey, balances, setWallet]);
  
  // Play sound when wallet connects/disconnects
  useEffect(() => {
    if (connected && publicKey) {
      // Sound removed per user request
    }
  }, [connected, publicKey]);

  const handleFaucetRequest = () => {
    // Sound removed per user request
    try { window.open('https://pump.fun/coin/t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump', '_blank'); } catch {}
  };

  const handleDisconnect = async () => {
    try {
      await disconnect?.();
    } catch (e) {
      console.warn('Failed to disconnect', e);
    }
  };

  return (
    // Desktop: enforce single-line layout; Mobile handled by md:hidden block below
    <div className="flex items-center gap-2 sm:gap-3 md:gap-4 md:flex-nowrap whitespace-nowrap min-w-0">
      {/* Currency Toggle (desktop) */}
      <div className="hidden md:flex items-center mr-2">
        <div className="relative flex items-center gap-2">
          <div className="flex items-center gap-2 text-xs">
            <i className="fab fa-solana text-blue-400"></i>
            <span className={`font-semibold ${currency === 'SOL' ? 'text-blue-400' : 'text-muted-foreground'}`}>SOL</span>
          </div>
          <button
            aria-label="Toggle currency"
            onClick={() => setCurrency(currency === 'SOL' ? ('RACE' as any) : ('SOL' as any))}
            className={`relative w-16 h-8 rounded-full border transition-colors duration-200 ${currency === 'SOL' ? 'bg-[#0b1226] border-blue-500/40' : 'bg-card border-primary/40'}`}
          >
            <div
              className={`absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full shadow ${currency === 'SOL' ? 'left-1 bg-blue-500' : 'right-1 bg-primary'}`}
            >
              <div className="w-full h-full flex items-center justify-center text-[10px] text-white">
                <i className={`fas ${currency === 'SOL' ? 'fa-bolt' : 'fa-coins'}`}></i>
              </div>
            </div>
          </button>
          <div className="flex items-center gap-2 text-xs">
            <i className="fas fa-coins text-primary"></i>
            <span className={`font-semibold ${currency === 'RACE' ? 'text-primary' : 'text-muted-foreground'}`}>RACE</span>
          </div>
        </div>
      </div>
      {/* Wallet Balances (desktop) */}
      {connected && publicKey && (
        <div className="hidden sm:flex items-center gap-3 text-sm">
          <div className="flex items-center gap-2">
            <i className="fab fa-solana text-secondary"></i>
            {balancesLoading ? (
              <Skeleton className="h-4 w-16" />
            ) : (
              <span className="font-mono" data-testid="sol-balance">
                {formatLargeNumber(wallet.solBalance || '0')} SOL
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            <i className="fas fa-coins text-primary"></i>
            {balancesLoading ? (
              <Skeleton className="h-4 w-20" />
            ) : (
              <span className="font-mono" data-testid="race-balance">
                {formatLargeNumber(wallet.raceBalance || '0')} $RACE
              </span>
            )}
          </div>
          
          {/* Jackpot total */}
          <div className="flex items-center gap-2">
            <i className="fas fa-box-open text-yellow-400"></i>
            {!treasury ? (
              <Skeleton className="h-4 w-20" />
            ) : (
              <span className="font-mono text-yellow-400" data-testid="jackpot-balance">
                {formatLargeNumber((useStore.getState().currency === 'SOL' ? (treasury?.jackpotBalanceSol || '0') : (treasury?.jackpotBalance || '0')))} JACKPOT
              </span>
            )}
          </div>

          <div className="flex gap-2">
            <Button 
              size="sm"
              variant="outline"
              onClick={handleFaucetRequest}
              disabled={faucetMutation.isPending}
              className="text-xs bg-accent/20 text-accent border-accent/30 hover:bg-accent/30"
              data-testid="get-test-race-btn"
            >
              <>
                <img src="/racepump.svg" alt="$RACE" className="w-3.5 h-3.5 mr-1" />
                Get $RACE
              </>
            </Button>
            {/* Quick Referrals entry */}
            <Link href="/referrals">
              <Button 
                size="sm"
                variant="outline"
                className="text-xs bg-primary/10 text-primary border-primary/30 hover:bg-primary/20"
              >
                <i className="fas fa-user-friends mr-1"></i>
                Referrals
              </Button>
            </Link>
            {/* Removed desktop Get SOL button to conserve space */}
          </div>
        </div>
      )}

      {/* Real Wallet Connection (desktop) - compact chip with built-in menu */}
      <div className="hidden md:flex items-center gap-2 wallet-adapter-button-trigger ml-auto sm:ml-0" style={{ position: 'relative', zIndex: 9999 }}>
        <WalletMultiButton
          style={{ position: 'relative', zIndex: 9999 }}
          className="!bg-[var(--input)] !text-foreground hover:!bg-[color-mix(in_oklch,var(--input),white_6%)] !font-semibold !rounded-full !border !border-border !h-9 !pointer-events-auto !text-sm !px-3 !shadow-none !bg-none !whitespace-nowrap shrink-0"
        />
      </div>

      {/* Mobile: single-row compact bar */}
      <div className="w-full md:hidden">
        <div className="flex items-center gap-2 w-full whitespace-nowrap overflow-x-hidden py-1">
          {/* Mobile Swap Button */}
          <div className="flex items-center gap-1 shrink-0 mr-2">
             <Link href="/raceswap">
                <div className="h-7 w-7 rounded-full bg-primary/10 text-primary border border-primary/30 flex items-center justify-center hover:bg-primary/20 cursor-pointer transition-colors">
                   <i className="fas fa-exchange-alt text-xs"></i>
                </div>
             </Link>
          </div>

          {/* Balance chips */}
          <div className="flex items-center gap-1 shrink-0">
            <span className="inline-flex items-center gap-1 bg-muted/30 px-2 h-7 rounded-full text-[11px]">
              {/* Solana logo to the left of SOL balance */}
              <img src="/sol.svg" alt="Solana" className="w-3.5 h-3.5 opacity-90" />
              {balancesLoading ? (
                <span className="inline-block"><Skeleton className="h-3 w-12" /></span>
              ) : (
                <span className="font-mono" data-testid="mobile-sol-balance">{connected ? `${formatLargeNumber(wallet.solBalance || '0')}` : '--'}</span>
              )}
            </span>
            <span className="inline-flex items-center gap-1 bg-muted/30 px-2 h-7 rounded-full text-[11px]">
              <i className="fas fa-coins text-primary" />
              {balancesLoading ? (
                <span className="inline-block"><Skeleton className="h-3 w-14" /></span>
              ) : (
                <span className="font-mono" data-testid="mobile-race-balance">{connected ? `${formatLargeNumber(wallet.raceBalance || '0')}` : '--'}</span>
              )}
            </span>
          </div>

          {/* Wallet connect button (built-in menu), moved to far right and compact label */}
          <div className="ml-auto flex items-center wallet-adapter-button-trigger" style={{ position: 'relative', zIndex: 9999 }}>
            <div className="relative">
              <WalletMultiButton
                style={{ position: 'relative', zIndex: 9999 }}
                className="!h-7 !text-[11px] !px-2 !rounded-full !bg-[var(--input)] !text-transparent !w-[44px] !overflow-hidden !justify-center hover:!bg-[color-mix(in_oklch,var(--input),white_6%)]"
              />
              {/* Overlay custom compact content: wallet icon + last 3 digits */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="flex items-center gap-0.5 text-[11px] leading-none font-mono text-foreground">
                  <i className="fas fa-wallet text-muted-foreground"></i>
                  {connected && publicKey ? (
                    <span>{publicKey.toString().slice(-3)}</span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
