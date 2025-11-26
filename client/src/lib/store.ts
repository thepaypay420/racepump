import { queryClient } from '@/lib/queryClient';
import React from 'react';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { Race, Runner, RaceTotals, UserBets } from './api';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { api } from './api';

interface WalletState {
  connected: boolean;
  address: string | null;
  solBalance: string;
  raceBalance: string;
}

interface BetSlipState {
  selectedRace: Race | null;
  selectedRunner: Runner | null;
  selectedRunnerIndex: number | null;
  betAmount: string;
  potentialPayout: string;
}

interface RaceState {
  currentRace: Race | null;
  raceTotals: RaceTotals | null;
  userBets: UserBets | null;
  liveRaceActive: boolean;
  winnerIndex: number | null;
  status?: string;
}

interface AdminState {
  authenticated: boolean;
  token: string;
  showLoginModal: boolean;
}

interface SSEState {
  connected: boolean;
  lastUpdate: number;
  notified: Record<string, true>; // raceId -> notified flag to dedupe
}

type BetCurrency = 'SOL' | 'RACE';

interface AppStore {
  // Wallet state
  wallet: WalletState;
  setWallet: (wallet: Partial<WalletState>) => void;
  
  // Bet slip state
  betSlip: BetSlipState;
  setBetSlip: (betSlip: Partial<BetSlipState>) => void;
  clearBetSlip: () => void;
  selectRunner: (race: Race, runner: Runner, index: number) => void;
  
  // Race state
  race: RaceState;
  setRace: (race: Partial<RaceState>) => void;
  updateRaceTotals: (totals: RaceTotals) => void;
  updateRaceRunners: (runners: Runner[]) => void;
  
  // Admin state
  admin: AdminState;
  setAdmin: (admin: Partial<AdminState>) => void;
  
  // SSE state
  sse: SSEState;
  setSSE: (sse: Partial<SSEState>) => void;
  
  // UI state
  showResultsModal: boolean;
  setShowResultsModal: (show: boolean) => void;
  // Currency selection
  currency: BetCurrency;
  setCurrency: (c: BetCurrency) => void;
  
  // Toast notifications
  showToast: (title: string, message: string, type?: 'success' | 'error' | 'info') => void;
}

export const useStore = create<AppStore>()(
  subscribeWithSelector((set, get) => ({
    // Initial wallet state
    wallet: {
      connected: false,
      address: null,
      solBalance: '0',
      raceBalance: '0',
    },
    setWallet: (wallet) => set((state) => ({ 
      wallet: { ...state.wallet, ...wallet } 
    })),

    // Initial bet slip state
    betSlip: {
      selectedRace: null,
      selectedRunner: null,
      selectedRunnerIndex: null,
      betAmount: '',
      potentialPayout: '0',
    },
    setBetSlip: (betSlip) => set((state) => ({ 
      betSlip: { ...state.betSlip, ...betSlip } 
    })),
    clearBetSlip: () => set((state) => ({
      betSlip: {
        ...state.betSlip,
        selectedRunner: null,
        selectedRunnerIndex: null,
        betAmount: '',
        potentialPayout: '0',
      }
    })),
    selectRunner: (race, runner, index) => set((state) => ({
      betSlip: {
        ...state.betSlip,
        selectedRace: race,
        selectedRunner: runner,
        selectedRunnerIndex: index,
      }
    })),

    // Initial race state
    race: {
      currentRace: null,
      raceTotals: null,
      userBets: null,
      liveRaceActive: false,
      winnerIndex: null,
    },
    setRace: (race) => set((state) => ({ 
      race: { ...state.race, ...race } 
    })),
    updateRaceTotals: (totals) => set((state) => ({
      race: { ...state.race, raceTotals: totals }
    })),
    updateRaceRunners: (runners) => set((state) => ({
      race: {
        ...state.race,
        currentRace: state.race.currentRace ? {
          ...state.race.currentRace,
          runners: runners
        } : null
      }
    })),

    // Initial admin state
    admin: {
      authenticated: false,
      token: '',
      showLoginModal: false,
    },
    setAdmin: (admin) => set((state) => ({ 
      admin: { ...state.admin, ...admin } 
    })),

    // Initial SSE state
    sse: {
      connected: false,
      lastUpdate: 0,
      notified: {},
    },
    setSSE: (sse) => set((state) => ({ 
      sse: { ...state.sse, ...sse } 
    })),

    // UI state
    showResultsModal: false,
    setShowResultsModal: (show) => set({ showResultsModal: show }),
    // Currency selection (default SOL)
    currency: 'SOL',
    setCurrency: (c) => set({ currency: c }),

    // Toast function with audio feedback
    showToast: (title, message, type = 'success') => {
      // Sound removed per user request
      if (type === 'error') {
        // playSound('notification', 0.5);
      }
      try {
        toast({
          title,
          description: message,
          // Map to toast variant styles
          variant: type === 'error' ? 'destructive' : type === 'success' ? 'success' : 'default',
        } as any);
      } catch {}
      // Log for development
      console.log(`Toast [${type}]: ${title} - ${message}`);
    },
  }))
);

