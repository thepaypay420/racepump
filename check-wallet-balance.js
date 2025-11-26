const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { getAccount } = require("@solana/spl-token");
const bs58 = require("bs58");

async function checkBalance() {
  try {
    const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(RPC_URL, "confirmed");
    
    // Load escrow keypair
    if (!process.env.ESCROW_PRIVATE_KEY) {
      console.log("ERROR: ESCROW_PRIVATE_KEY not set");
      return;
    }
    
    const secretKey = bs58.decode(process.env.ESCROW_PRIVATE_KEY);
    const escrowPubkey = require("@solana/web3.js").Keypair.fromSecretKey(secretKey).publicKey;
    
    console.log("Escrow Wallet:", escrowPubkey.toString());
    console.log("RPC Endpoint:", RPC_URL);
    console.log("---");
    
    // Check SOL balance
    const solBalance = await connection.getBalance(escrowPubkey);
    console.log("SOL Balance:", (solBalance / LAMPORTS_PER_SOL).toFixed(6), "SOL");
    
    // Check RACE token balance if RACE_MINT is set
    if (process.env.RACE_MINT) {
      try {
        const raceMint = new PublicKey(process.env.RACE_MINT);
        const { getAssociatedTokenAddress } = require("@solana/spl-token");
        const ata = await getAssociatedTokenAddress(raceMint, escrowPubkey);
        const tokenAccount = await getAccount(connection, ata);
        console.log("RACE Balance:", (Number(tokenAccount.amount) / 1e9).toFixed(2), "$RACE");
      } catch (e) {
        console.log("RACE Balance: No token account found or error:", e.message);
      }
    }
  } catch (error) {
    console.error("Error checking balance:", error.message);
  }
}

checkBalance();
