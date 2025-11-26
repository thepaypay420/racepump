import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { buildRaceswapPlan } from "../server/raceswap";
import { buildRaceswapTransaction } from "../client/src/lib/raceswap";
import { connection } from "../server/solana";
import bs58 from "bs58";

async function executeRaceswapTest() {
  console.log("🧪 EXECUTING REAL RACESWAP ON MAINNET\n");

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

  console.log("🔄 Step 1: Building swap plan (0.05 SOL → $RACE WITHOUT reflections for size test)...");
  console.log("⚠️  Testing without reflections first to verify CPI fix works\n");
  
  const plan = await buildRaceswapPlan({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump",
    totalAmount: "50000000", // 0.05 SOL
    slippageBps: 500,
    disableReflection: true, // Disable for tx size
  });

  console.log("✅ Plan built:");
  console.log("  - Reflection leg:", plan.reflectionLeg ? "✅" : "❌");
  console.log("  - Main leg:", plan.mainLeg ? "✅" : "❌");
  console.log("  - Total accounts:", plan.accountMetas?.length || 0);

  console.log("\n🔄 Step 2: Building transaction...");
  
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

  console.log("\n🔄 Step 3: Signing transaction...");
  transaction.sign([escrowKeypair]);
  console.log("✅ Transaction signed");

  console.log("\n🚀 Step 4: Sending transaction to mainnet...");
  console.log("⏳ This will test if the CPI fix works...\n");

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
      
      // Check for specific error codes
      const errStr = JSON.stringify(confirmation.value.err);
      if (errStr.includes("0x1789")) {
        console.log("\n🔴 ERROR 0x1789: Slippage tolerance exceeded");
        console.log("This means the CPI fix did NOT work - Jupiter is still rejecting the transaction");
      } else if (errStr.includes("0x0")) {
        console.log("\n🔴 Program error - check transaction logs");
      }
      
      throw new Error("Transaction failed: " + errStr);
    }

    console.log("\n✅ TRANSACTION CONFIRMED!");
    console.log("🎉 RACESWAP CPI FIX VERIFIED - SWAP EXECUTED SUCCESSFULLY!");
    console.log("\n📊 Transaction details:");
    console.log("  - Signature:", signature);
    console.log("  - Explorer:", `https://solscan.io/tx/${signature}`);
    console.log("\n✨ The 0x1789 error is FIXED - Jupiter CPI is working correctly!");

    return signature;
  } catch (error: any) {
    console.log("\n❌ TRANSACTION ERROR:");
    
    const errorMsg = error?.message || String(error);
    console.log(errorMsg);
    
    if (errorMsg.includes("0x1789")) {
      console.log("\n🔴 ERROR 0x1789 DETECTED");
      console.log("The CPI fix did NOT work - still getting slippage errors");
    } else if (errorMsg.includes("blockhash")) {
      console.log("\n⚠️  Blockhash expired - transaction took too long");
    } else if (errorMsg.includes("insufficient")) {
      console.log("\n⚠️  Insufficient funds");
    }
    
    throw error;
  }
}

executeRaceswapTest()
  .then((sig) => {
    console.log("\n✅ TEST COMPLETE - Signature:", sig);
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ TEST FAILED");
    console.error(error);
    process.exit(1);
  });
