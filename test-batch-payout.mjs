import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import Decimal from 'decimal.js';

// Load environment variables
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://spring-cold-tree.solana-mainnet.quiknode.pro/24011188359c3607a1ed91ac2ecbfe22b8e39681/';

if (!ESCROW_PRIVATE_KEY) {
  throw new Error('ESCROW_PRIVATE_KEY environment variable is required');
}

// Initialize escrow keypair
const escrowKeypair = Keypair.fromSecretKey(bs58.decode(ESCROW_PRIVATE_KEY));
const connection = new Connection(RPC_URL, 'confirmed');

console.log('🔐 Escrow wallet:', escrowKeypair.publicKey.toString());

// Test payout recipients (replace with actual winner wallets from recent settled races)
const testPayouts = [
  // Add test wallet addresses here - these should be wallets that won in recent races
  // For now, let's just test with treasury wallet to validate the send mechanism
];

async function sendSolBatch(payouts) {
  console.log('\n📤 Starting batch SOL payout test...\n');
  
  // Get escrow balance
  const balance = await connection.getBalance(escrowKeypair.publicKey);
  const balanceSol = new Decimal(balance).div(LAMPORTS_PER_SOL);
  console.log(`💰 Escrow balance: ${balanceSol.toString()} SOL\n`);
  
  if (payouts.length === 0) {
    console.log('⚠️  No payouts to send. Add test recipient addresses first.');
    return;
  }
  
  // Send to each recipient
  for (const { wallet, amount } of payouts) {
    try {
      const recipientPubkey = new PublicKey(wallet);
      const lamports = new Decimal(amount).mul(LAMPORTS_PER_SOL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
      
      console.log(`📤 Sending ${amount} SOL to ${wallet}...`);
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: escrowKeypair.publicKey,
          toPubkey: recipientPubkey,
          lamports: BigInt(lamports.toString())
        })
      );
      
      const signature = await connection.sendTransaction(transaction, [escrowKeypair]);
      await connection.confirmTransaction(signature, 'confirmed');
      
      console.log(`✅ Sent ${amount} SOL to ${wallet}`);
      console.log(`   Signature: ${signature}\n`);
      
    } catch (error) {
      console.error(`❌ Failed to send to ${wallet}:`, error.message);
    }
  }
  
  // Final balance
  const finalBalance = await connection.getBalance(escrowKeypair.publicKey);
  const finalBalanceSol = new Decimal(finalBalance).div(LAMPORTS_PER_SOL);
  console.log(`\n💰 Final escrow balance: ${finalBalanceSol.toString()} SOL`);
}

// Test with treasury wallet first to validate mechanism
const TREASURY_WALLET = process.env.TREASURY_WALLET || 'Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L';

console.log('\n🧪 Testing batch payout mechanism...');
console.log('Note: This will send 0.01 SOL to treasury wallet as a test\n');

sendSolBatch([
  { wallet: TREASURY_WALLET, amount: '0.01' }
]).catch(console.error);
