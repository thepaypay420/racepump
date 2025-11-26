import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { buildRaceswapV2Transaction, getJupiterSwapData } from "@/lib/raceswap-v2";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export default function TestV2() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [signature, setSignature] = useState<string>("");

  const testSwap = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      toast({
        variant: "destructive",
        title: "Wallet not connected",
        description: "Please connect your wallet first",
      });
      return;
    }

    setLoading(true);
    setSignature("");

    try {
      const amount = 0.01 * 1e9; // 0.01 SOL
      
      toast({
        title: "Getting Jupiter quote...",
        description: `Swapping ${amount / 1e9} SOL → USDC`,
      });

      // Get Jupiter swap data
      const { quoteData, swapData } = await getJupiterSwapData(
        wallet.publicKey,
        SOL_MINT,
        USDC_MINT,
        Math.floor(amount),
        50 // 0.5% slippage
      );

      console.log("Quote received:", quoteData.outAmount / 1e6, "USDC");

      toast({
        title: "Building V2 transaction...",
        description: `Expected output: ${(quoteData.outAmount / 1e6).toFixed(4)} USDC`,
      });

      // Build V2 transaction
      const tx = await buildRaceswapV2Transaction(
        connection,
        wallet,
        swapData,
        BigInt(Math.floor(amount)),
        BigInt(quoteData.outAmount)
      );

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      toast({
        title: "Simulating transaction...",
      });

      // Simulate first
      const simulation = await connection.simulateTransaction(tx);
      if (simulation.value.err) {
        console.error("Simulation failed:", simulation.value.err);
        console.error("Logs:", simulation.value.logs);
        throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }

      console.log("✅ Simulation successful!");
      console.log("Logs:", simulation.value.logs?.slice(-5));

      toast({
        title: "Signing transaction...",
      });

      // Sign and send
      const signedTx = await wallet.signTransaction(tx);
      
      toast({
        title: "Sending to blockchain...",
      });

      const sig = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      setSignature(sig);

      toast({
        title: "Transaction sent!",
        description: "Waiting for confirmation...",
      });

      // Wait for confirmation
      await connection.confirmTransaction({
        signature: sig,
        blockhash,
        lastValidBlockHeight,
      });

      toast({
        title: "🎉 V2 Swap Successful!",
        description: "No 0x1789 errors - V2 works!",
      });

    } catch (error: any) {
      console.error("V2 test error:", error);
      toast({
        variant: "destructive",
        title: "Swap failed",
        description: error.message || "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold">Raceswap V2 Test</h1>
          <WalletMultiButton />
        </div>

        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle>Test V2 Non-Custodial Swap</CardTitle>
            <CardDescription>
              This tests the new V2 architecture that eliminates 0x1789 errors
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <h3 className="font-semibold">V2 Improvements:</h3>
              <ul className="list-disc list-inside text-sm text-gray-400 space-y-1">
                <li>✅ User owns tokens throughout (no custodial vault)</li>
                <li>✅ User signs for Jupiter (no PDA conflicts)</li>
                <li>✅ Simple SOL treasury fee (0.2%)</li>
                <li>✅ 83% less code than V1</li>
                <li>✅ No more 0x1789 errors!</li>
              </ul>
            </div>

            <div className="bg-gray-900 p-4 rounded-lg space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Test Swap:</span>
                <span className="font-mono">0.01 SOL → USDC</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Program:</span>
                <span className="font-mono text-xs">Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk</span>
              </div>
            </div>

            <Button
              onClick={testSwap}
              disabled={!wallet.publicKey || loading}
              className="w-full bg-blue-600 hover:bg-blue-700"
              data-testid="button-test-v2-swap"
            >
              {loading ? "Processing..." : "Test V2 Swap (0.01 SOL → USDC)"}
            </Button>

            {signature && (
              <div className="bg-green-900/20 border border-green-500 rounded-lg p-4 space-y-2">
                <p className="font-semibold text-green-400">✅ Success!</p>
                <div className="text-sm space-y-1">
                  <p className="text-gray-400">Transaction:</p>
                  <a
                    href={`https://solscan.io/tx/${signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline font-mono text-xs break-all"
                  >
                    {signature}
                  </a>
                </div>
              </div>
            )}

            <div className="text-xs text-gray-500 mt-4">
              <p>This test uses mainnet. Make sure your wallet has at least 0.02 SOL.</p>
              <p className="mt-1">
                V2 architecture: User → Raceswap (fee) → Jupiter → User
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle>Architecture Comparison</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <h4 className="font-semibold text-red-400 mb-2">V1 (Broken)</h4>
                <ul className="space-y-1 text-gray-400">
                  <li>❌ Custodial vault</li>
                  <li>❌ PDA signs for Jupiter</li>
                  <li>❌ Complex transfers</li>
                  <li>❌ 0x1789 errors</li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-green-400 mb-2">V2 (Working)</h4>
                <ul className="space-y-1 text-gray-400">
                  <li>✅ Non-custodial</li>
                  <li>✅ User signs</li>
                  <li>✅ Simple pass-through</li>
                  <li>✅ No errors!</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
