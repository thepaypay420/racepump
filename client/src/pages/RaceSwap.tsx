import { useState, useMemo, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import Decimal from "decimal.js";
import { PublicKey, type Connection } from "@solana/web3.js";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Loader2, Rocket, ShieldCheck, ArrowDownUp, ArrowLeft } from "lucide-react";
import { RaceswapTokenSelector, TokenOption } from "@/components/RaceswapTokenSelector";
import { RaceswapCrate } from "@/components/RaceswapCrate";
import { executeSwapWithReflection, getSwapPlan, SwapPlan, RACE_TOKEN_MINT } from "@/lib/jupiter-frontend";
import type {
  ReflectionTokenMeta,
  RaceswapPublicConfig,
  RaceswapTokenInfo,
} from "@shared/raceswap";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DEFAULT_OPTION: TokenOption = {
  address: SOL_MINT,
  symbol: "SOL",
  name: "Wrapped SOL",
  decimals: 9,
  logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png"
};

// MINIMUM BUY AMOUNT: Enforce minimum to ensure 1% reflection is meaningful
const MINIMUM_BUY_LAMPORTS = BigInt(
  process.env.RACESWAP_MIN_BUY_LAMPORTS || "10000000"
);
const MINIMUM_BUY_SOL = Number(MINIMUM_BUY_LAMPORTS) / 1e9; // For display

interface WinnerResponse {
  id: string;
  runners: Array<{ mint: string; symbol: string; logoURI?: string }>;
  winnerIndex?: number;
}

interface ReceiptData {
    spentAmount: string;
    spentSymbol?: string;
    spentLogo?: string;
    receivedAmount: string;
    receivedSymbol?: string;
    receivedLogo?: string;
    reflectionAmount: string;
    reflectionSymbol?: string;
    reflectionLogo?: string;
    txSignature: string;
}