// Derived selectors
export const useWalletConnected = () => useStore((state) => state.wallet.connected);
export const useSelectedRunner = () => useStore((state) => state.betSlip.selectedRunner);
export const useCurrentRace = () => useStore((state) => state.race.currentRace);
export const useRaceTotals = () => useStore((state) => state.race.raceTotals);
export const useAdminAuth = () => useStore((state) => state.admin.authenticated);

// Actions for SSE handling
export const handleSSEMessage = async (data: any) => {
  try {
    const { setRace, setSSE, showToast } = useStore.getState();
    
    setSSE({ lastUpdate: Date.now() });
    
    switch (data.type) {
      case 'connected':
        setSSE({ connected: true });
        break;
        
      case 'race_created':
        showToast('New Race Created', `Race will start soon`, 'info');
        try {
          await queryClient.invalidateQueries({ queryKey: ['races'] });
          if (data?.data?.id) {
            await queryClient.invalidateQueries({ queryKey: ['race', data.data.id] });
          }
        } catch (e) {
          console.warn('Invalidate queries failed (race_created)', e);
        }
        break;
        
      case 'race_locked':
        setRace({ liveRaceActive: true });
        showToast('Race Started', 'The race is now live!', 'info');
        try {
          await queryClient.invalidateQueries({ queryKey: ['races'] });
          if (data?.data?.id) {
            await queryClient.invalidateQueries({ queryKey: ['race', data.data.id] });
          }
        } catch (e) {
          console.warn('Invalidate queries failed (race_locked)', e);
        }
        break;

      case 'race_live':
        // server signals race moved into IN_PROGRESS
        setRace({ liveRaceActive: true });
        showToast('Race Live', 'Price tracking started', 'info');
        try {
          await queryClient.invalidateQueries({ queryKey: ['races'] });
          if (data?.data?.id) {
            await queryClient.invalidateQueries({ queryKey: ['race', data.data.id] });
          }
        } catch (e) {
          console.warn('Invalidate queries failed (race_live)', e);
        }
        break;
        
      case 'race_settled':
        const race = data?.data;
        if (race && race.id) {
          setRace({ 
            winnerIndex: race.winnerIndex,
            liveRaceActive: false,
            status: 'SETTLED'
          });
          if (race.winnerIndex !== undefined && race.runners && race.runners[race.winnerIndex]) {
            const winner = race.runners[race.winnerIndex];
            // Winner popup + balance refresh
            showToast('Race Complete', `${winner.symbol} wins!`, 'success');
            try {
              const state = useStore.getState();
              const address = state.wallet.address;
              if (address) {
                fetch(`/api/wallet/${address}/balances`)
                  .then(r => r.json())
                  .then(bal => {
                    const prev = Number(state.wallet.raceBalance || '0');
                    const next = Number(bal.race || bal.raceBalance || '0');
                    const delta = next - prev;
                    useStore.getState().setWallet({
                      solBalance: bal.sol || bal.solBalance || state.wallet.solBalance,
                      raceBalance: (bal.race || bal.raceBalance || next.toString())
                    });
                    // Fallback: if no SSE payout_executed/user_loss arrives soon, fetch result and notify
                    const already = useStore.getState().sse.notified[race.id];
                    if (!already) {
                      setTimeout(async () => {
                        try {
                          const nowState = useStore.getState();
                          if (nowState.sse.notified[race.id]) return;
                          const result = await api.getRaceResult(race.id, address, (window as any).__APP_CURRENCY__ || 'RACE');
                          if (result.participated) {
                            const explorer = result.txSig ? `https://solscan.io/tx/${result.txSig}` : undefined;
                            if (result.win && result.payoutAmount) {
                              try { playSound('bet_placed', 1.0); } catch {}
                              toast({
                                title: 'You won! 🏆',
                                description: `+${Number(result.payoutAmount).toFixed(4)} ${(window as any).__APP_CURRENCY__ === 'SOL' ? 'SOL' : '$RACE'}`,
                                variant: 'success' as any,
                                action: explorer ? (
                                  React.createElement(ToastAction, {
                                    altText: 'View on Explorer',
                                    onClick: () => { try { window.open(explorer!, '_blank'); } catch {} }
                                  }, 'View Tx')
                                ) : undefined,
                              } as any);
                            } else if (!result.win && result.lostAmount) {
                              toast({
                                title: 'Better luck next time',
                                description: `-${Number(result.lostAmount).toFixed(4)} ${(window as any).__APP_CURRENCY__ === 'SOL' ? 'SOL' : '$RACE'}`,
                                variant: 'destructive' as any,
                              } as any);
                            }
                            // Mark notified to avoid duplicates
                            useStore.getState().setSSE({ notified: { ...useStore.getState().sse.notified, [race.id]: true } });
                          }
                        } catch {}
                      }, 2000);
                    }
                  })
                  .catch(() => {});
              }
            } catch {}
          }
        }
        try {
          await queryClient.invalidateQueries({ queryKey: ['races'] });
          if (data?.data?.id) {
            await queryClient.invalidateQueries({ queryKey: ['race', data.data.id] });
          }
        } catch (e) {
          console.warn('Invalidate queries failed (race_settled)', e);
        }
        break;

      case 'payout_executed': {
        const payload = data?.data;
        const state = useStore.getState();
        const myWallet = state.wallet.address;
        if (payload?.wallet && myWallet && payload.wallet === myWallet) {
          const amount = Number(payload.payoutAmount || '0');
          // Play cash register on win
          try { playSound('bet_placed', 1.0); } catch {}
          const txSig: string | undefined = payload.txSig;
          const explorer = txSig ? `https://solscan.io/tx/${txSig}` : undefined;
          toast({
            title: 'You won! 🏆',
            description: `+${amount.toFixed(4)} ${payload?.currency === 'SOL' ? 'SOL' : '$RACE'}`,
            variant: 'success' as any,
            action: explorer ? (
              React.createElement(ToastAction, {
                altText: 'View on Explorer',
                onClick: () => { try { window.open(explorer, '_blank'); } catch {} }
              }, 'View Tx')
            ) : undefined,
          } as any);
          // Mark notified for this race to avoid fallback duplicate
          if (payload?.raceId) {
            useStore.getState().setSSE({ notified: { ...useStore.getState().sse.notified, [payload.raceId]: true } });
          }
        }
        break;
      }

      case 'user_loss': {
        const payload = data?.data;
        const state = useStore.getState();
        const myWallet = state.wallet.address;
        if (payload?.wallet && myWallet && payload.wallet === myWallet) {
          const amount = Number(payload.lostAmount || '0');
          toast({
            title: 'Better luck next time',
            description: `-${amount.toFixed(4)} ${payload?.currency === 'SOL' ? 'SOL' : '$RACE'}`,
            variant: 'destructive' as any,
          } as any);
          if (payload?.raceId) {
            useStore.getState().setSSE({ notified: { ...useStore.getState().sse.notified, [payload.raceId]: true } });
          }
        }
        break;
      }
        
      case 'race_cancelled':
        showToast('Race Cancelled', 'All bets have been refunded', 'info');
        break;
        
      case 'bet_placed':
        // Update totals if available
        if (data?.data?.totals) {
          useStore.getState().updateRaceTotals(data.data.totals);
        }
        break;
        
      case 'race_updated':
        // periodic price updates during OPEN/LOCKED/IN_PROGRESS
        if (data?.data?.raceId && data?.data?.runners) {
          const { race, updateRaceRunners } = useStore.getState();
          // Only update if this is the current race being viewed
          if (race.currentRace?.id === data.data.raceId) {
            updateRaceRunners(data.data.runners);
            console.log('📊 Race prices updated via SSE:', data.data.raceId);
          }
        }
        try {
          await queryClient.invalidateQueries({ queryKey: ['races'] });
          if (data?.data?.raceId) {
            await queryClient.invalidateQueries({ queryKey: ['race', data.data.raceId] });
          }
        } catch (e) {
          console.warn('Invalidate queries failed (race_updated)', e);
        }
        break;
        
      case 'ping':
        // Server keepalive ping - no action needed
        break;
        
      default:
        // Only log truly unknown message types to reduce noise
        if (data.type !== 'ping') {
          console.log('Unknown SSE message type:', data.type);
        }
        break;
    }
  } catch (error) {
    console.error('Error handling SSE message:', error, data);
    // Don't rethrow to prevent unhandled promise rejections
  }
};
