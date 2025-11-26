#!/usr/bin/env node
import https from 'https';

console.log('Testing network connectivity...\n');

// Test 1: Basic HTTPS
console.log('1. Testing HTTPS module...');
https.get('https://www.google.com', (res) => {
  console.log('✅ HTTPS works, status:', res.statusCode);
  
  // Test 2: Jupiter API
  console.log('\n2. Testing Jupiter API...');
  https.get('https://quote-api.jup.ag/v6/tokens', (res) => {
    console.log('✅ Jupiter API reachable, status:', res.statusCode);
    process.exit(0);
  }).on('error', (err) => {
    console.error('❌ Jupiter API failed:', err.message);
    process.exit(1);
  });
}).on('error', (err) => {
  console.error('❌ HTTPS failed:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('\n❌ Timeout - network test failed');
  process.exit(1);
}, 10000);
