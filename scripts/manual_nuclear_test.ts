import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { buildRaceswapPlan } from "../server/raceswap";
import { buildRaceswapTransaction } from "../client/src/lib/raceswap";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

// CONFIGURATION
const RPC_URL = process.env.VITE_RPC_URL || "https://api.mainnet-beta.solana.com";
// Default to the path you provided, but allow override via env var
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || "/home/thepaypay/.config/solana/escrow.json";

async function main() {
    console.log("🚀 Starting NUCLEAR RACESWAP Test...");

    // 1. Load Wallet
    let keypair: Keypair;
    try {
        // Priority: 1. Env Var PRIVATE_KEY, 2. File at KEYPAIR_PATH
        if (process.env.PRIVATE_KEY) {
             keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
        } else if (fs.existsSync(KEYPAIR_PATH)) {
            console.log(`Loading key from ${KEYPAIR_PATH}...`);
            const fileContent = fs.readFileSync(KEYPAIR_PATH, "utf8").trim();
            // Try JSON array first (standard solana-keygen format)
            try {
                 const arr = JSON.parse(fileContent);
                 keypair = Keypair.fromSecretKey(new Uint8Array(arr));
            } catch {
                // Fallback to base58 string
                keypair = Keypair.fromSecretKey(bs58.decode(fileContent));
            }
        } else {
            throw new Error(`Keypair not found at ${KEYPAIR_PATH} and PRIVATE_KEY env not set`);
        }
    } catch (e) {
        console.error("❌ Failed to load wallet:", e);
        console.log("\n👉 USAGE OPTION 1 (File):");
        console.log("   export KEYPAIR_PATH=/path/to/your/id.json");
        console.log("   npx tsx scripts/manual_nuclear_test.ts");
        console.log("\n👉 USAGE OPTION 2 (Env):");
        console.log("   export PRIVATE_KEY=5M...base58...");
        console.log("   npx tsx scripts/manual_nuclear_test.ts");
        process.exit(1);
    }

    console.log(`🔑 Wallet: ${keypair.publicKey.toBase58()}`);

    const connection = new Connection(RPC_URL, "confirmed");
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`💰 Balance: ${balance / 1e9} SOL`);

    if (balance < 0.15 * 1e9) {
        console.warn("⚠️  WARNING: Low balance. Transaction might fail due to fees.");
    }

    // 2. Define Swap Parameters
    const inputMint = "So11111111111111111111111111111111111111112"; // SOL
    const outputMint = "t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump"; // Main Token
    const reflectionMint = "Cwq13pofafd7KNbWBabULgt7QC1w53NjiPgES49Ypump"; // Reflection Token
    const amount = "100000000"; // 0.1 SOL

    try {
        // 3. Build Plan with NUCLEAR Settings
        console.log("\n📋 Building NUCLEAR Plan...");
        console.log(`   Input: 0.1 SOL -> Main: ${outputMint.slice(0,4)}... / Refl: ${reflectionMint.slice(0,4)}...`);
        
        const plan = await buildRaceswapPlan({
            inputMint,
            outputMint,
            totalAmount: amount,
            slippageBps: 5000, // 50% slippage (Nuclear)
            forceNuclear: true, // <--- ENABLE NUCLEAR MODE
            reflectionMintOverride: reflectionMint // <--- FORCE REFLECTION MINT
        });

        console.log("✅ Plan Built Successfully:");
        console.log(`   - Main Leg: ${plan.mainLeg?.payload?.accounts?.length} accounts`);
        console.log(`   - Reflection Leg: ${plan.reflectionLeg?.payload?.accounts?.length || 0} accounts`);
        console.log(`   - Reflection Disabled: ${plan.disableReflection}`);
        console.log(`   - Min Out Main: ${plan.minMainOut}`);
        console.log(`   - Min Out Reflection: ${plan.minReflectionOut}`);

        // 4. Build Transaction
        console.log("\n🛠️  Building Transaction...");
        
        // Mock wallet adapter for the build function
        const mockWallet = {
            publicKey: keypair.publicKey,
            signTransaction: async (tx: any) => tx,
            signAllTransactions: async (txs: any[]) => txs,
        };

        const versionedTx = await buildRaceswapTransaction({
            plan,
            wallet: mockWallet as any,
            connection
        });

        // 5. Sign
        versionedTx.sign([keypair]);

        // 6. Simulate
        console.log("\n🔮 Simulating...");
        const simulation = await connection.simulateTransaction(versionedTx, { sigVerify: true });
        
        if (simulation.value.err) {
            console.error("❌ SIMULATION FAILED:", JSON.stringify(simulation.value, null, 2));
            if (simulation.value.logs) {
                console.log("\n📜 Logs:");
                simulation.value.logs.forEach(log => console.log(`   ${log}`));
            }
            process.exit(1);
        }
        console.log("✅ Simulation Passed!");
        console.log(`   Units Consumed: ${simulation.value.unitsConsumed}`);

        // 7. Send Live
        console.log("\n🚀 SENDING LIVE TRANSACTION...");
        const sig = await connection.sendTransaction(versionedTx, { 
            skipPreflight: false, // We already simulated
            maxRetries: 5,
            preflightCommitment: "confirmed"
        });

        console.log(`\n🎉 SUCCESS! Transaction Sent.`);
        console.log(`🔗 Signature: https://solscan.io/tx/${sig}`);
        console.log(`🔗 Jup.ag Check: https://jup.ag/swap/SOL-${outputMint}`);

    } catch (e: any) {
        console.error("\n❌ FAILED:", e.message);
        if (e.logs) {
            console.log("\n📜 Logs:");
            e.logs.forEach((log: string) => console.log(`   ${log}`));
        }
    }
}

main();
