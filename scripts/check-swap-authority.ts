import { buildRaceswapPlan } from "../server/raceswap";

async function checkSwapAuthority() {
  console.log("Checking swap authority in remaining accounts...\n");

  const plan = await buildRaceswapPlan({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump",
    totalAmount: "50000000",
    slippageBps: 500,
    disableReflection: true,
  });

  console.log("Swap authority:", plan.swapAuthority);
  console.log("\nIs swap authority in remaining accounts?");
  
  const indices: number[] = [];
  plan.accounts.forEach((acc, i) => {
    if (acc === plan.swapAuthority) {
      indices.push(i);
    }
  });

  if (indices.length === 0) {
    console.log("❌ NO - swap_authority is NOT in remaining_accounts!");
    console.log("This is the problem - the Rust program expects it but it's not there!");
  } else {
    console.log(`✅ YES - Found at ${indices.length} positions:`, indices);
    indices.forEach(idx => {
      console.log(`  [${idx}] isSigner: ${plan.accountMetas[idx].isSigner}, isWritable: ${plan.accountMetas[idx].isWritable}`);
    });
  }
}

checkSwapAuthority().catch(console.error);
