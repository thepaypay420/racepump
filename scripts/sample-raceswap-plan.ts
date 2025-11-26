import { buildRaceswapPlan } from "../server/raceswap";

async function main() {
  const inputMint = process.env.RACESWAP_INPUT_MINT || "So11111111111111111111111111111111111111112";
  const outputMint =
    process.env.RACESWAP_OUTPUT_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8dJd9HJ9pNyyDREQ"; // USDC
  const amount = process.env.RACESWAP_LAMPORTS || "10000000";
  const slippageBps = Number(process.env.RACESWAP_SLIPPAGE_BPS || 100);
  const disableReflection = process.env.RACESWAP_DISABLE_REFLECTION === "1";

  const plan = await buildRaceswapPlan({
    inputMint,
    outputMint,
    totalAmount: amount,
    slippageBps,
    disableReflection,
  });

  console.log(JSON.stringify(plan, null, 2));
}

main().catch((err) => {
  console.error("Failed to build plan:", err);
  process.exit(1);
});
