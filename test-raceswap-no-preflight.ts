import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildRaceswapTransaction } from './client/src/lib/raceswap';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY!;

async function executeRaceswap() {
  console.log('🚀 Executing Raceswap WITHOUT preflight (bypass simulation)...\n');

  const escrowKeypair = Keypair.fromSecretKey(bs58.decode(ESCROW_PRIVATE_KEY));
  console.log(`✅ Wallet: ${escrowKeypair.publicKey.toString()}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  
  const balance = await connection.getBalance(escrowKeypair.publicKey);
  console.log(`💰 Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  // Fetch plan
  console.log('📋 Fetching raceswap plan...');
  const planRes = await fetch('http://localhost:5000/api/raceswap/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 't3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump',
      amount: '100000000',
      slippageBps: 5000, // 50%
      disableReflection: false
    })
  });

  const plan = await planRes.json();
  console.log('✅ Plan received\n');

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

  // Sign
  console.log('✍️  Signing...');
  tx.sign([escrowKeypair]);
  console.log('✅ Signed\n');

  // Send WITHOUT preflight check
  console.log('📤 Sending to blockchain (skipping simulation)...');
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,  // BYPASS SIMULATION - send directly to chain
    maxRetries: 3
  });
  
  console.log(`✅ Transaction sent: ${signature}`);
  console.log(`🔗 https://solscan.io/tx/${signature}\n`);

  // Wait for confirmation
  console.log('⏳ Waiting for onchain confirmation...');
  const confirmation = await connection.confirmTransaction(signature, 'confirmed');
  
  if (confirmation.value.err) {
    console.error('❌ Transaction FAILED onchain:', JSON.stringify(confirmation.value.err));
    process.exit(1);
  }

  console.log('✅ TRANSACTION CONFIRMED ONCHAIN!');
  console.log(`\n🎉 Raceswap SUCCESSFUL!`);
  console.log(`   Signature: ${signature}`);
}

executeRaceswap().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
