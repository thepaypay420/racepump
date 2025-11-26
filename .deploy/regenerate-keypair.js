const { Keypair } = require('@solana/web3.js');
const fs = require('fs');

const keypair = Keypair.generate();
const keypairArray = Array.from(keypair.secretKey);
fs.writeFileSync('.deploy/raceswap-deployer.json', JSON.stringify(keypairArray, null, 2));
console.log('Generated new deployer keypair:', keypair.publicKey.toBase58());