export default function RaceSwap() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { toast } = useToast();
  const walletAddress = wallet.publicKey?.toBase58();

  const [inputToken, setInputToken] = useState<TokenOption | null>(null);
  const [outputToken, setOutputToken] = useState<TokenOption | null>(null);
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(150);
  const [reflectionBps, setReflectionBps] = useState(500); // Default 5%
  
  const [crateKey, setCrateKey] = useState(0);
  const [crateSpinning, setCrateSpinning] = useState(false);
  const [swapSuccess, setSwapSuccess] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);

  const { data: raceswapConfig } = useQuery<RaceswapPublicConfig>({
    queryKey: ["raceswap-config"],
    queryFn: api.getRaceswapConfig,
    staleTime: 60000,
  });

  const { data: reflectionMeta } = useQuery<ReflectionTokenMeta>({
    queryKey: ["raceswap-reflection"],
    queryFn: api.getRaceswapReflection,
    refetchInterval: 20000,
  });

  const { data: tokenList } = useQuery<RaceswapTokenInfo[]>({
    queryKey: ["raceswap-token-list"],
    queryFn: () => api.getRaceswapTokens(250),
    staleTime: 300000,
  });

  const { data: recentWinners } = useQuery<WinnerResponse[]>({
    queryKey: ["recent-winners", 12],
    queryFn: async () => {
      const res = await fetch("/api/recent-winners?limit=12");
      return res.json();
    },
    staleTime: 60000,
  });

  const tokenOptions = useMemo(() => mapTokens(tokenList), [tokenList]);
  const sameTokenSwap = useMemo(
    () => Boolean(inputToken && outputToken && inputToken.address === outputToken.address),
    [inputToken, outputToken]
  );

  useEffect(() => {
    if (!tokenOptions.length) return;
    if (!inputToken) {
      const solDefault = tokenOptions.find((token) => token.address === SOL_MINT) ?? SOL_DEFAULT_OPTION;
      setInputToken(solDefault);
    }
    if (!outputToken) {
      const raceToken = tokenOptions.find((token) => token.address === RACE_TOKEN_MINT.toString());
      const usdc = tokenOptions.find((token) => token.symbol === "USDC");
      const fallback = tokenOptions.find((token) => token.address !== SOL_MINT);
      const output = raceToken ?? usdc ?? fallback ?? tokenOptions[0];
      if (output) {
        setOutputToken(output);
      }
    }
  }, [tokenOptions, inputToken, outputToken]);

  const lamportsAmount = useMemo(() => {
    if (!amount || !inputToken) return null;
    try {
      const dec = new Decimal(amount);
      if (dec.lte(0)) return null;
      const raw = dec.mul(new Decimal(10).pow(inputToken.decimals)).toFixed(0, Decimal.ROUND_DOWN);
      const big = BigInt(raw);
      return big > 0n ? big : null;
    } catch {
      return null;
    }
  }, [amount, inputToken]);
  
  const isBelowMinimum = useMemo(() => {
    if (!lamportsAmount || !inputToken) return false;
    if (inputToken.address === SOL_MINT) {
      return lamportsAmount < MINIMUM_BUY_LAMPORTS;
    }
    return false;
  }, [lamportsAmount, inputToken]);

  const inputBalanceQuery = useQuery<string>({
    queryKey: ["raceswap-token-balance", walletAddress, inputToken?.address],
    queryFn: async () => {
      if (!wallet.publicKey || !inputToken) return "0";
      return fetchTokenBalance(connection, wallet.publicKey, inputToken);
    },
    enabled: Boolean(wallet.publicKey && wallet.connected && inputToken),
    refetchInterval: 15000,
    staleTime: 10000,
  });

  const outputBalanceQuery = useQuery<string>({
    queryKey: ["raceswap-token-balance", walletAddress, outputToken?.address, "receive"],
    queryFn: async () => {
      if (!wallet.publicKey || !outputToken) return "0";
      return fetchTokenBalance(connection, wallet.publicKey, outputToken);
    },
    enabled: Boolean(wallet.publicKey && wallet.connected && outputToken),
    refetchInterval: 15000,
    staleTime: 10000,
  });

  // Determine reflection token (Latest Winner)
  const mostRecentWinner = recentWinners?.[0];
  const winnerRunner = mostRecentWinner?.runners?.[mostRecentWinner.winnerIndex ?? 0];
  // Use most recent winner mint, fallback to RACE if unavailable
  const reflectionMint = winnerRunner?.mint ?? RACE_TOKEN_MINT.toString();
  const reflectionSymbolDisplay = winnerRunner?.symbol ?? reflectionMeta?.symbol ?? "RACE";
  const reflectionLogoURI = winnerRunner?.logoURI;

  const planQuery = useQuery<SwapPlan>({
    queryKey: [
      "raceswap-plan-v2",
      inputToken?.address,
      outputToken?.address,
      lamportsAmount?.toString(),
      slippageBps,
      reflectionBps,
      reflectionMint,
      sameTokenSwap,
    ],
    queryFn: () =>
      getSwapPlan({
        inputMint: inputToken!.address,
        outputMint: outputToken!.address,
        amount: Number(lamportsAmount),
        slippageBps,
        reflectionMint,
        reflectionBps,
      }),
    enabled: Boolean(
      inputToken &&
        outputToken &&
        lamportsAmount &&
        lamportsAmount > 0n &&
        !sameTokenSwap
    ),
    refetchInterval: 15000,
  });
  
  const planData = sameTokenSwap ? undefined : planQuery.data;
  const isPlanLoading = planQuery.isLoading || planQuery.isFetching;

  // Crate Tokens (Randomized recent winners)
  const crateTokens = useMemo(() => {
    const tokens = (recentWinners ?? [])
      .map((race) => {
        const runner = race.runners?.[race.winnerIndex ?? 0];
        if (!runner) return null;
        return { mint: runner.mint, symbol: runner.symbol, logoURI: runner.logoURI };
      })
      .filter(Boolean) as Array<{ mint: string; symbol: string; logoURI?: string }>;
      
    // Shuffle
    for (let i = tokens.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
    }
    
    return tokens;
  }, [recentWinners]);

  const isSwapping = isExecuting;

  const primaryDisabled =
    !wallet.connected ||
    !planData ||
    isPlanLoading ||
    !lamportsAmount ||
    lamportsAmount <= 0n ||
    isSwapping ||
    sameTokenSwap ||
    isBelowMinimum;
    
  const planMainOut = useMemo(() => {
    if (!planData || !outputToken) return "--";
    return formatAmount(planData.mainSwapAmount, outputToken.decimals);
  }, [planData, outputToken]);

  const planReflectionOut = useMemo(() => {
    if (!planData) return "0";
    const decimals = reflectionMeta?.decimals ?? 6; 
    return formatAmount(planData.reflectionAmount, decimals);
  }, [planData, reflectionMeta]);

  async function handleSwap() {
    if (sameTokenSwap) {
      toast({
        title: "Select different tokens",
        description: "Input and output tokens must be different to create a swap.",
        variant: "destructive",
      });
      return;
    }
    if (!planData || !wallet.publicKey) {
      toast({ title: "Missing data", description: "Connect your wallet and preview a plan first.", variant: "destructive" });
      return;
    }
    
    // For token swaps (not SOL), fetch actual balance and ensure we use full amount if close
    // This prevents small leftover balances that confuse Phantom's simulation
    let swapAmount = Number(lamportsAmount);
    if (inputToken && inputToken.address !== SOL_MINT) {
      try {
        const actualBalanceStr = await fetchTokenBalance(connection, wallet.publicKey, inputToken);
        const actualBalance = parseFloat(actualBalanceStr);
        const requestedAmount = parseFloat(amount);
        
        if (!isNaN(actualBalance) && actualBalance > 0) {
          // Convert actual balance to base units
          const actualBalanceBase = BigInt(
            new Decimal(actualBalance)
              .mul(new Decimal(10).pow(inputToken.decimals))
              .toFixed(0, Decimal.ROUND_DOWN)
          );
          
          const requestedBase = BigInt(swapAmount);
          
          // More aggressive: If requested amount is within 5% of actual balance, use full balance
          // This prevents even small leftovers (like 0.13 USDC) that trigger Phantom warnings
          const balanceThreshold = actualBalanceBase * BigInt(95) / BigInt(100);
          
          if (requestedBase >= balanceThreshold) {
            // Use full balance to avoid leftover
            swapAmount = Number(actualBalanceBase);
            const usedPercent = (Number(requestedBase) / Number(actualBalanceBase) * 100).toFixed(2);
            console.log(`🔄 Using full balance ${actualBalance} ${inputToken.symbol} (requested ${usedPercent}%, avoiding leftover)`);
          } else if (requestedBase > actualBalanceBase) {
            // Requested more than available, use available
            swapAmount = Number(actualBalanceBase);
            console.log(`⚠️ Requested ${requestedAmount} but only have ${actualBalance}, using full balance`);
            toast({
              title: "Insufficient balance",
              description: `Using full balance: ${actualBalance} ${inputToken.symbol}`,
              variant: "default",
            });
          } else {
            // Requested less than 95% - warn about potential leftover
            const leftoverEstimate = actualBalance - requestedAmount;
            if (leftoverEstimate > 0.01) { // More than 0.01 tokens leftover
              console.log(`⚠️ Swap will leave ~${leftoverEstimate.toFixed(6)} ${inputToken.symbol} (${(leftoverEstimate/actualBalance*100).toFixed(2)}%)`);
            }
          }
        }
      } catch (error) {
        console.warn("Failed to fetch actual balance, using requested amount:", error);
      }
    }
    
    // Store receipt data before clearing inputs
    const currentReceiptData: ReceiptData = {
        spentAmount: amount,
        spentSymbol: inputToken?.symbol,
        spentLogo: inputToken?.logoURI,
        receivedAmount: planMainOut,
        receivedSymbol: outputToken?.symbol,
        receivedLogo: outputToken?.logoURI,
        reflectionAmount: planReflectionOut,
        reflectionSymbol: reflectionSymbolDisplay,
        reflectionLogo: reflectionLogoURI,
        txSignature: "",
    };
    
    // Open modal and start spinning immediately
    setShowSuccessModal(true);
    setShowReceipt(false);
    setReceiptData(null);
    setCrateKey((prev) => prev + 1);
    setCrateSpinning(true);
    setSwapSuccess(false);
    setIsExecuting(true);
    
    try {
      const result = await executeSwapWithReflection(connection, wallet, {
         inputMint: inputToken!.address,
         outputMint: outputToken!.address,
         amount: swapAmount, // Use calculated amount (may be full balance for tokens)
         slippageBps,
         reflectionMint,
         reflectionBps
      });
      
      // Update receipt with signature
      setReceiptData({ ...currentReceiptData, txSignature: result.signature });
      
      setSwapSuccess(true);
      // Note: We keep crateSpinning=true until the modal is closed or animation completes
      
      toast({
        title: "Swap complete",
        description: `Tx: ${result.signature.slice(0, 8)}…`,
      });
      
      setAmount("");
      planQuery.refetch();
      inputBalanceQuery.refetch();
      outputBalanceQuery.refetch();
    } catch (error: any) {
      console.error("[raceswap] Swap error:", error);
      // Close modal on error
      setShowSuccessModal(false);
      setCrateSpinning(false);
      setSwapSuccess(false);
      
      let errorMessage = error?.message || "Unknown error";
      toast({
        title: "Swap failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsExecuting(false);
    }
  }

  const handleCloseModal = () => {
      setShowSuccessModal(false);
      setCrateSpinning(false);
      setSwapSuccess(false);
      setShowReceipt(false);
  };

  const handleMax = () => {
    if (!inputBalanceQuery.data || !inputToken) return;
    let val = inputBalanceQuery.data;
    if (inputToken.address === SOL_MINT) {
       const num = parseFloat(val);
       if (!isNaN(num) && num > 0.02) {
          val = (num - 0.01).toFixed(4); // Leave 0.01 SOL for fees
       }
    } else {
      // For tokens, use full balance (Jupiter handles fees from output)
      // This prevents leftover balances that confuse Phantom simulation
      const num = parseFloat(val);
      if (!isNaN(num) && num > 0) {
        // Use full balance with appropriate precision
        const decimals = inputToken.decimals || 6;
        val = num.toFixed(decimals).replace(/\.?0+$/, "");
      }
    }
    setAmount(val);
  };

  const handleHalf = () => {
    // If user has entered a value, half it
    const currentVal = parseFloat(amount);
    if (!isNaN(currentVal) && currentVal > 0) {
       setAmount((currentVal / 2).toFixed(6).replace(/\.?0+$/, ""));
       return;
    }
    // Fallback to half balance
    if (!inputBalanceQuery.data) return;
    const num = parseFloat(inputBalanceQuery.data);
    if (!isNaN(num)) {
       setAmount((num / 2).toFixed(6).replace(/\.?0+$/, ""));
    }
  };

  const handleFlipTokens = () => {
     const temp = inputToken;
     setInputToken(outputToken);
     setOutputToken(temp);
  };

  return (
    <div className="container mx-auto px-4 py-2 max-w-4xl space-y-4 flex flex-col justify-center flex-1">
      {/* Header with Back Button */}
      <div className="absolute top-6 left-4 md:top-8 md:left-8 z-10 hidden md:block">
         <Link href="/">
            <Button variant="ghost" className="gap-2 text-muted-foreground hover:text-foreground">
               <ArrowLeft className="w-4 h-4" />
               Back
            </Button>
         </Link>
      </div>

      <section className="text-center space-y-2 mt-2">
        <h1 className="text-4xl md:text-5xl font-bold text-primary neon-glow">Swap with Benefits</h1>
        <p className="max-w-[350px] md:max-w-2xl mx-auto text-muted-foreground">
          Instant swaps with automatic reflection into the latest race winner.
        </p>
      </section>

      <div className="grid gap-4 justify-items-center">
        <Card className="w-full max-w-lg bg-[#13141b] border-none shadow-2xl ring-1 ring-white/10 rounded-2xl overflow-hidden">
          <div className="p-3 flex items-center justify-between border-b border-white/5">
            <div className="flex items-center gap-2">
                <Link href="/" className="md:hidden">
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground">
                        <ArrowLeft className="w-4 h-4" />
                    </Button>
                </Link>
                <span className="text-sm font-medium text-muted-foreground pl-2 md:pl-0">Swap</span>
            </div>
          </div>
          
          <CardContent className="p-4 space-y-2">
            {/* PAY SECTION */}
            <div className="bg-[#1c1e26] rounded-xl p-4 space-y-2 border border-white/5 hover:border-white/10 transition-colors">
              <div className="flex justify-between text-xs text-muted-foreground items-center">
                <span>You pay</span>
                <div className="flex items-center gap-2">
                   <div className="flex gap-1">
                      <button onClick={handleHalf} className="text-[10px] bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded transition-colors text-primary/80 hover:text-primary">HALF</button>
                      <button onClick={handleMax} className="text-[10px] bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded transition-colors text-primary/80 hover:text-primary">MAX</button>
                   </div>
                   <span>{inputBalanceQuery.data ? `Bal: ${inputBalanceQuery.data}` : "--"}</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                 <Input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="bg-transparent border-none text-2xl font-bold p-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/30 w-full min-w-0 flex-1"
                 />
                 <div className="shrink-0">
                     <RaceswapTokenSelector
                        value={inputToken}
                        tokens={tokenOptions}
                        onSelect={setInputToken}
                        disabled={!tokenOptions.length}
                        compact
                      />
                 </div>
              </div>
            </div>

            {/* SWAP ARROW */}
            <div className="relative h-4 flex items-center justify-center z-10">
               <button 
                  onClick={handleFlipTokens}
                  className="absolute bg-[#13141b] p-1.5 rounded-full border border-white/10 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 hover:border-primary/50 hover:text-primary transition-all cursor-pointer"
               >
                  <ArrowDownUp className="w-4 h-4" />
               </button>
            </div>

            {/* RECEIVE SECTION */}
            <div className="bg-[#1c1e26] rounded-xl p-4 space-y-2 border border-white/5 hover:border-white/10 transition-colors">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>You receive</span>
                <span>{outputBalanceQuery.data ? `Bal: ${outputBalanceQuery.data}` : "--"}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                 <div className="text-2xl font-bold text-foreground truncate flex-1 min-w-0">
                    {isPlanLoading ? <Skeleton className="h-8 w-24" /> : planMainOut}
                 </div>
                 <div className="shrink-0">
                     <RaceswapTokenSelector
                        value={outputToken}
                        tokens={tokenOptions}
                        onSelect={setOutputToken}
                        disabled={!tokenOptions.length}
                        compact
                      />
                 </div>
              </div>
            </div>

            {/* REFLECTION SETTINGS */}
            <div className="bg-[#1c1e26]/50 rounded-xl p-4 mt-4 border border-primary/20">
               <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                     <ShieldCheck className="w-4 h-4 text-primary" />
                     <span className="text-sm font-medium">Reflection Split</span>
                  </div>
                  <span className="text-sm font-bold text-primary">{(reflectionBps / 100).toFixed(1)}%</span>
               </div>
               <Slider
                  defaultValue={[500]}
                  value={[reflectionBps]}
                  onValueChange={(val) => setReflectionBps(val[0])}
                  max={2000}
                  min={100}
                  step={50}
                  className="py-2"
               />
               <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                  <span>1%</span>
                  <span>20%</span>
               </div>
               <p className="text-xs text-muted-foreground mt-2">
                  Auto-buy the <span className="text-primary font-medium">Latest Winner</span>
               </p>
            </div>
            
            {/* INFO TILES (COMPACT) */}
            {planData && (
               <div className="space-y-2 pt-2">
                  <div className="flex justify-between text-xs">
                     <span className="text-muted-foreground">Rate</span>
                     <span>1 {inputToken?.symbol} ≈ {formatAmount((Number(planData.mainSwapAmount) / Number(amount)).toString(), 0)} {outputToken?.symbol}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                     <span className="text-muted-foreground">Treasury Fee</span>
                     <span>0.2%</span>
                  </div>
               </div>
            )}

            {/* ERROR / MINIMUM WARNING */}
            {isBelowMinimum && inputToken?.address === SOL_MINT && (
                <div className="bg-destructive/10 border border-destructive/20 p-3 rounded-lg flex items-center gap-2 text-xs text-destructive">
                   <AlertTriangle className="w-4 h-4" />
                   Minimum buy is {MINIMUM_BUY_SOL} SOL
                </div>
            )}

            <Button
              disabled={primaryDisabled}
              onClick={handleSwap}
              className="w-full h-14 text-lg font-bold bg-gradient-to-r from-primary to-purple-600 hover:from-primary/90 hover:to-purple-600/90 shadow-lg shadow-primary/20 mt-4"
            >
              {isSwapping ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Confirming...
                </>
              ) : isBelowMinimum ? (
                `Min Amount ${MINIMUM_BUY_SOL} ${inputToken?.symbol || "SOL"}`
              ) : wallet.connected ? (
                amount && parseFloat(amount) > 0 ? "Buy" : "Enter an amount"
              ) : (
                "Connect Wallet"
              )}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* SUCCESS MODAL WITH CRATE */}
      <Dialog open={showSuccessModal} onOpenChange={setShowSuccessModal}>
         <DialogContent className="sm:max-w-md border-none bg-[#13141b] text-white shadow-2xl" onInteractOutside={(e) => e.preventDefault()}>
            <div className="flex flex-col items-center justify-center p-4 space-y-6">
               <DialogTitle className="text-xl font-bold text-center">
                  {isExecuting ? "Confirming Transaction..." : "Swap Successful!"}
               </DialogTitle>
               
               <div className="w-full relative">
                  {/* FLOATING CRATE ANIMATION */}
                  <RaceswapCrate
                    tokens={crateTokens}
                    landingMint={reflectionMint}
                    spinning={crateSpinning}
                    success={swapSuccess}
                    onLand={() => setShowReceipt(true)}
                    triggerKey={crateKey}
                  />
               </div>

               {showReceipt && receiptData && (
                  <div className="w-full space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                     <div className="bg-white/5 rounded-xl p-4 space-y-3 border border-white/10">
                        <h3 className="text-sm font-medium text-muted-foreground text-center uppercase tracking-wider">Receipt</h3>
                        
                        <div className="flex justify-between items-center">
                           <div className="flex items-center gap-2">
                              {receiptData.spentLogo && <img src={receiptData.spentLogo} className="w-6 h-6 rounded-full" />}
                              <span className="text-sm">Spent</span>
                           </div>
                           <span className="font-bold text-red-400">-{receiptData.spentAmount} {receiptData.spentSymbol}</span>
                        </div>

                        <div className="flex justify-between items-center">
                           <div className="flex items-center gap-2">
                              {receiptData.receivedLogo && <img src={receiptData.receivedLogo} className="w-6 h-6 rounded-full" />}
                              <span className="text-sm">Received</span>
                           </div>
                           <span className="font-bold text-green-400">+{receiptData.receivedAmount} {receiptData.receivedSymbol}</span>
                        </div>

                        <div className="h-px bg-white/10" />

                        <div className="flex justify-between items-center">
                           <div className="flex items-center gap-2">
                              {receiptData.reflectionLogo && <img src={receiptData.reflectionLogo} className="w-6 h-6 rounded-full" />}
                              <span className="text-sm text-primary">Reflections</span>
                           </div>
                           <span className="font-bold text-primary">+{receiptData.reflectionAmount} {receiptData.reflectionSymbol}</span>
                        </div>
                     </div>
                     
                     {receiptData.txSignature && (
                        <a 
                           href={`https://solscan.io/tx/${receiptData.txSignature}`} 
                           target="_blank" 
                           rel="noreferrer"
                           className="block text-center text-xs text-muted-foreground hover:text-primary transition-colors"
                        >
                           View Transaction
                        </a>
                     )}

                     <Button onClick={handleCloseModal} className="w-full">
                        Close
                     </Button>
                  </div>
               )}
            </div>
         </DialogContent>
      </Dialog>
      
      {/* BOTTOM BANNER */}
      <div className="fixed bottom-0 left-0 w-full z-0 pointer-events-none flex justify-center opacity-60">
         <img 
            src="/racebanner.png" 
            alt="" 
            className="w-full h-auto object-cover object-bottom" 
            style={{ 
                maskImage: 'linear-gradient(to top, black 60%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to top, black 60%, transparent 100%)',
                maxHeight: '30vh'
            }}
         />
      </div>
    </div>
  );
}

