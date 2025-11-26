import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

const file = path.resolve('data', 'escrow-keypair.b58');
fs.mkdirSync(path.dirname(file), { recursive: true });

let oldEscrowPubkey = null;
let oldSecretB58 = null;
if (fs.existsSync(file) && fs.statSync(file).size > 0) {
  oldSecretB58 = fs.readFileSync(file, 'utf8').trim();
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(oldSecretB58));
    oldEscrowPubkey = kp.publicKey.toString();
  } catch {}
}

const newKp = Keypair.generate();
const newSecretB58 = bs58.encode(newKp.secretKey);
fs.writeFileSync(file, newSecretB58, { mode: 0o600 });

const result = {
  oldEscrowPubkey,
  newEscrowPubkey: newKp.publicKey.toString(),
  newEscrowPrivateKeyB58: newSecretB58
};

console.log(JSON.stringify(result, null, 2));
