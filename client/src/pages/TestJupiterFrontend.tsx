import { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { executeSwapWithReflection, SwapResult } from '@/lib/jupiter-frontend';
import { useToast } from '@/hooks/use-toast';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export default function TestJupiterFrontend() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { toast } = useToast();
  
  const [amount, setAmount] = useState('0.01');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SwapResult | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  
  const checkBalance = async () => {
    if (!wallet.publicKey) return;
    const bal = await connection.getBalance(wallet.publicKey);
    setBalance(bal / LAMPORTS_PER_SOL);
  };
  
  const executeTest = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      toast({
        title: 'Wallet not connected',
        description: 'Please connect your wallet first',
        variant: 'destructive'
      });
      return;
    }
    
    setLoading(true);
    setResult(null);
    
    try {
      console.log('🚀 Starting test swap...');
      
      const amountLamports = Math.floor(parseFloat(amount) * LAMPORTS_PER_SOL);
      
      const swapResult = await executeSwapWithReflection(
        connection,
        wallet,
        {
          inputMint: WSOL_MINT,
          outputMint: USDC_MINT,
          amount: amountLamports,
          slippageBps: 50
        }
      );
      
      setResult(swapResult);
      
      toast({
        title: '✅ Swap successful!',
        description: `Signature: ${swapResult.signature.slice(0, 8)}...`
      });
      
      await checkBalance();
    } catch (error: any) {
      console.error('❌ Swap failed:', error);
      toast({
        title: '❌ Swap failed',
        description: error.message || 'Unknown error',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-black p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-4xl font-bold text-white">
            Jupiter Frontend Test
          </h1>
          <WalletMultiButton />
        </div>
        
        {wallet.connected && (
          <Card className="p-6 bg-black/40 border-purple-500/30 backdrop-blur">
            <div className="space-y-4">
              <div>
                <label className="text-white text-sm mb-2 block">
                  Wallet Balance
                </label>
                <div className="flex gap-2">
                  <Input 
                    value={balance !== null ? `${balance.toFixed(4)} SOL` : 'Loading...'} 
                    disabled 
                    className="bg-black/50 text-white"
                  />
                  <Button 
                    onClick={checkBalance}
                    variant="outline"
                    className="border-purple-500"
                    data-testid="button-check-balance"
                  >
                    Refresh
                  </Button>
                </div>
              </div>
              
              <div>
                <label className="text-white text-sm mb-2 block">
                  Amount (SOL)
                </label>
                <Input 
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="bg-black/50 text-white"
                  data-testid="input-amount"
                />
                <p className="text-xs text-purple-300 mt-1">
                  This will swap SOL → USDC with 0.2% treasury fee + 1% RACE reflection
                </p>
              </div>
              
              <Button 
                onClick={executeTest}
                disabled={loading || !wallet.publicKey}
                className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
                data-testid="button-execute-swap"
              >
                {loading ? '⏳ Swapping...' : '🚀 Execute Atomic Swap'}
              </Button>
              
              {result && (
                <div className="mt-4 p-4 bg-green-500/20 border border-green-500/50 rounded-lg">
                  <h3 className="text-white font-bold mb-2">✅ Swap Successful!</h3>
                  <div className="text-sm text-green-300 space-y-1">
                    <p>Signature: <a 
                      href={`https://solscan.io/tx/${result.signature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-green-200"
                    >
                      {result.signature.slice(0, 16)}...
                    </a></p>
                    <p>Main swap: {(parseInt(result.mainSwapAmount) / 1_000_000).toFixed(2)} USDC</p>
                    <p>RACE reflection: {result.reflectionAmount} tokens</p>
                    <p>Treasury fee: {(parseInt(result.treasuryFee) / LAMPORTS_PER_SOL).toFixed(4)} SOL</p>
                  </div>
                </div>
              )}
              
              <div className="text-xs text-purple-300 space-y-1">
                <p>📝 Transaction breakdown:</p>
                <p>1. Transfer 0.2% to treasury</p>
                <p>2. Swap 98.8% SOL → USDC</p>
                <p>3. Swap 1% SOL → RACE (reflection)</p>
                <p className="mt-2 text-yellow-300">⚠️ All steps happen atomically in one transaction</p>
              </div>
            </div>
          </Card>
        )}
        
        {!wallet.connected && (
          <Card className="p-12 bg-black/40 border-purple-500/30 backdrop-blur text-center">
            <p className="text-white text-lg mb-4">Connect your wallet to test the atomic swap</p>
            <WalletMultiButton />
          </Card>
        )}
      </div>
    </div>
  );
}
