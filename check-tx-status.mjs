import { Connection } from '@solana/web3.js';
const RPC = process.env.RPC_URL;
const connection = new Connection(RPC, 'confirmed');
const sig = '63PWKiDCnWuXA3YhKzxVUoCgQY2SVeTN3Ac3993HquTwbYUQgkCwmrSwzKUb594iiJ2g3M66wE1ZwDWYaZFtS1Ct';

try {
  console.log('🔍 Checking transaction status...');
  const status = await connection.getSignatureStatus(sig);
  console.log('Status:', JSON.stringify(status.value, null, 2));
  
  if (status.value?.confirmationStatus) {
    console.log(`✅ Transaction ${status.value.confirmationStatus}`);
    if (status.value.err) {
      console.log('❌ Error:', JSON.stringify(status.value.err));
    } else {
      console.log('🎉 SUCCESS! Transaction confirmed with no errors!');
    }
  } else {
    console.log('⏳ Transaction not found or still pending');
  }
} catch (e) {
  console.error('Error:', e.message);
}
