
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/**
 * This script verifies that the client-side manual encoding matches the expected Anchor serialization.
 * Use this to verify changes to the program or client encoding logic.
 * 
 * Usage: npx tsx scripts/verify-raceswap-encoding.ts
 */

// --- ENCODING LOGIC REPLICATED FROM client/src/lib/raceswap.ts ---

type SerializedInstructionPayload = {
  accountsLen: number;
  data: Uint8Array;
};

function getInstructionDiscriminator(ixName: string): Buffer {
  const preimage = Buffer.from(`global:${ixName}`);
  const hash = sha256(preimage);
  return Buffer.from(hash).subarray(0, 8);
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

function encodeSerializedInstructionPayload(payload: SerializedInstructionPayload): Buffer {
  const accountsLenBuf = Buffer.alloc(2);
  accountsLenBuf.writeUInt16LE(payload.accountsLen, 0);

  const dataBuffer = Buffer.from(payload.data);
  const dataLenBuf = Buffer.alloc(4);
  dataLenBuf.writeUInt32LE(dataBuffer.length, 0);

  return Buffer.concat([accountsLenBuf, dataLenBuf, dataBuffer]);
}

const EXECUTE_RACESWAP_DISCRIMINATOR = getInstructionDiscriminator("execute_raceswap");

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
  const encodedParams = Buffer.concat([
    args.inputMint.toBuffer(),
    args.mainOutputMint.toBuffer(),
    args.reflectionMint.toBuffer(),
    Buffer.from(args.totalInputAmount.toArrayLike(Uint8Array, "le", 8)),
    Buffer.from(args.minMainOut.toArrayLike(Uint8Array, "le", 8)),
    Buffer.from(args.minReflectionOut.toArrayLike(Uint8Array, "le", 8)),
    Buffer.from([args.disableReflection ? 1 : 0]),
    encodeOption(args.mainLeg, encodeSerializedInstructionPayload),
    encodeOption(args.reflectionLeg ?? null, encodeSerializedInstructionPayload),
  ]);

  return Buffer.concat([
    EXECUTE_RACESWAP_DISCRIMINATOR,
    encodedParams,
  ]);
}

// --- VERIFICATION ---

function main() {
    console.log("Verifying raceswap instruction encoding...");

    // Test values matching Rust test
    const inputMint = new PublicKey("So11111111111111111111111111111111111111112");
    const mainOutputMint = new PublicKey("Es9vMFrzaCERZ5Yj5BLtVPRpgd81pQAb9Y8p9RV4bG9x");
    const reflectionMint = new PublicKey("7vfCXTUXF1VbzzcQq87dyGzvHGQB1b9DsqPQbEEkU3wP");
    
    const totalInputAmount = new BN(123_456_789);
    const minMainOut = new BN(11_111_111);
    const minReflectionOut = new BN(22_222_222);
    const disableReflection = false;
    
    const mainLeg = {
        accountsLen: 4,
        data: new Uint8Array([1, 2, 3, 4, 5, 6])
    };
    
    const reflectionLeg = {
        accountsLen: 3,
        data: new Uint8Array([9, 8, 7, 6])
    };

    const data = buildExecuteRaceswapData({
        inputMint,
        mainOutputMint,
        reflectionMint,
        totalInputAmount,
        minMainOut,
        minReflectionOut,
        disableReflection,
        mainLeg,
        reflectionLeg
    });

    console.log("TS encoded hex:", data.toString("hex"));
    
    // Expected hex from Rust Anchor serialization (programs/raceswap/tests/encoder.rs)
    const expectedHex = "c163774098fe76bc069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001ce010e60afedb227156d70f15012f78bac3de597062a2ea079f99353b9ddd02366e5188a130364a5f33ac9a22d9bc17ce4626ec5c1c7c767919f7f2239cbace215cd5b0700000000c78aa900000000008e1553010000000000010400060000000102030405060103000400000009080706";
    
    if (data.toString("hex") === expectedHex) {
        console.log("SUCCESS: Encodings match! Client logic is consistent with Anchor program.");
    } else {
        console.error("FAILURE: Encodings differ!");
        console.error("Expected:", expectedHex);
        console.error("Actual:  ", data.toString("hex"));
        process.exit(1);
    }
}

main();
