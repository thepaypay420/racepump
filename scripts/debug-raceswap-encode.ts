import BN from "bn.js";
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";

type SerializedInstructionPayload = {
  accountsLen: number;
  data: Uint8Array;
};

function getInstructionDiscriminator(ixName: string): Buffer {
  const preimage = Buffer.from(`global:${ixName}`);
  const hash = sha256(preimage);
  return Buffer.from(hash).subarray(0, 8);
}

const EXECUTE_RACESWAP_DISCRIMINATOR = getInstructionDiscriminator("execute_raceswap");

function bnToU64LE(value: BN): Buffer {
  return value.toArrayLike(Buffer, "le", 8);
}

function pubkeyToBuffer(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}

function encodeSerializedInstructionPayload(payload: SerializedInstructionPayload): Buffer {
  if (payload.accountsLen < 0 || payload.accountsLen > 0xffff) {
    throw new Error(`Invalid accountsLen ${payload.accountsLen}`);
  }
  const accountsLenBuf = Buffer.alloc(2);
  accountsLenBuf.writeUInt16LE(payload.accountsLen, 0);

  const dataBuffer = Buffer.from(payload.data);
  const dataLenBuf = Buffer.alloc(4);
  dataLenBuf.writeUInt32LE(dataBuffer.length, 0);

  return Buffer.concat([accountsLenBuf, dataLenBuf, dataBuffer]);
}

function encodeOption<T>(
  value: T | null | undefined,
  encoder: (val: T) => Buffer
): Buffer {
  if (value === null || value === undefined) {
    return Buffer.from([0]);
  }
  return Buffer.concat([Buffer.from([1]), encoder(value)]);
}

function encodeExecuteRaceswapArgs(args: {
  inputMint: PublicKey;
  mainOutputMint: PublicKey;
  reflectionMint: PublicKey;
  totalInputAmount: BN;
  minMainOut: BN;
  minReflectionOut: BN;
  disableReflection: boolean;
  mainLeg: SerializedInstructionPayload;
  reflectionLeg?: SerializedInstructionPayload | null;
}): Buffer {
  return Buffer.concat([
    pubkeyToBuffer(args.inputMint),
    pubkeyToBuffer(args.mainOutputMint),
    pubkeyToBuffer(args.reflectionMint),
    bnToU64LE(args.totalInputAmount),
    bnToU64LE(args.minMainOut),
    bnToU64LE(args.minReflectionOut),
    Buffer.from([args.disableReflection ? 1 : 0]),
    encodeOption(args.mainLeg, encodeSerializedInstructionPayload),
    encodeOption(args.reflectionLeg ?? null, encodeSerializedInstructionPayload),
  ]);
}

function buildExecuteRaceswapData(args: {
  inputMint: PublicKey;
  mainOutputMint: PublicKey;
  reflectionMint: PublicKey;
  totalInputAmount: BN;
  minMainOut: BN;
  minReflectionOut: BN;
  disableReflection: boolean;
  mainLeg: SerializedInstructionPayload;
  reflectionLeg?: SerializedInstructionPayload | null;
}): Buffer {
  return Buffer.concat([
    EXECUTE_RACESWAP_DISCRIMINATOR,
    encodeExecuteRaceswapArgs(args),
  ]);
}

function main() {
  const sample = {
    inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
    mainOutputMint: new PublicKey("Es9vMFrzaCERZ5Yj5BLtVPRpgd81pQAb9Y8p9RV4bG9x"), // USDT
    reflectionMint: new PublicKey("7vfCXTUXF1VbzzcQq87dyGzvHGQB1b9DsqPQbEEkU3wP"), // WETH (example)
    totalInputAmount: new BN("123456789"),
    minMainOut: new BN("11111111"),
    minReflectionOut: new BN("22222222"),
    disableReflection: false,
    mainLeg: {
      accountsLen: 4,
      data: new Uint8Array([1, 2, 3, 4, 5, 6]),
    },
    reflectionLeg: {
      accountsLen: 3,
      data: new Uint8Array([9, 8, 7, 6]),
    },
  };

  const data = buildExecuteRaceswapData(sample);
  console.log("Manual encoder bytes:", data.toString("hex"));
  console.log("Manual encoder base64:", data.toString("base64"));
  console.log("Total bytes:", data.length);
}

main();
