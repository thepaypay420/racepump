import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildRaceswapTransaction } from './client/src/lib/raceswap';

const RPC_URL = process.env.RPC_URL!;
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY!;

async function finalSwapTest() {
  console.log('🚀 Final swap test with all fixes applied\n');

  const escrowKeypair = Keypair.fromSecretKey(bs58.decode(ESCROW_PRIVATE_KEY));
  const connection = new Connection(RPC_URL, 'confirmed');

  // Get FRESH plan with 3% slippage
  console.log('📋 Fetching fresh plan (3% slippage, reflection disabled)...');
  const planRes = await fetch('http://localhost:5000/api/raceswap/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 't3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump',
      amount: '100000000', // 0.1 SOL
      slippageBps: 300, // 3%
      disableReflection: true
    })
  });

  const plan = await planRes.json();
  const expiresIn = Math.floor((plan.quoteExpiresAt - Date.now()) / 1000);
  console.log(`✅ Plan received (expires in ${expiresIn}s)`);
  console.log(`   Amount: ${(plan.mainAmount / 1e9).toFixed(4)} SOL`);
  console.log(`   Min output: ${plan.minMainOut} tokens`);
  console.log(`   Slippage: 3%\n`);

  // Build and sign IMMEDIATELY
  console.log('🔧 Building transaction immediately...');
  const mockWallet = {
    publicKey: escrowKeypair.publicKey,
    signTransaction: async (tx: any) => { tx.sign([escrowKeypair]); return tx; },
    signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.sign([escrowKeypair])); return txs; }
  };

  const tx = await buildRaceswapTransaction({ plan, wallet: mockWallet as any, connection });
  tx.sign([escrowKeypair]);
  console.log('✅ Transaction built and signed\n');

  // Send immediately
  console.log('📤 Sending to blockchain...');
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  
  console.log(`✅ Sent: ${signature}`);
  console.log(`🔗 https://solscan.io/tx/${signature}\n`);

  console.log('⏳ Waiting for confirmation...');
  const confirmation = await connection.confirmTransaction(signature, 'confirmed');
  
  if (confirmation.value.err) {
    console.error('❌ FAILED:', JSON.stringify(confirmation.value.err));
    console.error('\nThis might be:');
    console.error('  - Quote expired (>15s between fetch and send)');
    console.error('  - Price moved >3% during execution');
    console.error('  - Token has transfer taxes');
    process.exit(1);
  }

  console.log('✅ ✅ ✅ SUCCESS! Raceswap confirmed!');
  console.log(`🎉 Transaction: https://solscan.io/tx/${signature}`);
}

finalSwapTest().catch(err => {
  console.error('❌ Error:', err.message);
  if (err.logs) {
    console.error('\nLogs:', err.logs.slice(-5).join('\n'));
  }
  process.exit(1);
});
