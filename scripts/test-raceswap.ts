import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { buildRaceswapPlan } from "../server/raceswap";
import { connection } from "../server/solana";
import bs58 from "bs58";

async function testRaceswap() {
  console.log("🧪 Testing raceswap on mainnet with escrow wallet...\n");

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

  console.log("🔄 Building swap plan: 0.05 SOL → $RACE (with reflections)...");
  
  const plan = await buildRaceswapPlan({
    inputMint: "So11111111111111111111111111111111111111112", // SOL
    outputMint: "t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump", // RACE
    totalAmount: "50000000", // 0.05 SOL
    slippageBps: 500, // 5% slippage
    disableReflection: false,
  });

  console.log("\n✅ Swap plan built successfully!");
  console.log("📊 Plan details:");
  console.log("  - Total account metas:", plan.accountMetas?.length || 0);
  console.log("  - Reflection leg:", plan.reflectionLeg ? "✅ Present" : "❌ Disabled");
  console.log("  - Main leg:", plan.mainLeg ? "✅ Present" : "❌ Missing");
  
  if (plan.reflectionLeg?.payload) {
    console.log("  - Reflection accounts:", plan.reflectionLeg.payload.accounts?.length || 0);
    console.log("  - Reflection is_writable array:", plan.reflectionLeg.payload.isWritable?.length || 0);
    console.log("  - Reflection is_signer array:", plan.reflectionLeg.payload.isSigner?.length || 0);
  }
  if (plan.mainLeg?.payload) {
    console.log("  - Main accounts:", plan.mainLeg.payload.accounts?.length || 0);
    console.log("  - Main is_writable array:", plan.mainLeg.payload.isWritable?.length || 0);
    console.log("  - Main is_signer array:", plan.mainLeg.payload.isSigner?.length || 0);
  }

  console.log("\n🚀 Plan generated successfully - ready to build transaction");
  console.log("✅ No errors during plan generation!");
  console.log("\n⚠️  Note: Actual transaction sending skipped in test mode");
  console.log("    To test fully, use the frontend to initiate a swap");
  
  return plan;
}

testRaceswap()
  .then(() => {
    console.log("\n✅ Test completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Test failed:");
    console.error(error);
    process.exit(1);
  });
