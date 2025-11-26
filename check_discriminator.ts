import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";

function getInstructionDiscriminator(ixName: string): Buffer {
  const preimage = Buffer.from(`global:${ixName}`);
  const hash = sha256(preimage);
  return Buffer.from(hash).subarray(0, 8);
}

const d = getInstructionDiscriminator("execute_raceswap");
console.log("Discriminator:", d.toString('hex'));
