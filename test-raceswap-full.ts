import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildRaceswapTransaction } from './client/src/lib/raceswap';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY!;

async function executeRaceswap() {
  console.log('🚀 Executing LIVE Raceswap Transaction on Mainnet...\n');

  const escrowKeypair = Keypair.fromSecretKey(bs58.decode(ESCROW_PRIVATE_KEY));
  console.log(`✅ Wallet: ${escrowKeypair.publicKey.toString()}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  
  const balance = await connection.getBalance(escrowKeypair.publicKey);
  console.log(`💰 Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  // Fetch plan from server
  console.log('📋 Fetching raceswap plan...');
  const planRes = await fetch('http://localhost:5000/api/raceswap/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 't3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump',
      amount: '100000000',
      slippageBps: 1500,
      disableReflection: false
    })
  });

  const plan = await planRes.json();
  console.log(`✅ Plan received (expires in ${Math.floor((plan.quoteExpiresAt - Date.now()) / 1000)}s)`);
  console.log(`   Main: ${(plan.mainAmount / 1e9).toFixed(4)} SOL → ${plan.minMainOut} tokens (min)`);
  console.log(`   Reflection: ${(plan.reflectionAmount / 1e9).toFixed(6)} SOL → ${plan.minReflectionOut} tokens (min)\n`);

  // Build transaction
  console.log('🔧 Building transaction...');
  const mockWallet = {
    publicKey: escrowKeypair.publicKey,
    signTransaction: async (tx: VersionedTransaction) => {
      tx.sign([escrowKeypair]);
      return tx;
    },
    signAllTransactions: async (txs: VersionedTransaction[]) => {
      txs.forEach(tx => tx.sign([escrowKeypair]));
      return txs;
    }
  };

  const tx = await buildRaceswapTransaction({
    plan,
    wallet: mockWallet as any,
    connection
  });
  console.log('✅ Transaction built');

  // Sign the transaction before sending
  console.log('✍️  Signing transaction...');
  tx.sign([escrowKeypair]);
  console.log('✅ Transaction signed\n');

  // Send transaction
  console.log('📤 Sending transaction to Solana...');
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  
  console.log(`✅ Transaction sent: ${signature}`);
  console.log(`🔗 https://solscan.io/tx/${signature}\n`);

  // Wait for confirmation
  console.log('⏳ Waiting for confirmation...');
  const confirmation = await connection.confirmTransaction(signature, 'confirmed');
  
  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  console.log('✅ TRANSACTION CONFIRMED!');
  console.log(`\n🎉 Raceswap successful!`);
  console.log(`   Signature: ${signature}`);
  console.log(`   View on Solscan: https://solscan.io/tx/${signature}`);
}

executeRaceswap().catch(err => {
  console.error('\n❌ Error:', err.message);
  if (err.logs) {
    console.error('\n📋 Transaction logs:');
    err.logs.forEach((log: string) => console.error(`   ${log}`));
  }
  process.exit(1);
});