function formatAmount(raw: string, decimals: number) {
  try {
    const dec = new Decimal(raw).div(new Decimal(10).pow(decimals));
    return dec.toSignificantDigits(6).toString();
  } catch {
    return "0";
  }
}

function mapToken(token?: RaceswapTokenInfo | null): TokenOption {
  if (!token) {
    return SOL_DEFAULT_OPTION;
  }
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    logoURI: token.logoURI,
    decimals: token.decimals ?? 9,
  };
}

function mapTokens(tokens?: RaceswapTokenInfo[] | null): TokenOption[] {
  const dedup = new Map<string, TokenOption>();
  dedup.set(SOL_DEFAULT_OPTION.address, SOL_DEFAULT_OPTION);
  
  // Ensure RACE is present for default selection
  const raceMint = RACE_TOKEN_MINT.toString();
  dedup.set(raceMint, {
    address: raceMint,
    symbol: "RACE",
    name: "Pump Racers",
    decimals: 6,
    logoURI: "/racepump.svg"
  });

  for (const token of tokens ?? []) {
    const mapped = mapToken(token);
    if (!mapped.symbol) continue;
    dedup.set(mapped.address, mapped);
  }
  return Array.from(dedup.values());
}

function fetchTokenBalance(connection: Connection, owner: PublicKey, token: TokenOption): Promise<string> {
    if (token.address === SOL_MINT) {
        return connection.getBalance(owner).then(lamports => formatAmount(lamports.toString(), token.decimals ?? 9));
    }
    const mintKey = new PublicKey(token.address);
    return connection.getParsedTokenAccountsByOwner(owner, { mint: mintKey }).then(accounts => {
        const tokenAmount = accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount;
        if (!tokenAmount) return "0";
        return formatAmount(tokenAmount.amount as string, Number(tokenAmount.decimals ?? token.decimals ?? 0));
    }).catch(() => "0");
}
