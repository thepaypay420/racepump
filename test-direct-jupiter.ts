import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const RPC_URL = process.env.RPC_URL!;
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY!;

async function testDirectJupiter() {
  console.log('🧪 Testing DIRECT Jupiter swap (no raceswap program)\n');

  const escrowKeypair = Keypair.fromSecretKey(bs58.decode(ESCROW_PRIVATE_KEY));
  const connection = new Connection(RPC_URL, 'confirmed');

  // Get Jupiter quote
  console.log('📋 Getting Jupiter quote (3% slippage)...');
  const quoteUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
  quoteUrl.searchParams.set('inputMint', 'So11111111111111111111111111111111111111112');
  quoteUrl.searchParams.set('outputMint', 't3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump');
  quoteUrl.searchParams.set('amount', '100000000');
  quoteUrl.searchParams.set('slippageBps', '300');

  const quoteRes = await fetch(quoteUrl.toString());
  const quote = await quoteRes.json();
  console.log(`✅ Quote: ${quote.outAmount} tokens (slippage: ${quote.slippageBps}bps)\n`);

  // Get swap transaction
  console.log('🔧 Building Jupiter swap transaction...');
  const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userPublicKey: escrowKeypair.publicKey.toString(),
      quoteResponse: quote,
      wrapAndUnwrapSol: true,
      dynamicSlippage: true,
      dynamicComputeUnitLimit: true
    })
  });

  const swap = await swapRes.json();
  const txBuffer = Buffer.from(swap.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuffer);
  
  // Sign and send
  tx.sign([escrowKeypair]);
  console.log('✅ Transaction signed\n');

  console.log('📤 Sending direct Jupiter swap...');
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  
  console.log(`✅ Sent: ${signature}`);
  console.log(`🔗 https://solscan.io/tx/${signature}\n`);

  console.log('⏳ Waiting for confirmation...');
  const confirmation = await connection.confirmTransaction(signature, 'confirmed');
  
  if (confirmation.value.err) {
    console.error('❌ Direct Jupiter swap FAILED:', JSON.stringify(confirmation.value.err));
    console.error('This means Jupiter itself is having issues with this token pair!');
    process.exit(1);
  }

  console.log('✅ ✅ ✅ DIRECT JUPITER SWAP SUCCESS!');
  console.log('This means the issue is with our raceswap program wrapper, not Jupiter!');
}

testDirectJupiter().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
