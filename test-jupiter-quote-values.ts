import fetch from 'node-fetch';

async function checkJupiterQuote() {
  console.log('🔍 Testing Jupiter quote values...\n');
  
  // Get a quote with 2.9% slippage
  const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
  url.searchParams.set('inputMint', 'So11111111111111111111111111111111111111112');
  url.searchParams.set('outputMint', 't3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump');
  url.searchParams.set('amount', '100000000');
  url.searchParams.set('slippageBps', '290'); // 2.9%
  url.searchParams.set('maxAccounts', '28');
  
  const res = await fetch(url.toString());
  const quote = await res.json();
  
  console.log('Jupiter Quote Response:');
  console.log('  slippageBps:', quote.slippageBps);
  console.log('  outAmount:', quote.outAmount);
  console.log('  otherAmountThreshold:', quote.otherAmountThreshold);
  
  if (quote.otherAmountThreshold) {
    const out = BigInt(quote.outAmount);
    const threshold = BigInt(quote.otherAmountThreshold);
    const diff = out - threshold;
    const pct = (Number(diff) * 100) / Number(out);
    console.log(`\n  Calculated slippage: ${pct.toFixed(2)}% (${diff} tokens)`);
  } else {
    console.log('\n  ⚠️ WARNING: otherAmountThreshold is missing!');
  }
}

checkJupiterQuote().catch(err => console.error('Error:', err.message));
