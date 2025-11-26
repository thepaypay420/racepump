import { buildRaceswapPlan } from "../server/raceswap";

async function debugAccounts() {
  console.log("🔍 Debugging raceswap account flags...\n");

  const plan = await buildRaceswapPlan({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump",
    totalAmount: "50000000",
    slippageBps: 500,
    disableReflection: true,
  });

  console.log("Main leg accounts:");
  plan.mainLeg?.payload?.accounts?.forEach((acc, i) => {
    const isW = plan.mainLeg?.payload?.isWritable?.[i];
    const isS = plan.mainLeg?.payload?.isSigner?.[i];
    console.log(`  [${i}] ${acc.substring(0, 8)}... W:${isW} S:${isS}`);
  });

  console.log("\nSwap authority:", plan.swapAuthority);
  console.log("Checking if swap authority is in accounts:");
  const swapAuthIdx = plan.mainLeg?.payload?.accounts?.findIndex(
    acc => acc === plan.swapAuthority
  );
  console.log("  Index:", swapAuthIdx);
  if (swapAuthIdx !== undefined && swapAuthIdx >= 0) {
    console.log(`  Flags at index ${swapAuthIdx}:`);
    console.log(`    isWritable: ${plan.mainLeg?.payload?.isWritable?.[swapAuthIdx]}`);
    console.log(`    isSigner: ${plan.mainLeg?.payload?.isSigner?.[swapAuthIdx]}`);
  }
}

debugAccounts().catch(console.error);
