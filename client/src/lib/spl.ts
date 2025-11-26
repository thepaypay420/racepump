import { PublicKey, TransactionInstruction, AccountMeta } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

function encodeU64LE(amount: bigint | number): Uint8Array {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount);
  const arrayBuffer = new ArrayBuffer(8);
  const view = new DataView(arrayBuffer);
  view.setBigUint64(0, value, true);
  return new Uint8Array(arrayBuffer);
}

export function createTransferCheckedInstructionManual(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint | number,
  decimals: number,
  multiSigners: PublicKey[] = []
): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
    ...multiSigners.map(s => ({ pubkey: s, isSigner: true, isWritable: false }))
  ];

  const data = new Uint8Array(1 + 8 + 1);
  data[0] = 12; // TransferChecked instruction discriminator
  data.set(encodeU64LE(amount), 1);
  data[9] = (decimals >>> 0) & 0xff;

  return new TransactionInstruction({
    keys,
    programId: TOKEN_PROGRAM_ID,
    data
  });
}

