import BN from "bn.js";
import { serialize } from "borsh";
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";

class SerializedInstruction {
  accounts_len: number;
  data: Uint8Array;

  constructor(fields: { accounts_len: number; data: Uint8Array }) {
    this.accounts_len = fields.accounts_len;
    this.data = fields.data;
  }
}

class ExecuteRaceswapParams {
  input_mint: Uint8Array;
  main_output_mint: Uint8Array;
  reflection_mint: Uint8Array;
  total_input_amount: BN;
  min_main_out: BN;
  min_reflection_out: BN;
  disable_reflection: number;
  main_leg: SerializedInstruction | null;
  reflection_leg: SerializedInstruction | null;

  constructor(fields: {
    input_mint: PublicKey;
    main_output_mint: PublicKey;
    reflection_mint: PublicKey;
    total_input_amount: BN;
    min_main_out: BN;
    min_reflection_out: BN;
    disable_reflection: boolean;
    main_leg: SerializedInstruction | null;
    reflection_leg: SerializedInstruction | null;
  }) {
    this.input_mint = fields.input_mint.toBytes();
    this.main_output_mint = fields.main_output_mint.toBytes();
    this.reflection_mint = fields.reflection_mint.toBytes();
    this.total_input_amount = fields.total_input_amount;
    this.min_main_out = fields.min_main_out;
    this.min_reflection_out = fields.min_reflection_out;
    this.disable_reflection = fields.disable_reflection ? 1 : 0;
    this.main_leg = fields.main_leg;
    this.reflection_leg = fields.reflection_leg;
  }
}

const schema = new Map<any, any>([
  [
    SerializedInstruction,
    {
      kind: "struct",
      fields: [
        ["accounts_len", "u16"],
        ["data", ["u8"]],
      ],
    },
  ],
  [
    ExecuteRaceswapParams,
    {
      kind: "struct",
      fields: [
        ["input_mint", [32]],
        ["main_output_mint", [32]],
        ["reflection_mint", [32]],
        ["total_input_amount", "u64"],
        ["min_main_out", "u64"],
        ["min_reflection_out", "u64"],
        ["disable_reflection", "u8"],
        ["main_leg", { kind: "option", type: SerializedInstruction }],
        ["reflection_leg", { kind: "option", type: SerializedInstruction }],
      ],
    },
  ],
]);

function discriminator(ix: string): Buffer {
  const hash = sha256(Buffer.from(`global:${ix}`));
  return Buffer.from(hash).subarray(0, 8);
}

function encodeExecuteRaceswap(params: ExecuteRaceswapParams): Buffer {
  const argsBuffer = Buffer.from(serialize(schema, params));
  return Buffer.concat([discriminator("execute_raceswap"), argsBuffer]);
}

function main() {
  const sampleMainLeg = new SerializedInstruction({
    accounts_len: 4,
    data: new Uint8Array([1, 2, 3, 4, 5, 6]),
  });

  const sampleReflectionLeg = new SerializedInstruction({
    accounts_len: 3,
    data: new Uint8Array([9, 8, 7, 6]),
  });

  const params = new ExecuteRaceswapParams({
    input_mint: new PublicKey("So11111111111111111111111111111111111111112"),
    main_output_mint: new PublicKey("Es9vMFrzaCERZ5Yj5BLtVPRpgd81pQAb9Y8p9RV4bG9x"),
    reflection_mint: new PublicKey("7vfCXTUXF1VbzzcQq87dyGzvHGQB1b9DsqPQbEEkU3wP"),
    total_input_amount: new BN("123456789"),
    min_main_out: new BN("11111111"),
    min_reflection_out: new BN("22222222"),
    disable_reflection: false,
    main_leg: sampleMainLeg,
    reflection_leg: sampleReflectionLeg,
  });

  const encoded = encodeExecuteRaceswap(params);
  console.log("Borsh encoder bytes:", encoded.toString("hex"));
  console.log("Borsh encoder base64:", encoded.toString("base64"));
  console.log("Total bytes:", encoded.length);
}

main();
