/// <reference path="../../types/window.d.ts" />
import { useEffect, useRef, useState } from 'react';
import { PublicKey, Transaction, TransactionInstruction as Web3TransactionInstruction, Connection, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { createTransferCheckedInstructionManual } from '@/lib/spl';
import { useParams, useLocation, Link } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { playSound } from '@/lib/audio';
import { api, PlaceBetRequest, RaceTotals, Race } from '@/lib/api';
import { useStore } from '@/lib/store';
import { formatLargeNumber, calculatePayout, Decimal } from '@/lib/math';
import RunnerGrid from '@/components/RunnerGrid';
import BetSlip from '@/components/BetSlip';
import Countdown from '@/components/Countdown';
import OddsBar from '@/components/OddsBar';
import { getCountdownTargetAndLabel } from '@/helpers/raceTiming';
import { getRaceDisplayName } from '@shared/race-name';
import bs58 from 'bs58';

export default function RaceDetail() {
  const { raceId } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { 
    race, 
    setRace, 
    betSlip, 
    wallet,
    showToast,
    currency
  } = useStore();
  const [isBetting, setIsBetting] = useState(false);
  const betTimerRef = useRef<number | null>(null);

  // Cleanup any pending timers on unmount
  useEffect(() => {
    return () => {
      if (betTimerRef.current) {
        clearTimeout(betTimerRef.current);
        betTimerRef.current = null;
      }
    };
  }, []);
  
  // Use wallet connection state from global store instead of wallet adapter
  const connected = wallet.connected;

  // Fetch race data
  const { data: raceData, isLoading: raceLoading, error: raceError } = useQuery({
    queryKey: ['/api/races', raceId],
    enabled: !!raceId,
    refetchInterval: 5000,
  });

  // Fetch race totals
  const { data: totals, isLoading: totalsLoading } = useQuery({
    queryKey: ['/api/races', raceId, 'totals', currency],
    enabled: !!raceId,
    refetchInterval: 3000,
    queryFn: async () => {
      const response = await fetch(`/api/races/${raceId}/totals?currency=${currency}`);
      return response.json();
    }
  });

  // Fetch user bets
  const { data: userBets, isLoading: userBetsLoading } = useQuery({
    queryKey: ['/api/races', raceId, 'bets', currency],
    queryFn: async () => {
      if (!wallet.address || !raceId || !connected) return null;
      // Request only the bets for the active currency tab
      const url = new URL(`/api/races/${raceId}/bets`, window.location.origin);
      url.searchParams.set('wallet', wallet.address);
      url.searchParams.set('currency', currency);
      const resp = await fetch(url.pathname + url.search);
      return resp.json();
    },
    enabled: !!wallet.address && !!raceId && connected,
    refetchInterval: 5000,
  });

  // Place bet mutation
  const placeBetMutation = useMutation({
    mutationFn: async (betData: PlaceBetRequest) => {
      return api.placeBet(betData);
    },
    onSuccess: (data) => {
      showToast('Bet Placed Successfully', 'Your bet has been confirmed on-chain', 'success');
      // Cash register SFX on confirmed success
      try { playSound('bet_placed'); } catch {}
      queryClient.invalidateQueries({ queryKey: ['/api/races', raceId, 'totals'] });
      queryClient.invalidateQueries({ queryKey: ['/api/races', raceId, 'bets'] });
    },
    onError: async (error, variables) => {
      const errMsg = (error as any)?.message?.toString?.() || '';
      // Try to parse server-provided error field from message like: "400: {\"error\":\"...\"}"
      let serverError: string | undefined;
      try {
        const jsonStart = errMsg.indexOf('{');
        if (jsonStart !== -1) {
          const parsed = JSON.parse(errMsg.slice(jsonStart));
          serverError = parsed?.error || parsed?.message;
        }
      } catch {}

      const combined = (serverError || errMsg).toLowerCase();
      const limitError = combined.includes('minimum bet') || combined.includes('maximum bet');

      if (limitError) {
        // Show a clear, final message and do NOT attempt on-chain verification fallback
        const title = combined.includes('minimum bet') ? 'Bet Too Small' : 'Bet Too Large';
        showToast(title, serverError || 'Bet violates limits', 'error');
        return;
      }

      // For other errors where a signature exists, try on-chain verification fallback
      try {
        const sig = (variables as any)?.txSig;
        if (sig) {
          showToast('Verifying on-chain…', 'Waiting for confirmation', 'info');
          const maxAttempts = 15;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const r = await fetch(`/api/bet/check/${sig}`);
              const data = await r.json();
              if (data?.valid) {
                try {
                  await api.placeBet(variables as any);
                  showToast('Bet Placed Successfully', 'Your bet has been confirmed on-chain', 'success');
                } catch {
                  showToast('Bet Confirmed On-Chain', 'Syncing with server…', 'info');
                }
                queryClient.invalidateQueries({ queryKey: ['/api/races', raceId, 'totals'] });
                queryClient.invalidateQueries({ queryKey: ['/api/races', raceId, 'bets'] });
                const enableRescan = (import.meta.env.VITE_ENABLE_RESCAN || '').toString().toLowerCase() === 'true' || (import.meta.env.VITE_ENABLE_RESCAN || '').toString() === '1';
                if (enableRescan && wallet.address) {
                  try { await api.rescanBets(wallet.address, raceId); } catch {}
                }
                return;
              }
            } catch {}
            await new Promise(res => setTimeout(res, 2000));
          }
        }
      } catch {}

      showToast('Bet Failed', serverError || errMsg || 'Submit failed', 'error');
    },
    onSettled: () => {
      if (betTimerRef.current) {
        clearTimeout(betTimerRef.current);
        betTimerRef.current = null;
      }
      setIsBetting(false);
    }
  });

  // Update store when data changes
  useEffect(() => {
    if (raceData) {
      setRace({ currentRace: raceData as Race });
    }
  }, [raceData, setRace]);

  useEffect(() => {
    if (totals) {
      setRace({ raceTotals: totals as RaceTotals });
    }
  }, [totals, setRace]);

  useEffect(() => {
    if (userBets) {
      setRace({ userBets });
    }
  }, [userBets, setRace]);

  // Proactive self-healing: trigger a lightweight server-side rescan for this wallet/race
  useEffect(() => {
    (async () => {
      try {
        const enableRescan = (import.meta.env.VITE_ENABLE_RESCAN || '').toString().toLowerCase() === 'true' || (import.meta.env.VITE_ENABLE_RESCAN || '').toString() === '1';
        if (enableRescan && connected && wallet.address && raceId) {
          await api.rescanBets(wallet.address, raceId);
          // After rescan, refresh bets quickly
          queryClient.invalidateQueries({ queryKey: ['/api/races', raceId, 'bets'] });
        }
      } catch {}
    })();
    // Run when address/race changes
  }, [connected, wallet.address, raceId, queryClient]);

  // Handle bet placement with real transaction
  const handlePlaceBet = async () => {
    // Allow '.' as in-progress input; require valid numeric > 0
    const inProgressAmount = betSlip.betAmount === '.' ? '' : betSlip.betAmount;
    if (!betSlip.selectedRace || 
        betSlip.selectedRunnerIndex === null || !inProgressAmount || isNaN(Number(inProgressAmount)) || Number(inProgressAmount) <= 0) {
      toast({
        title: "Cannot Place Bet",
        description: "Please select a runner and enter bet amount",
        variant: "destructive",
      });
      return;
    }

    // Debug wallet state (remove after testing)
    console.log('🔍 Betting Debug:', { 
      connected, 
      walletFromStore: wallet.connected,
      walletAddress: wallet.address,
      betSlipData: {
        selectedRaceId: betSlip.selectedRace?.id,
        selectedRunnerIndex: betSlip.selectedRunnerIndex,
        betAmount: betSlip.betAmount
      }
    });

    if (!connected) {
      toast({
        title: "Wallet Not Connected", 
        description: "Please connect your wallet to place bets",
        variant: "destructive",
      });
      return;
    }

    // Use wallet address from store 
    const walletAddress = wallet.address;
    if (!walletAddress) {
      toast({
        title: "Wallet Address Missing",
        description: "Unable to get wallet address",
        variant: "destructive",
      });
      return;
    }

    // Prevent accidental double-submit
    if (isBetting) return;

    // Client-side min/max validation using treasury config per selected currency
    try {
      const treasuryResponse = await fetch('/api/treasury');
      const treasury = await treasuryResponse.json();
      const isSol = currency === 'SOL';
      const minStr = (isSol ? (treasury?.betMinSol || '') : (treasury?.betMinRace || '')).toString();
      const maxStr = (isSol ? (treasury?.betMaxSol || '') : (treasury?.betMaxRace || '')).toString();
      const amt = new Decimal(inProgressAmount || '0');
      if (minStr) {
        const min = new Decimal(minStr);
        if (amt.lt(min)) {
          toast({
            title: 'Bet Too Small',
            description: `Minimum bet is ${min.toString()} ${isSol ? 'SOL' : '$RACE'}`,
            variant: 'destructive',
          });
          return;
        }
      }
      if (maxStr) {
        const max = new Decimal(maxStr);
        if (amt.gt(max)) {
          toast({
            title: 'Bet Too Large',
            description: `Maximum bet is ${max.toString()} ${isSol ? 'SOL' : '$RACE'}`,
            variant: 'destructive',
          });
          return;
        }
      }
    } catch {}

    // Start placing state early to gate rapid clicks
    setIsBetting(true);
    if (betTimerRef.current) {
      clearTimeout(betTimerRef.current);
      betTimerRef.current = null;
    }
    betTimerRef.current = window.setTimeout(() => {
      setIsBetting(false);
      betTimerRef.current = null;
    }, 15000);

    try {
      console.log('🚀 Creating transfer transaction...');
      
      // Get treasury info for mint and escrow wallet
      const treasuryResponse = await fetch('/api/treasury');
      const treasury = await treasuryResponse.json();
      
      // Convert addresses to PublicKey objects
      const fromPubkey = new PublicKey(walletAddress);
      if (!treasury.escrowPubkey) throw new Error('Escrow wallet not available');
      const escrowPubkey = new PublicKey(treasury.escrowPubkey);
      
      // Prepare amounts
      const betAmountFloat = parseFloat(inProgressAmount || '0');
      const decimals = 9;
      const betAmountLamportsStr = new Decimal(inProgressAmount || '0').mul(new Decimal(10).pow(decimals)).toFixed(0);
      const betAmountLamportsBig = BigInt(betAmountLamportsStr);
      
      console.log('💰 Bet amount:', betAmountFloat, currency);
      
      // Create RPC connection early for balance checks
      const rpcUrl =
        import.meta.env.VITE_RPC_URL ||
        'https://spring-cold-tree.solana-mainnet.quiknode.pro/24011188359c3607a1ed91ac2ecbfe22b8e39681/';
      const connection = new Connection(rpcUrl, 'confirmed');
      
      // For RACE, derive mint and token accounts
      let raceMint: PublicKey | null = null;
      let fromTokenAccount: PublicKey | null = null;
      let toTokenAccount: PublicKey | null = null;
      if (currency !== 'SOL') {
        if (!treasury.raceMint) throw new Error('RACE token mint not found');
        raceMint = new PublicKey(treasury.raceMint);
        fromTokenAccount = await getAssociatedTokenAddress(raceMint, fromPubkey);
        toTokenAccount = await getAssociatedTokenAddress(raceMint, escrowPubkey);
        console.log('🏦 Token accounts - From:', fromTokenAccount.toString(), 'To:', toTokenAccount.toString());
      }

      // Proactive balance check to avoid simulation failures
      try {
        if (currency === 'SOL') {
          const sol = await connection.getBalance(fromPubkey, 'processed');
          if (BigInt(sol) < betAmountLamportsBig) {
            toast({ title: 'Insufficient Balance', description: 'Not enough SOL to place this bet.', variant: 'destructive' });
            return;
          }
        } else {
          const bal = await connection.getTokenAccountBalance(fromTokenAccount!, 'processed');
          const currentBalance = BigInt(bal?.value?.amount || '0');
          if (currentBalance < betAmountLamportsBig) {
            toast({ title: 'Insufficient Balance', description: 'Not enough $RACE in your wallet to place this bet.', variant: 'destructive' });
            return;
          }
        }
      } catch (balErr) {
        console.warn('Balance check failed', balErr);
      }

      // Build transfer instruction per selected currency
      const transferInstruction = currency === 'SOL'
        ? SystemProgram.transfer({ fromPubkey, toPubkey: escrowPubkey, lamports: Number(betAmountLamportsBig) })
        : createTransferCheckedInstructionManual(
            fromTokenAccount!,
            raceMint!,
            toTokenAccount!,
            fromPubkey,
            betAmountLamportsBig,
            decimals,
            []
          );
      
      // Create transaction and set recent blockhash/fee payer
      const transaction = new Transaction();
      // Ensure user's ATA exists (idempotent create if missing)
      if (currency !== 'SOL') {
        const fromInfo = await connection.getAccountInfo(fromTokenAccount!);
        if (!fromInfo) {
          transaction.add(
            createAssociatedTokenAccountInstruction(
              fromPubkey,
              fromTokenAccount!,
              fromPubkey,
              raceMint!
            )
          );
        }
      }
      transaction.add(transferInstruction);

      // Attach memo with bet details for reconciliation (use short keys to avoid truncation)
      const clientId = `c_${Date.now()}_${wallet.address.slice(-6)}`; // Use wallet suffix instead of random
      // Attach referral code from URL if present
      const urlParams = new URLSearchParams(window.location.search);
      const ref = (urlParams.get('ref') || '').toString();
      // Use abbreviated keys to keep memo size under limit
      const memoPayload = {
        t: 'BET',
        r: betSlip.selectedRace.id,  // r = raceId
        i: betSlip.selectedRunnerIndex,  // i = runnerIdx  
        a: inProgressAmount,  // a = amount
        c: clientId,  // c = clientId
        u: currency,  // u = currency
        ...(ref ? { f: ref } : {})  // f = ref
      };
      const memoString = JSON.stringify(memoPayload);
      const memoProgramId = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
      const memoIx = new Web3TransactionInstruction({
        keys: [],
        programId: memoProgramId,
        data: new TextEncoder().encode(memoString)
      });
      transaction.add(memoIx);
      
      // Get recent blockhash (use 'processed' for freshest validity window)
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = fromPubkey;

      console.log('🔍 [BET DEBUG] Transaction details before signing:');
      console.log('  - Total instructions:', transaction.instructions.length);
      console.log('  - Memo payload:', memoPayload);
      console.log('  - Memo string:', memoString);
      console.log('  - Memo instruction data length:', memoIx.data.length);
      transaction.instructions.forEach((ix, i) => {
        console.log(`  - Instruction ${i}: ${ix.programId.toString()}`);
      });
      console.log('💳 Requesting wallet to sign transaction...');

      const provider = (window as any).phantom?.solana ?? (window as any).solana;
      if (!provider || (!provider.signTransaction && !provider.signAndSendTransaction)) {
        throw new Error('Wallet not found or does not support signing transactions');
      }

      // Prefer signTransaction + manual send for consistent RPC
      let signature: string;
      if (provider.signTransaction) {
        const signed = await provider.signTransaction(transaction);
        const raw = signed.serialize();
        // Derive signature locally in case RPC reports "already processed"
        let derivedSig: string | undefined;
        try {
          if (signed.signature) {
            derivedSig = bs58.encode(signed.signature as Uint8Array);
          }
        } catch {}
        try {
          signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
        } catch (sendErr: any) {
          // Attempt to extract simulation logs for better UX
          try {
            if (typeof sendErr?.getLogs === 'function') {
              const logs = await sendErr.getLogs(connection);
              console.error('Simulation logs:', logs);
              if (Array.isArray(logs) && logs.some((l: string) => l.includes('insufficient funds'))) {
                throw new Error('Insufficient $RACE balance');
              }
            } else if (Array.isArray(sendErr?.logs)) {
              console.error('Simulation logs:', sendErr.logs);
              if (sendErr.logs.some((l: string) => l.includes('insufficient funds'))) {
                throw new Error('Insufficient $RACE balance');
              }
            }
          } catch (logParseErr) {}
          const msg = String(sendErr?.message || sendErr);
          // Treat duplicate-broadcast as success using derived signature
          if (msg.includes('already been processed') || msg.includes('already processed')) {
            if (derivedSig) {
              signature = derivedSig;
            } else {
              throw sendErr;
            }
          } else {
            throw sendErr;
          }
        }
        // Submit bet immediately; confirm in background to avoid client-side expiry races
        console.log('✅ Transaction sent (awaiting server verification):', signature);
        const betRequest: PlaceBetRequest = {
          raceId: betSlip.selectedRace.id,
          runnerIdx: betSlip.selectedRunnerIndex,
          amount: inProgressAmount,
          fromPubkey: walletAddress,
          txSig: signature,
          clientId,
          memo: memoString,
          currency
        };
        placeBetMutation.mutate(betRequest);
        // Best-effort confirmation in background (do not block UX)
        try {
          connection
            .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
            .catch((e) => console.warn('Background confirm failed:', e?.message || e));
        } catch {}
      } else {
        const res = await provider.signAndSendTransaction(transaction);
        signature = res.signature;
        console.log('✅ Transaction sent (awaiting server verification):', signature);
        const betRequest: PlaceBetRequest = {
          raceId: betSlip.selectedRace.id,
          runnerIdx: betSlip.selectedRunnerIndex,
          amount: inProgressAmount,
          fromPubkey: walletAddress,
          txSig: signature,
          clientId,
          memo: memoString,
          currency
        };
        placeBetMutation.mutate(betRequest);
      }

    } catch (error) {
      console.error('Bet placement error:', error);
      let description = error instanceof Error ? error.message : 'Failed to sign or send transaction';
      try {
        // If we can fetch logs here, do it
        const rpcUrl =
          import.meta.env.VITE_RPC_URL ||
          'https://spring-cold-tree.solana-mainnet.quiknode.pro/24011188359c3607a1ed91ac2ecbfe22b8e39681/';
        const cx = new Connection(rpcUrl, 'confirmed');
        const anyErr: any = error;
        if (typeof anyErr?.getLogs === 'function') {
          const logs = await anyErr.getLogs(cx);
          console.error('Simulation logs:', logs);
          if (Array.isArray(logs) && logs.some((l: string) => l.includes('insufficient funds'))) {
            description = 'Insufficient $RACE balance in your wallet';
          }
        } else if (Array.isArray(anyErr?.logs)) {
          console.error('Simulation logs:', anyErr.logs);
          if (anyErr.logs.some((l: string) => l.includes('insufficient funds'))) {
            description = 'Insufficient $RACE balance in your wallet';
          }
        }
      } catch {}
      toast({
        title: "Transaction Failed",
        description,
        variant: "destructive",
      });
      if (betTimerRef.current) {
        clearTimeout(betTimerRef.current);
        betTimerRef.current = null;
      }
      setIsBetting(false);
    }
  };

  // Handle race start redirect
  useEffect(() => {
    if (raceData?.status === 'LOCKED' || raceData?.status === 'IN_PROGRESS') {
      setLocation(`/race/${raceId}/live`);
    }
  }, [raceData?.status, raceId, setLocation]);

  if (raceError) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Card className="max-w-md mx-auto">
          <CardContent className="pt-6 text-center">
            <i className="fas fa-exclamation-triangle text-4xl text-destructive mb-4"></i>
            <h2 className="text-lg font-semibold mb-2">Race Not Found</h2>
            <p className="text-sm text-muted-foreground mb-4">
              The requested race could not be found or has been removed.
            </p>
            <Link href="/">
              <Button data-testid="back-to-lobby">
                <i className="fas fa-arrow-left mr-2"></i>
                Back to Lobby
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (raceLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardContent className="p-6">
                <Skeleton className="h-8 w-48 mb-4" />
                <div className="grid grid-cols-3 gap-4 mb-6">
                  {[...Array(3)].map((_, i) => (
                    <Skeleton key={i} className="h-20" />
                  ))}
                </div>
                <Skeleton className="h-96" />
              </CardContent>
            </Card>
          </div>
          <div className="space-y-6">
            <Card>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-32 mb-4" />
                <Skeleton className="h-40" />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (!raceData) return null;

  const currentRace = raceData as Race;
  const raceTotals = totals as RaceTotals | undefined;
  const isRaceOpen = currentRace.status === 'OPEN';
  // Feature flag: allow only SOL bets until RACE launch
  const RACE_DISABLED = !(((import.meta.env.VITE_ENABLE_RACE_BETS || '').toString() === '1') || ((import.meta.env.VITE_ENABLE_RACE_BETS || '').toString().toLowerCase() === 'true'));
  const canBet = isRaceOpen && (currency === 'SOL' || !RACE_DISABLED);

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Main Race Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Race Header */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-xl text-primary flex items-center gap-2">
                    <i className="fas fa-flag-checkered"></i>
                    {getRaceDisplayName(currentRace.id)}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {currentRace.runners.length} runners competing
                  </p>
                </div>
                <div className="text-right">
                  {isRaceOpen ? (
                    (() => {
                      const { target, label } = getCountdownTargetAndLabel(currentRace);
                      if (target > 0 && label) {
                        return (
                          <Countdown 
                            targetTime={target}
                            prefix={label}
                            data-testid="race-countdown"
                          />
                        );
                      }
                      return null;
                    })()
                  ) : (
                    <Badge 
                      variant={currentRace.status === 'LOCKED' ? 'destructive' : 'secondary'}
                      className="text-lg px-4 py-2"
                    >
                      {currentRace.status}
                    </Badge>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Race Stats */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-muted/30 rounded p-3 text-center">
                  <div className="text-lg font-bold font-mono text-primary" data-testid="total-pot">
                    {totalsLoading ? (
                      <Skeleton className="h-6 w-16 mx-auto" />
                    ) : (
                      formatLargeNumber(raceTotals?.totalPot || '0')
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">Total Pot ({currency === 'SOL' ? 'SOL' : '$RACE'})</div>
                </div>
                <div className="bg-muted/30 rounded p-3 text-center">
                  <div className="text-lg font-bold font-mono text-secondary" data-testid="total-bets">
                    {totalsLoading ? (
                      <Skeleton className="h-6 w-12 mx-auto" />
                    ) : (
                      raceTotals?.betCount || 0
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">Total Bets</div>
                </div>
                <div className="bg-muted/30 rounded p-3 text-center">
                  <div className="text-lg font-bold font-mono text-accent" data-testid="jackpot-status">
                    {currentRace.jackpotFlag ? '+JACKPOT' : 'No Jackpot'}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {currentRace.jackpotFlag ? 'Active' : 'Standard Race'}
                  </div>
                </div>
              </div>

              {/* Runner Grid */}
              <RunnerGrid 
                race={currentRace}
                totals={raceTotals}
                isLoading={totalsLoading}
                canBet={canBet}
                data-testid="runner-grid"
              />

              {/* Odds Bar */}
              {raceTotals && (
                <OddsBar 
                  runners={currentRace.runners}
                  totals={raceTotals}
                  className="mt-4"
                  data-testid="odds-bar"
                />
              )}

              {/* Pricing Data Verification */}
              <div className="mt-4 p-3 bg-muted/20 rounded border border-border">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <i className="fas fa-chart-bar text-green-400"></i>
                    <span className="text-muted-foreground">Live Market Data:</span>
                    <span className="text-green-400 font-semibold">GeckoTerminal</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {currentRace.runners.map((runner) => {
                      // Extract pool address from existing geckoTerminalUrl or use new poolAddress field
                      const poolAddress = runner.poolAddress || 
                        (runner.geckoTerminalUrl ? runner.geckoTerminalUrl.split('/').pop() : null);
                      
                      return (
                        <a
                          key={runner.mint}
                          href={poolAddress ? 
                            `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/hour?aggregate=1` :
                            `https://www.geckoterminal.com/solana/pools?search=${runner.mint}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-1 bg-green-500/20 border border-green-500/50 rounded text-green-400 hover:bg-green-500/30 transition-colors text-xs"
                          data-testid={`verify-pricing-${runner.symbol}`}
                        >
                          <i className="fas fa-chart-line text-xs"></i>
                          {runner.symbol}
                          <i className="fas fa-external-link-alt text-xs"></i>
                        </a>
                      );
                    })}
                  </div>
                </div>
              </div>

            </CardContent>
          </Card>

          {/* User's Active Bets */}
          {wallet.connected && userBets && userBets.bets.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <i className="fas fa-ticket-alt text-accent"></i>
                  Your Bets This Race
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {userBets.bets.map((bet) => (
                    <div key={bet.id} className="flex items-center justify-between p-3 bg-muted/20 rounded" data-testid={`user-bet-${bet.id}`}>
                      <div className="flex items-center gap-3">
                        {bet.runner?.logoURI ? (
                          <img 
                            src={bet.runner.logoURI} 
                            alt={bet.runner.symbol}
                            className="w-6 h-6 rounded-full"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              e.currentTarget.nextElementSibling!.style.display = 'flex';
                            }}
                          />
                        ) : null}
                        <div 
                          className="w-6 h-6 rounded-full bg-gradient-to-r from-primary to-secondary flex items-center justify-center text-xs font-bold"
                          style={{ display: bet.runner?.logoURI ? 'none' : 'flex' }}
                        >
                          {bet.runner?.symbol.substring(0, 2) || '?'}
                        </div>
                        <div>
                          <div className="text-sm font-semibold">{bet.runner?.symbol || 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground">
                            {new Date(bet.ts).toLocaleTimeString()}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-bold text-primary font-mono">
                          {formatLargeNumber(bet.amount)} {currency === 'SOL' ? 'SOL' : '$RACE'}
                        </div>
                        {raceTotals && (
                          <div className="text-xs text-muted-foreground">
                            Potential: {calculatePayout(bet.amount, raceTotals.impliedOdds[bet.runnerIdx])} {currency === 'SOL' ? 'SOL' : '$RACE'}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="border-t border-border pt-3 mt-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Total Wagered:</span>
                    <span className="font-bold text-foreground font-mono" data-testid="total-wagered">
                      {formatLargeNumber(userBets.totalWagered)} {currency === 'SOL' ? 'SOL' : '$RACE'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Betting Panel */}
        <div className="space-y-6">
          {/* Bet Slip */}
          <BetSlip 
            canBet={canBet}
            onPlaceBet={handlePlaceBet}
            isPlacing={isBetting}
            data-testid="bet-slip"
          />

          {/* Recent Winners - could be a separate component */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <i className="fas fa-trophy text-accent"></i>
                Quick Actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Link href="/">
                <Button variant="outline" className="w-full" data-testid="back-to-lobby-btn">
                  <i className="fas fa-arrow-left mr-2"></i>
                  Back to Lobby
                </Button>
              </Link>
              
              {currentRace.status === 'SETTLED' && (
                <Link href={`/race/${raceId}/results`}>
                  <Button variant="secondary" className="w-full" data-testid="view-results-btn">
                    <i className="fas fa-trophy mr-2"></i>
                    View Results
                  </Button>
                </Link>
              )}

              {(currentRace.status === 'LOCKED' || currentRace.status === 'IN_PROGRESS') && (
                <Link href={`/race/${raceId}/live`}>
                  <Button variant="secondary" className="w-full" data-testid="watch-live-btn">
                    <i className="fas fa-eye mr-2"></i>
                    Watch Live
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
