import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { buildRaceswapPlan } from "../server/raceswap";
import { buildRaceswapTransaction } from "../client/src/lib/raceswap";
import { connection } from "../server/solana";
import bs58 from "bs58";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function testRaceswapUSDC() {
  console.log("🧪 TESTING RACESWAP WITH SOL -> USDC (well-established pair)\n");

  const escrowPrivateKey = process.env.ESCROW_PRIVATE_KEY;
  if (!escrowPrivateKey) {
    throw new Error("ESCROW_PRIVATE_KEY not found");
  }

  const escrowKeypair = Keypair.fromSecretKey(bs58.decode(escrowPrivateKey));
  console.log("📍 Escrow wallet:", escrowKeypair.publicKey.toBase58());

  const balance = await connection.getBalance(escrowKeypair.publicKey);
  console.log("💰 SOL balance:", (balance / 1e9).toFixed(4), "SOL\n");

  if (balance < 50_000_000) {
    throw new Error("Insufficient SOL balance (need at least 0.05 SOL)");
  }

  console.log("🔄 Building swap plan (0.01 SOL → USDC for simpler route)...");
  
  const plan = await buildRaceswapPlan({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: USDC_MINT,
    totalAmount: "10000000", // 0.01 SOL - smaller for simpler route
    slippageBps: 500,
    disableReflection: true,
  });

  console.log("✅ Plan built - testing with USDC instead of RACE");
  console.log("  Main leg accounts:", plan.mainLeg?.payload?.accounts?.length);

  console.log("\n🔄 Building transaction...");
  
  const mockWallet = {
    publicKey: escrowKeypair.publicKey,
    signTransaction: async (tx: VersionedTransaction) => {
      tx.sign([escrowKeypair]);
      return tx;
    },
    signAllTransactions: async (txs: VersionedTransaction[]) => {
      txs.forEach(tx => tx.sign([escrowKeypair]));
      return txs;
    },
  };

  const transaction = await buildRaceswapTransaction({
    plan,
    connection,
    wallet: mockWallet as any,
  });

  console.log("✅ Transaction built");

  console.log("\n🔄 Signing transaction...");
  transaction.sign([escrowKeypair]);
  console.log("✅ Transaction signed");

  console.log("\n🚀 Sending transaction to mainnet...");

  try {
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    console.log("📡 Transaction sent! Signature:", signature);
    console.log("🔗 Explorer:", `https://solscan.io/tx/${signature}`);

    console.log("\n⏳ Waiting for confirmation...");
    const confirmation = await connection.confirmTransaction(signature, "confirmed");

    if (confirmation.value.err) {
      console.log("\n❌ TRANSACTION FAILED:");
      console.log(JSON.stringify(confirmation.value.err, null, 2));
      throw new Error("Transaction failed: " + JSON.stringify(confirmation.value.err));
    }

    console.log("\n✅ TRANSACTION CONFIRMED!");
    console.log("🎉 RACESWAP CPI WORKS WITH USDC!");
    console.log("\nThis means the issue is specific to the $RACE token or its liquidity pool.");

    return signature;
  } catch (error: any) {
    console.log("\n❌ TRANSACTION ERROR:");
    console.log(error.message || String(error));
    
    if (error.logs) {
      console.log("\n📋 Error logs:");
      error.logs.slice(-20).forEach((log: string) => console.log("  ", log));
    }
    
    throw error;
  }
}

testRaceswapUSDC()
  .then((sig) => {
    console.log("\n✅ TEST COMPLETE - Signature:", sig);
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ TEST FAILED");
    console.error(error);
    process.exit(1);
  });
