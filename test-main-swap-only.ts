import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildRaceswapTransaction } from './client/src/lib/raceswap';

const RPC_URL = process.env.RPC_URL!;
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY!;

async function testMainSwapOnly() {
  console.log('🧪 Testing MAIN swap only (reflection disabled)...\n');

  const escrowKeypair = Keypair.fromSecretKey(bs58.decode(ESCROW_PRIVATE_KEY));
  console.log(`✅ Wallet: ${escrowKeypair.publicKey.toString()}`);

  const connection = new Connection(RPC_URL, 'confirmed');

  // Fetch plan with reflection DISABLED
  console.log('📋 Fetching plan (reflection disabled, 2.9% slippage)...');
  const planRes = await fetch('http://localhost:5000/api/raceswap/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 't3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump',
      amount: '100000000',
      slippageBps: 290, // 2.9% like Jupiter site
      disableReflection: true // NO REFLECTION LEG
    })
  });

  const plan = await planRes.json();
  console.log('✅ Plan received');
  console.log(`   Main: ${(plan.mainAmount / 1e9).toFixed(4)} SOL`);
  console.log(`   Reflection disabled: ${plan.disableReflection}`);
  console.log(`   Min output: ${plan.minMainOut} tokens (2.9% slippage)\n`);

  // Build transaction
  console.log('🔧 Building transaction...');
  const mockWallet = {
    publicKey: escrowKeypair.publicKey,
    signTransaction: async (tx: any) => { tx.sign([escrowKeypair]); return tx; },
    signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.sign([escrowKeypair])); return txs; }
  };

  const tx = await buildRaceswapTransaction({ plan, wallet: mockWallet as any, connection });
  tx.sign([escrowKeypair]);
  console.log('✅ Transaction built and signed\n');

  // Send with skipPreflight
  console.log('📤 Sending to blockchain...');
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });
  
  console.log(`✅ Sent: ${signature}`);
  console.log(`🔗 https://solscan.io/tx/${signature}\n`);

  console.log('⏳ Waiting for confirmation...');
  const confirmation = await connection.confirmTransaction(signature, 'confirmed');
  
  if (confirmation.value.err) {
    console.error('❌ FAILED:', JSON.stringify(confirmation.value.err));
    process.exit(1);
  }

  console.log('✅ SUCCESS! Main swap worked with 2.9% slippage!');
}

testMainSwapOnly().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
