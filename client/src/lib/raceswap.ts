import BN from "bn.js";
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import type { RaceswapPlanResponse } from "@shared/raceswap";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  AccountMeta,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";

function validateTxKeys(label: string, instructions: TransactionInstruction[]): void {
  console.log("[raceswap] validateTxKeys:", label, "instructions =", instructions.length);

  instructions.forEach((ix, ixIndex) => {
    const prog = ix.programId as PublicKey | undefined;
    if (!prog || typeof (prog as any).toBase58 !== "function") {
      console.error("[raceswap] INVALID programId in instruction", ixIndex, ix.programId);
    } else {
      console.log(
        `[raceswap] ix[${ixIndex}] programId =`,
        prog.toBase58()
      );
    }

    ix.keys.forEach((key, keyIndex) => {
      const pk = key.pubkey as PublicKey | undefined;
      if (!pk || typeof (pk as any).toBase58 !== "function") {
        console.error(
          "[raceswap] INVALID key:",
          "ix", ixIndex,
          "key", keyIndex,
          key
        );
      } else {
        console.log(
          `[raceswap] ix[${ixIndex}] key[${keyIndex}]`,
          pk.toBase58(),
          "signer =", key.isSigner,
          "writable =", key.isWritable
        );
      }
    });
  });
}

const JUPITER_PROGRAM_ID_V7 = new PublicKey("JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJk");
const JUPITER_PROGRAM_ID_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const RACESWAP_PROGRAM_ID = new PublicKey("Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk");

/**
 * Strict PublicKey parser that handles all valid input types and provides detailed logging.
 * This is the ONLY function that should create PublicKey instances in the raceswap flow.
 */
function parsePubkeyStrict(label: string, value: any): PublicKey {
  // Already a PublicKey - return as-is
  if (value instanceof PublicKey) {
    console.debug("[raceswap] parsePubkeyStrict success (already PublicKey):", { label, pubkey: value.toBase58() });
    return value;
  }

  // Accept plain base58 string
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      console.error("[raceswap] parsePubkeyStrict failed - empty string:", { label, value });
      throw new Error(`[raceswap] Expected base58 string or PublicKey for ${label}, got empty string`);
    }
    try {
      const pk = new PublicKey(trimmed);
      console.debug("[raceswap] parsePubkeyStrict success:", { label, pubkey: pk.toBase58() });
      return pk;
    } catch (e: any) {
      console.error("[raceswap] parsePubkeyStrict failed for string:", {
        label,
        value: trimmed,
        error: e?.message ?? e,
      });
      throw new Error(`[raceswap] Failed to parse ${label} "${trimmed}": ${e?.message ?? e}`);
    }
  }

  // Anything else is invalid – this is what we want to catch
  console.error("[raceswap] parsePubkeyStrict invalid input:", {
    label,
    type: typeof value,
    value,
    isNull: value === null,
    isUndefined: value === undefined,
  });
  throw new Error(
    `[raceswap] Expected base58 string or PublicKey for ${label}, got ${typeof value}${value === null ? " (null)" : ""}${value === undefined ? " (undefined)" : ""}`
  );
}

const KNOWN_TOKEN_PROGRAM_IDS: PublicKey[] = [
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
].filter((program): program is PublicKey => Boolean(program));

const mintProgramIdCache = new Map<string, PublicKey>();

async function resolveMintTokenProgramId(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const cacheKey = mint.toBase58();
  const cached = mintProgramIdCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let accountInfo;
  try {
    accountInfo = await connection.getAccountInfo(mint, "confirmed");
  } catch (error) {
    console.error(`[raceswap] Failed to fetch account info for mint ${cacheKey}:`, error);
    throw new Error(`[raceswap] Unable to fetch mint metadata for ${cacheKey}`);
  }

  if (!accountInfo) {
    throw new Error(`[raceswap] Mint account not found on-chain: ${cacheKey}`);
  }

  const ownerProgramId = accountInfo.owner;
  const isKnownProgram = KNOWN_TOKEN_PROGRAM_IDS.some((program) =>
    program.equals(ownerProgramId)
  );

  if (!isKnownProgram) {
    console.warn(
      "[raceswap] Mint uses unexpected token program owner – proceeding with detected program.",
      {
        mint: cacheKey,
        owner: ownerProgramId.toBase58(),
      }
    );
  }

  mintProgramIdCache.set(cacheKey, ownerProgramId);
  return ownerProgramId;
}

/**
 * Helper to create AccountMeta objects with validation and logging.
 * Ensures all pubkeys are PublicKey instances.
 * CRITICAL: Forces swapAuthority to isSigner=false to prevent privilege escalation.
 */
function toAccountMetas(
  labelPrefix: string,
  pubkeys: PublicKey[],
  isSignerFlags?: boolean[],
  isWritableFlags?: boolean[],
  swapAuthority?: PublicKey
): AccountMeta[] {
  return pubkeys.map((pk, i) => {
    // Final validation - ensure pk is a PublicKey instance
    if (!(pk instanceof PublicKey)) {
      console.error("[raceswap] toAccountMetas: invalid pubkey", {
        label: `${labelPrefix}[${i}]`,
        type: typeof pk,
        value: pk,
      });
      throw new Error(
        `[raceswap] toAccountMetas: ${labelPrefix}[${i}] is not a PublicKey instance`
      );
    }

    // CRITICAL FIX: Force swapAuthority to NEVER be a signer in Jupiter's instruction
    // Even if Jupiter's quote marks it as signer, it cannot sign from the client
    const isSwapAuthority = swapAuthority && pk.equals(swapAuthority);
    const isSigner = isSwapAuthority ? false : (isSignerFlags?.[i] ?? false);

    const meta = {
      pubkey: pk,
      isSigner,
      isWritable: isWritableFlags?.[i] ?? true,
    };

    console.debug("[raceswap] accountMeta built:", {
      label: `${labelPrefix}[${i}]`,
      pubkey: pk.toBase58(),
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    });

    return meta;
  });
}

type SerializedInstructionPayload = {
  accountsLen: number;
  data: Uint8Array;
  isWritable: boolean[];
  isSigner: boolean[];
};

const EXECUTE_RACESWAP_DISCRIMINATOR = getInstructionDiscriminator("execute_raceswap");

function getInstructionDiscriminator(ixName: string): Buffer {
  const preimage = Buffer.from(`global:${ixName}`);
  const hash = sha256(preimage);
  return Buffer.from(hash).subarray(0, 8);
}

// Helper for manual encoding
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

  // Encode isWritable array (Vec<bool> in Rust)
  const isWritableLen = Buffer.alloc(4);
  isWritableLen.writeUInt32LE(payload.isWritable.length, 0);
  const isWritableData = Buffer.from(payload.isWritable.map(b => b ? 1 : 0));

  // Encode isSigner array (Vec<bool> in Rust)
  const isSignerLen = Buffer.alloc(4);
  isSignerLen.writeUInt32LE(payload.isSigner.length, 0);
  const isSignerData = Buffer.from(payload.isSigner.map(b => b ? 1 : 0));

  return Buffer.concat([
    accountsLenBuf, 
    dataLenBuf, 
    dataBuffer,
    isWritableLen,
    isWritableData,
    isSignerLen,
    isSignerData
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
  console.debug("[raceswap] Manual encoding of execute_raceswap data...");
  
  // Ensure Buffer is available (sanity check)
  if (typeof Buffer === 'undefined') {
     console.error("[raceswap] CRITICAL: Buffer is undefined during encoding!");
     throw new Error("Buffer is undefined");
  }

  try {
      const encodedParams = Buffer.concat([
        args.inputMint.toBuffer(),
        args.mainOutputMint.toBuffer(),
        args.reflectionMint.toBuffer(),
        Buffer.from(args.totalInputAmount.toArray("le", 8)),
        Buffer.from(args.minMainOut.toArray("le", 8)),
        Buffer.from(args.minReflectionOut.toArray("le", 8)),
        Buffer.from([args.disableReflection ? 1 : 0]),
        encodeOption(args.mainLeg, encodeSerializedInstructionPayload),
        encodeOption(args.reflectionLeg ?? null, encodeSerializedInstructionPayload),
      ]);

      const data = Buffer.concat([
        EXECUTE_RACESWAP_DISCRIMINATOR,
        encodedParams,
      ]);
      
      console.debug("[raceswap] Built instruction data (manual):", {
          discriminator: EXECUTE_RACESWAP_DISCRIMINATOR.toString("hex"),
          paramsHex: encodedParams.toString("hex"),
          totalLength: data.length
      });
      
      return data;
  } catch (e: any) {
      console.error("[raceswap] Manual encoding failed:", e);
      throw new Error(`Manual encoding failed: ${e.message || e}`);
  }
}


export async function buildRaceswapTransaction(opts: {
  plan: RaceswapPlanResponse;
  wallet: WalletContextState;
  connection: Connection;
}): Promise<VersionedTransaction> {
  const { plan, wallet, connection } = opts;
  
  // Log the plan at the start for debugging
  console.debug("[raceswap] buildRaceswapTransaction plan:", {
    inputMint: plan.inputMint,
    outputMint: plan.outputMint,
    reflectionMint: plan.reflectionMint,
    programId: plan.programId,
    configAddress: plan.configAddress,
    swapAuthority: plan.swapAuthority,
    inputVault: plan.inputVault,
    treasuryWallet: plan.treasuryWallet,
    jupiterProgramId: plan.jupiterProgramId,
    disableReflection: plan.disableReflection,
    hasMainLeg: !!plan.mainLeg,
    hasReflectionLeg: !!plan.reflectionLeg,
    accountsLength: plan.accounts?.length ?? 0,
    accountMetasLength: plan.accountMetas?.length ?? 0,
  });
  
  // Validate plan structure before processing
  if (!plan || typeof plan !== "object") {
    throw new Error("[raceswap] Invalid plan: plan is not an object");
  }
  
  // Validate required string fields
  const requiredStringFields = [
    { field: plan.inputMint, name: "inputMint" },
    { field: plan.outputMint, name: "outputMint" },
    { field: plan.programId, name: "programId" },
    { field: plan.configAddress, name: "configAddress" },
    { field: plan.swapAuthority, name: "swapAuthority" },
    { field: plan.inputVault, name: "inputVault" },
    { field: plan.treasuryWallet, name: "treasuryWallet" },
  ];
  
  for (const { field, name } of requiredStringFields) {
    if (!field || typeof field !== "string" || field.trim().length === 0) {
      console.error("[raceswap] Invalid plan: missing or invalid field", { name, value: field, type: typeof field });
      throw new Error(`[raceswap] Invalid plan: missing or malformed ${name}`);
    }
  }
  
  // Validate reflectionMint (can be undefined if reflection is disabled, but if present must be valid)
  if (plan.reflectionMint !== undefined && plan.reflectionMint !== null) {
    if (typeof plan.reflectionMint !== "string" || plan.reflectionMint.trim().length === 0) {
      console.error("[raceswap] Invalid plan: reflectionMint is invalid", { value: plan.reflectionMint });
      throw new Error("[raceswap] Invalid plan: reflectionMint must be a non-empty string if provided");
    }
  }
  
  // Normalize and validate mainLeg accounts
  if (!plan.mainLeg) {
    throw new Error("[raceswap] Invalid plan: mainLeg is required");
  }
  
  const rawMain = plan.mainLeg?.payload?.accounts ?? [];
  
  const mainLegAccounts: string[] = rawMain
    .filter((a: any) => a !== null && a !== undefined)
    .map((a: any) => {
      if (typeof a === "string") {
        return a.trim();
      } else if (a && typeof a === "object") {
        // Handle various object formats: { pubkey }, { address }, or PublicKey-like with toBase58()
        return (a.pubkey || a.address || (typeof a.toBase58 === "function" ? a.toBase58() : "") || "").trim();
      } else {
        throw new Error(`[raceswap] Invalid plan: mainLeg accounts contains invalid entry: ${JSON.stringify(a)}`);
      }
    })
    .filter((a: string) => a.length > 0); // Remove empty strings after normalization
  
  // Strict validation: no empty strings allowed
  if (mainLegAccounts.length === 0) {
    throw new Error("[raceswap] Invalid plan: mainLeg has no valid accounts");
  }
  
  for (let i = 0; i < mainLegAccounts.length; i++) {
    const v = mainLegAccounts[i];
    if (typeof v !== "string" || !v.trim()) {
      console.error("[raceswap] mainLegAccounts invalid entry", { index: i, value: v });
      throw new Error(`[raceswap] mainLegAccounts[${i}] must be a non-empty string`);
    }
  }
  
  // Normalize and validate reflectionLeg accounts if present
  const rawReflection = plan.reflectionLeg?.payload?.accounts ?? [];
  
  const reflectionLegAccounts: string[] = rawReflection
    .filter((a: any) => a !== null && a !== undefined)
    .map((a: any) => {
      if (typeof a === "string") {
        return a.trim();
      } else if (a && typeof a === "object") {
        // Handle various object formats: { pubkey }, { address }, or PublicKey-like with toBase58()
        return (a.pubkey || a.address || (typeof a.toBase58 === "function" ? a.toBase58() : "") || "").trim();
      } else {
        throw new Error(`[raceswap] Invalid plan: reflectionLeg accounts contains invalid entry: ${JSON.stringify(a)}`);
      }
    })
    .filter((a: string) => a.length > 0); // Remove empty strings after normalization
  
  // Strict validation: no empty strings allowed (only if reflection is enabled)
  if (!plan.disableReflection && reflectionLegAccounts.length === 0 && plan.reflectionLeg) {
    throw new Error("[raceswap] Invalid plan: reflectionLeg has no valid accounts");
  }
  
  for (let i = 0; i < reflectionLegAccounts.length; i++) {
    const v = reflectionLegAccounts[i];
    if (typeof v !== "string" || !v.trim()) {
      console.error("[raceswap] reflectionLegAccounts invalid entry", { index: i, value: v });
      throw new Error(`[raceswap] reflectionLegAccounts[${i}] must be a non-empty string`);
    }
  }
  
  // Convert validated account strings to PublicKey instances using parsePubkeyStrict
  const mainLegPubkeys = mainLegAccounts.map((v, i) =>
    parsePubkeyStrict(`mainLegAccounts[${i}]`, v)
  );

  const reflectionLegPubkeys = reflectionLegAccounts.map((v, i) =>
    parsePubkeyStrict(`reflectionLegAccounts[${i}]`, v)
  );

  // Log validated account lists for debugging
  console.debug("[raceswap] Validated mainLeg accounts:", {
    count: mainLegAccounts.length,
    first3: mainLegAccounts.slice(0, 3),
    pubkeysCount: mainLegPubkeys.length,
  });
  if (reflectionLegAccounts.length > 0) {
    console.debug("[raceswap] Validated reflectionLeg accounts:", {
      count: reflectionLegAccounts.length,
      first3: reflectionLegAccounts.slice(0, 3),
      pubkeysCount: reflectionLegPubkeys.length,
    });
  }
  
  if (!wallet.publicKey) {
    throw new Error("Connect a wallet to continue");
  }

  console.log("[raceswap] Starting to parse critical addresses...");
  console.log("[raceswap] Wallet publicKey details:", {
    hasPublicKey: !!wallet.publicKey,
    publicKeyType: typeof wallet.publicKey,
    isString: typeof wallet.publicKey === 'string',
    isPublicKeyInstance: wallet.publicKey instanceof PublicKey,
    publicKeyValue: wallet.publicKey
  });
  
  // Ensure wallet.publicKey is a PublicKey instance
  let walletPubkey: PublicKey;
  if (wallet.publicKey instanceof PublicKey) {
    walletPubkey = wallet.publicKey;
  } else if (typeof wallet.publicKey === 'string') {
    walletPubkey = new PublicKey(wallet.publicKey);
  } else if (wallet.publicKey && typeof (wallet.publicKey as any).toBase58 === 'function') {
    // It might be a PublicKey-like object from a different version
    walletPubkey = new PublicKey((wallet.publicKey as any).toBase58());
  } else {
    throw new Error("Invalid wallet publicKey format");
  }
  
  const payer = walletPubkey;
  const programId = parsePubkeyStrict("plan.programId", plan.programId);
  
  // Validate program ID matches expected deployment (sanity check)
  if (!programId.equals(RACESWAP_PROGRAM_ID)) {
    console.warn("[raceswap] Program ID mismatch:", {
      expected: RACESWAP_PROGRAM_ID.toBase58(),
      received: programId.toBase58(),
    });
    // Don't throw - allow flexibility for different deployments, but log the warning
  }
  
  const configAddress = parsePubkeyStrict("plan.configAddress", plan.configAddress);
  const swapAuthority = parsePubkeyStrict("plan.swapAuthority", plan.swapAuthority);
  const inputMint = parsePubkeyStrict("plan.inputMint", plan.inputMint);
  const mainOutputMint = parsePubkeyStrict("plan.outputMint", plan.outputMint);
  const reflectionMint = parsePubkeyStrict("plan.reflectionMint", plan.reflectionMint ?? plan.outputMint);
  const inputVault = parsePubkeyStrict("plan.inputVault", plan.inputVault);
  
  console.log("[raceswap] About to parse treasuryWallet:", {
    hasTreasuryWallet: !!plan.treasuryWallet,
    treasuryWalletType: typeof plan.treasuryWallet,
    treasuryWalletValue: plan.treasuryWallet,
    isString: typeof plan.treasuryWallet === "string",
    trimmedLength: typeof plan.treasuryWallet === "string" ? plan.treasuryWallet.trim().length : 0
  });
  
  let treasuryWallet: PublicKey;
  try {
    treasuryWallet = parsePubkeyStrict("plan.treasuryWallet", plan.treasuryWallet);
    console.log("[raceswap] Successfully parsed treasuryWallet:", treasuryWallet.toBase58());
  } catch (error: any) {
    console.error("[raceswap] Failed to parse treasuryWallet:", error);
    console.error("[raceswap] Error stack:", error.stack);
    console.error("[raceswap] Full plan object:", JSON.stringify(plan, null, 2));
    throw new Error(`Failed to parse treasuryWallet: ${error.message || error}`);
  }

  console.log("[raceswap] All critical addresses parsed successfully");

  const instructions: TransactionInstruction[] = [];

  // Add Compute Budget instructions first
  const computeUnitLimit = plan.computeUnitLimit ?? 1_400_000; // Default safe limit for Jupiter CPI
  console.log(`[raceswap] Setting Compute Unit Limit: ${computeUnitLimit}`);
  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnitLimit,
    })
  );

  if (plan.computeUnitPrice) {
    console.log(`[raceswap] Setting Compute Unit Price: ${plan.computeUnitPrice}`);
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: BigInt(plan.computeUnitPrice),
      })
    );
  }


  console.log("[raceswap] Starting ATA creation process...");

  console.log("[raceswap] Resolving token program IDs for involved mints...");
  const [inputMintProgramId, mainOutputMintProgramId] = await Promise.all([
    resolveMintTokenProgramId(connection, inputMint),
    resolveMintTokenProgramId(connection, mainOutputMint),
  ]);

  const needsReflectionAta =
    !plan.disableReflection && !reflectionMint.equals(mainOutputMint);
  let reflectionMintProgramId = mainOutputMintProgramId;
  if (needsReflectionAta) {
    reflectionMintProgramId = await resolveMintTokenProgramId(
      connection,
      reflectionMint
    );
  }

  // OPTIMIZATION: Get all ATA addresses first, then batch-check which ones exist
  console.log("[raceswap] Computing ATA addresses...");
  const userInputAta = await getAssociatedTokenAddress(
    inputMint,
    payer,
    true,
    inputMintProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const userMainDestination = await getAssociatedTokenAddress(
    mainOutputMint,
    payer,
    true,
    mainOutputMintProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // OPTIMIZATION: Only create separate reflection destination if it's different from main
  let userReflectionDestination = userMainDestination;
  if (needsReflectionAta) {
    userReflectionDestination = await getAssociatedTokenAddress(
      reflectionMint,
      payer,
      true,
      reflectionMintProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }

  const treasuryPubkey = new PublicKey("Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L");

  const swapAuthorityAta = await getAssociatedTokenAddress(
    inputMint,
    swapAuthority,
    true,
    inputMintProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("[raceswap] All ATA addresses computed");

  // Batch-check which ATAs exist (parallel fetch for speed)
  console.log("[raceswap] Batch-checking ATA existence...");
  type AtaCheck = {
    address: PublicKey;
    name: string;
    owner: PublicKey;
    mint: PublicKey;
    tokenProgramId: PublicKey;
  };

  const atasToCheck: AtaCheck[] = [
    {
      address: userInputAta,
      name: "userInputAta",
      owner: payer,
      mint: inputMint,
      tokenProgramId: inputMintProgramId,
    },
    {
      address: userMainDestination,
      name: "userMainDestination",
      owner: payer,
      mint: mainOutputMint,
      tokenProgramId: mainOutputMintProgramId,
    },
    {
      address: swapAuthorityAta,
      name: "swapAuthorityAta",
      owner: swapAuthority,
      mint: inputMint,
      tokenProgramId: inputMintProgramId,
    },
  ];

  // Only check reflection ATA if it's different from main
  if (needsReflectionAta && !userReflectionDestination.equals(userMainDestination)) {
    atasToCheck.push({
      address: userReflectionDestination,
      name: "userReflectionDestination",
      owner: payer,
      mint: reflectionMint,
      tokenProgramId: reflectionMintProgramId,
    });
  }

  const accountInfos = await connection.getMultipleAccountsInfo(
    atasToCheck.map((a) => a.address)
  );

  // Create instructions only for missing ATAs
  let atasCreated = 0;
  for (let i = 0; i < atasToCheck.length; i++) {
    const ata = atasToCheck[i];
    const accountInfo = accountInfos[i];

    if (!accountInfo) {
      console.log(
        `[raceswap] Creating ${ata.name} (doesn't exist, token program ${ata.tokenProgramId.toBase58()})...`
      );

      if (ata.mint.equals(NATIVE_MINT)) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            payer,
            ata.address,
            ata.owner,
            NATIVE_MINT,
            TOKEN_PROGRAM_ID
          )
        );
      } else {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            payer,
            ata.address,
            ata.owner,
            ata.mint,
            ata.tokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
      atasCreated++;
    } else {
      console.log(`[raceswap] ${ata.name} already exists, skipping creation`);
    }
  }

  console.log(
    `[raceswap] ATA check complete: ${atasCreated} creation instruction(s) added, ${
      atasToCheck.length - atasCreated
    } already existed`
  );

  const encodeLeg = (
    leg?: { payload: { accounts: string[]; data: string } },
    signerFlags?: boolean[],
    writableFlags?: boolean[]
  ) => {
    if (!leg || !leg.payload) {
      return null;
    }
    const { accounts, data } = leg.payload;
    if (!Array.isArray(accounts) || typeof data !== 'string') {
      throw new Error(`Invalid leg structure: accounts=${accounts}, data=${data}`);
    }
    try {
        const buffer = Buffer.from(data, "base64");
        // Convert Buffer to Uint8Array for instruction serialization
      const dataArray = new Uint8Array(buffer);
      
      // Use provided flags or defaults (all false for signer, all true for writable)
      const isWritable = writableFlags ?? Array(accounts.length).fill(true);
      const isSigner = signerFlags ?? Array(accounts.length).fill(false);
      
      return {
        accountsLen: accounts.length,
        data: dataArray,
        isWritable,
        isSigner,
      };
    } catch (error) {
      throw new Error(`Failed to encode leg: ${error}`);
    }
  };

  console.log("[raceswap] Processing Jupiter program ID...");
  console.log("[raceswap] Checking jupiterProgramId in plan:", {
    hasJupiterProgramId: !!plan.jupiterProgramId,
    jupiterProgramIdType: typeof plan.jupiterProgramId,
    jupiterProgramIdValue: plan.jupiterProgramId,
    isString: typeof plan.jupiterProgramId === "string",
    trimmedLength: typeof plan.jupiterProgramId === "string" ? plan.jupiterProgramId.trim().length : 0
  });
  
  // Use the Jupiter program ID from the plan (detected by server)
  let jupiterProgramId: PublicKey;
  try {
    if (
      plan.jupiterProgramId &&
      typeof plan.jupiterProgramId === "string" &&
      plan.jupiterProgramId.trim().length > 0
    ) {
      console.log("[raceswap] Attempting to parse jupiterProgramId:", plan.jupiterProgramId);
      jupiterProgramId = parsePubkeyStrict("plan.jupiterProgramId", plan.jupiterProgramId);
      console.log("[raceswap] Successfully parsed jupiterProgramId");
    } else {
      // Fallback to v7 if not provided
      console.debug("[raceswap] jupiterProgramId not provided or invalid, using v7 fallback");
      jupiterProgramId = JUPITER_PROGRAM_ID_V7;
    }
    console.log("[raceswap] Jupiter program ID set:", jupiterProgramId.toBase58());
  } catch (error: any) {
    console.error("[raceswap] Failed to handle jupiterProgramId:", error);
    console.error("[raceswap] Error stack:", error.stack);
    throw new Error(`Failed to process jupiterProgramId: ${error.message || error}`);
  }

  console.log("[raceswap] Validating plan values for BN creation...");
  // Validate plan values before creating BN objects
  if (plan.totalAmount === undefined || plan.totalAmount === null || plan.totalAmount === '') {
    throw new Error(`Invalid plan.totalAmount: ${JSON.stringify(plan.totalAmount)}`);
  }
  if (plan.minMainOut === undefined || plan.minMainOut === null || plan.minMainOut === '') {
    throw new Error(`Invalid plan.minMainOut: ${JSON.stringify(plan.minMainOut)}`);
  }
  if (plan.minReflectionOut === undefined || plan.minReflectionOut === null || plan.minReflectionOut === '') {
    throw new Error(`Invalid plan.minReflectionOut: ${JSON.stringify(plan.minReflectionOut)}`);
  }
  
  // Convert to string if numbers
  const totalAmountStr = String(plan.totalAmount);
  const minMainOutStr = String(plan.minMainOut);
  const minReflectionOutStr = String(plan.minReflectionOut);

  // Validate mainLeg exists and is properly structured
  if (!plan.mainLeg || !plan.mainLeg.payload) {
    throw new Error(`Invalid plan.mainLeg: ${JSON.stringify(plan.mainLeg)}`);
  }
  console.log("[raceswap] Plan values validated");

  console.log("[raceswap] Creating BN objects...");
  // Validate and create BN objects with error handling
  let totalInputAmountBN: BN;
  let minMainOutBN: BN;
  let minReflectionOutBN: BN;
  
  console.log("[raceswap] Creating totalInputAmountBN from:", totalAmountStr);
  try {
    totalInputAmountBN = new BN(totalAmountStr);
    // Verify BN was created successfully (check it's not negative)
    if (totalInputAmountBN.isNeg()) {
      throw new Error(`totalAmount must be non-negative: ${totalAmountStr}`);
    }
    console.log("[raceswap] totalInputAmountBN created successfully:", totalInputAmountBN.toString());
  } catch (error: any) {
    console.error("[raceswap] Failed to create totalInputAmountBN:", error);
    if (error.message?.includes('must be non-negative')) {
      throw error;
    }
    throw new Error(`Failed to create BN from totalAmount "${totalAmountStr}": ${error.message || error}`);
  }

  console.log("[raceswap] Creating minMainOutBN from:", minMainOutStr);
  try {
    minMainOutBN = new BN(minMainOutStr);
    if (minMainOutBN.isNeg()) {
      throw new Error(`minMainOut must be non-negative: ${minMainOutStr}`);
    }
    console.log("[raceswap] minMainOutBN created successfully:", minMainOutBN.toString());
  } catch (error: any) {
    console.error("[raceswap] Failed to create minMainOutBN:", error);
    if (error.message?.includes('must be non-negative')) {
      throw error;
    }
    throw new Error(`Failed to create BN from minMainOut "${minMainOutStr}": ${error.message || error}`);
  }

  console.log("[raceswap] Creating minReflectionOutBN from:", minReflectionOutStr);
  try {
    minReflectionOutBN = new BN(minReflectionOutStr);
    if (minReflectionOutBN.isNeg()) {
      throw new Error(`minReflectionOut must be non-negative: ${minReflectionOutStr}`);
    }
    console.log("[raceswap] minReflectionOutBN created successfully:", minReflectionOutBN.toString());
  } catch (error: any) {
    console.error("[raceswap] Failed to create minReflectionOutBN:", error);
    if (error.message?.includes('must be non-negative')) {
      throw error;
    }
    throw new Error(`Failed to create BN from minReflectionOut "${minReflectionOutStr}": ${error.message || error}`);
  }
  
  console.log("[raceswap] All BN objects created successfully");

  // Handle SOL wrapping if input is native SOL
  if (inputMint.equals(NATIVE_MINT)) {
    console.log(`[raceswap] Wrapping SOL to WSOL: ${totalInputAmountBN!.toString()} lamports`);
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: userInputAta,
        lamports: BigInt(totalInputAmountBN!.toString()),
      })
    );
    instructions.push(createSyncNativeInstruction(userInputAta));
  }

  // Get signer/writable flags from plan if available, otherwise use defaults
  // Jupiter leg payloads may include these flags
  const mainSignerFlags = plan.mainLeg?.payload?.isSigner ?? Array(mainLegAccounts.length).fill(false);
  const mainWritableFlags = plan.mainLeg?.payload?.isWritable ?? Array(mainLegAccounts.length).fill(true);
  
  const reflectionSignerFlags = plan.reflectionLeg?.payload?.isSigner ?? Array(reflectionLegAccounts.length).fill(false);
  const reflectionWritableFlags = plan.reflectionLeg?.payload?.isWritable ?? Array(reflectionLegAccounts.length).fill(true);

  // Create AccountMetas from PublicKey instances for Jupiter legs
  // These are used for validation and logging, but the encoded legs still use string arrays
  // CRITICAL: Pass swapAuthority to force it to isSigner=false in encoded payloads
  const mainLegMetas = toAccountMetas("mainLeg", mainLegPubkeys, mainSignerFlags, mainWritableFlags, swapAuthority);
  const reflectionLegMetas = reflectionLegPubkeys.length > 0
    ? toAccountMetas("reflectionLeg", reflectionLegPubkeys, reflectionSignerFlags, reflectionWritableFlags, swapAuthority)
    : [];

  // Log the created AccountMetas for debugging
  console.debug("[raceswap] Created mainLeg AccountMetas:", {
    count: mainLegMetas.length,
    first3: mainLegMetas.slice(0, 3).map(m => ({
      pubkey: m.pubkey.toBase58(),
      isSigner: m.isSigner,
      isWritable: m.isWritable,
    })),
  });
  if (reflectionLegMetas.length > 0) {
    console.debug("[raceswap] Created reflectionLeg AccountMetas:", {
      count: reflectionLegMetas.length,
      first3: reflectionLegMetas.slice(0, 3).map(m => ({
        pubkey: m.pubkey.toBase58(),
        isSigner: m.isSigner,
        isWritable: m.isWritable,
      })),
    });
  }

  // Create normalized leg objects using validated account arrays (strings for encoding)
  // The encoded legs will be passed directly into the instruction payload
  const normalizedMainLeg = plan.mainLeg && plan.mainLeg.payload
    ? {
        payload: {
          accounts: mainLegAccounts,
          data: plan.mainLeg.payload.data,
        },
      }
    : null;
  
  const normalizedReflectionLeg = plan.reflectionLeg && plan.reflectionLeg.payload && reflectionLegAccounts.length > 0
    ? {
        payload: {
          accounts: reflectionLegAccounts,
          data: plan.reflectionLeg.payload.data,
        },
      }
    : null;

  console.log("[raceswap] Encoding legs...");
  // Encode legs with validation
  console.log("[raceswap] Encoding mainLeg...");
  const mainLegEncoded = encodeLeg(normalizedMainLeg as any, mainSignerFlags, mainWritableFlags);
  if (!mainLegEncoded) {
    throw new Error("mainLeg encoding failed - main leg is required");
  }
  console.log("[raceswap] mainLeg encoded successfully");
  
  console.log("[raceswap] Encoding reflectionLeg...");
  const reflectionLegEncoded = encodeLeg(normalizedReflectionLeg as any, reflectionSignerFlags, reflectionWritableFlags);
  console.log("[raceswap] reflectionLeg encoded:", reflectionLegEncoded ? "success" : "null");
  
    // The on-chain program expects undefined instead of null for optional values
    const reflectionLegValue = reflectionLegEncoded !== null ? reflectionLegEncoded : undefined;

    const remainingAccountsMetas = (() => {
      const accountsArray = plan.accounts || [];
      console.debug("[raceswap] Processing remainingAccounts:", {
        accountsLength: accountsArray.length,
        accountMetasLength: plan.accountMetas?.length ?? 0,
        accountsArray: accountsArray.slice(0, 5),
      });

      if (!Array.isArray(accountsArray)) {
        console.error("[raceswap] plan.accounts is not an array:", { type: typeof accountsArray, value: accountsArray });
        throw new Error(`plan.accounts must be an array, got: ${typeof accountsArray}`);
      }

      const validAccounts = accountsArray
        .map((pubkey, idx): AccountMeta => {
          if (!plan.accountMetas || !Array.isArray(plan.accountMetas)) {
            console.warn(`[raceswap] accountMetas is missing or invalid, using defaults for account at index ${idx}`);
          }

          const pubkeyObj = parsePubkeyStrict(`plan.accounts[${idx}]`, pubkey);

          // CRITICAL FIX: swapAuthority is a PDA of the raceswap program.
          // Even if Jupiter marks it as a signer (because it thinks it's a user wallet),
          // it CANNOT sign the transaction from the client.
          // The raceswap program will sign for it via CPI.
          const isSwapAuthority = pubkeyObj.equals(swapAuthority);
          const isSigner = isSwapAuthority ? false : (plan.accountMetas?.[idx]?.isSigner ?? false);

          return {
            pubkey: pubkeyObj,
            isWritable: plan.accountMetas?.[idx]?.isWritable ?? false,
            isSigner: isSigner,
          };
        })
        .filter((acc): acc is AccountMeta => {
          if (!acc || !acc.pubkey) {
            console.warn(`[raceswap] Filtering out invalid account object:`, { acc });
            return false;
          }
          if (!(acc.pubkey instanceof PublicKey)) {
            console.warn(`[raceswap] Filtering out account with non-PublicKey pubkey:`, {
              pubkey: acc.pubkey,
              type: typeof acc.pubkey,
              isInstance: (acc.pubkey as any) instanceof PublicKey,
            });
            return false;
          }
          return true;
        });

      if (validAccounts.length !== accountsArray.length) {
        console.warn(
          `[raceswap] Filtered ${accountsArray.length - validAccounts.length} invalid accounts from ${accountsArray.length} total`
        );
      }

      console.debug("[raceswap] remainingAccounts processing complete:", {
        inputLength: accountsArray.length,
        outputLength: validAccounts.length,
      });

      return validAccounts;
    })();

    // Validate all accounts before building the instruction to catch issues early
    console.log("[raceswap] Validating all accounts before instruction creation...");
    const accountsToValidate = {
      config: configAddress,
      user: payer,
      inputMint,
      mainOutputMint,
      reflectionMint,
      userInput: userInputAta,
      userMainDestination,
      userReflectionDestination,
      treasuryWallet: treasuryPubkey,
      inputVault,
      swapAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
      jupiterProgram: jupiterProgramId,
    };

    for (const [key, value] of Object.entries(accountsToValidate)) {
      if (!value) {
        console.error(`[raceswap] INVALID account: ${key} is undefined/null`, { key, value });
        throw new Error(`[raceswap] Account ${key} is undefined or null`);
      }
      const isPublicKeyInstance = value instanceof PublicKey;
      const hasPubkeyInterface = typeof (value as PublicKey).toBase58 === "function";
      if (!isPublicKeyInstance && !hasPubkeyInterface) {
        console.error(`[raceswap] INVALID account: ${key} is not a PublicKey`, {
          key,
          value,
          type: typeof value,
          hasToBase58: hasPubkeyInterface,
        });
        throw new Error(`[raceswap] Account ${key} is not a PublicKey instance`);
      }
    }
      console.log("[raceswap] All accounts validated successfully");

      console.log("[raceswap] Building execute_raceswap instruction via manual encoder");
      let execIx: TransactionInstruction;
      let deduplicatedAccounts: AccountMeta[] = [];
    try {
      const data = buildExecuteRaceswapData({
          inputMint,
          mainOutputMint,
          reflectionMint,
        totalInputAmount: totalInputAmountBN,
        minMainOut: minMainOutBN,
        minReflectionOut: minReflectionOutBN,
        disableReflection: plan.disableReflection ?? false,
        mainLeg: mainLegEncoded as SerializedInstructionPayload,
        reflectionLeg: reflectionLegValue ?? null,
      });

      // Build base accounts list, checking for duplicates (e.g., if reflection mint == main mint)
      // NOTE: swapAuthority is NOT included in named accounts - it's only in remaining_accounts
      // This prevents Anchor from auto-setting is_signer=true during PDA validation (fixes 0x1789 error)
      const baseAccountsList: AccountMeta[] = [
        { pubkey: configAddress, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: inputMint, isSigner: false, isWritable: false },
        { pubkey: userInputAta, isSigner: false, isWritable: true },
        { pubkey: userMainDestination, isSigner: false, isWritable: true },
        { pubkey: userReflectionDestination, isSigner: false, isWritable: true },
        { pubkey: treasuryPubkey, isSigner: false, isWritable: true }, // treasury_wallet (Unchecked)
        { pubkey: payer, isSigner: true, isWritable: true }, // treasury_fee_destination (SystemAccount)
        { pubkey: inputVault, isSigner: false, isWritable: true },
        // swapAuthority removed from named accounts - only in remaining_accounts
        { pubkey: inputMintProgramId, isSigner: false, isWritable: false },
        { pubkey: jupiterProgramId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      // No deduplication of Remaining accounts against Base accounts for now to ensure order is preserved for on-chain iteration
      const combinedAccounts = [
        ...baseAccountsList,
        ...remainingAccountsMetas
      ];
      
      deduplicatedAccounts = combinedAccounts;
      
      console.log(`[raceswap] Account list built: ${baseAccountsList.length} base + ${remainingAccountsMetas.length} remaining = ${deduplicatedAccounts.length} total`);
      console.log(`[raceswap] Final account breakdown:`);
      console.log(`  - Total accounts: ${deduplicatedAccounts.length}`);
      console.log(`  - Writable accounts: ${deduplicatedAccounts.filter(a => a.isWritable).length}`);
      console.log(`  - Signer accounts: ${deduplicatedAccounts.filter(a => a.isSigner).length}`);
      console.log(`  - Instruction data size: ${data.length} bytes`);

      execIx = new TransactionInstruction({
        programId,
        keys: deduplicatedAccounts,
        data,
      });
      console.log("[raceswap] execute_raceswap instruction built successfully (manual encoder)");
    } catch (error: any) {
      console.error("[raceswap] Error building execute_raceswap instruction:", error, {
        args: {
          totalInputAmount: plan.totalAmount,
          minMainOut: plan.minMainOut,
          minReflectionOut: plan.minReflectionOut,
          disableReflection: plan.disableReflection ?? false,
        },
        accounts: accountsToValidate,
      });
      throw error;
    }

    instructions.push(execIx);

    // Log detailed instruction breakdown
    console.log(`[raceswap] Transaction instruction breakdown:`);
    let totalAccounts = 0;
    let totalDataSize = 0;
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      const accountCount = ix.keys.length;
      const dataSize = ix.data.length;
      totalAccounts += accountCount;
      totalDataSize += dataSize;
      console.log(`  - Instruction ${i}: ${accountCount} accounts, ${dataSize} bytes data`);
    }
    console.log(`  - Total: ${instructions.length} instructions, ${totalAccounts} accounts, ${totalDataSize} bytes data`);
    

    // Validate instructions array before creating transaction
    console.debug("[raceswap] Validating instructions array before transaction creation:", {
      count: instructions.length,
    });
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      if (!ix) {
        console.error(`[raceswap] INVALID: instruction at index ${i} is undefined/null`);
        throw new Error(`[raceswap] Instruction at index ${i} is undefined or null`);
      }
      const isProgramPublicKey = ix.programId instanceof PublicKey;
      const hasProgramInterface = typeof (ix.programId as PublicKey).toBase58 === "function";
      if (!isProgramPublicKey && !hasProgramInterface) {
        console.error(`[raceswap] INVALID: instruction ${i} programId is not a PublicKey`, {
          type: typeof ix.programId,
          programId: ix.programId,
          hasToBase58: hasProgramInterface,
        });
        throw new Error(`[raceswap] Instruction ${i} programId is not a PublicKey instance`);
      }
    }

    console.log(
      "[raceswap] About to validate transaction keys, instruction count:",
      instructions.length
    );

    try {
      validateTxKeys("pre-transaction", instructions);
      console.log("[raceswap] Transaction validation passed successfully");
    } catch (err) {
      console.error("[raceswap] validateTxKeys threw an error:", err);
      throw err;
    }

    // Resolve address lookup tables (if any) to shrink account list
    const lookupTableAccounts: AddressLookupTableAccount[] = [];
    if (Array.isArray(plan.addressLookupTableAddresses) && plan.addressLookupTableAddresses.length > 0) {
      const uniqueLookupAddresses = Array.from(
        new Set(
          plan.addressLookupTableAddresses
            .map((addr) => addr?.trim())
            .filter((addr): addr is string => Boolean(addr && addr.length > 0))
        )
      );
      const lookupPubkeys = uniqueLookupAddresses.map((addr, idx) =>
        parsePubkeyStrict(`plan.addressLookupTableAddresses[${idx}]`, addr)
      );
      const lookupInfos = await connection.getMultipleAccountsInfo(lookupPubkeys);
      lookupInfos.forEach((info, idx) => {
        const address = uniqueLookupAddresses[idx];
        if (!info) {
          console.warn(`[raceswap] Lookup table ${address} missing on RPC, skipping`);
          return;
        }
        try {
          lookupTableAccounts.push(
            new AddressLookupTableAccount({
              key: lookupPubkeys[idx],
              state: AddressLookupTableAccount.deserialize(info.data),
            })
          );
        } catch (error) {
          console.warn(`[raceswap] Failed to decode lookup table ${address}:`, error);
        }
      });
      console.log(
        `[raceswap] Lookup tables loaded: ${lookupTableAccounts.length}/${uniqueLookupAddresses.length}`
      );
    } else {
      console.log("[raceswap] No lookup tables requested by plan");
    }

    // Get recent blockhash for versioned transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    
    // Create a v0 transaction message
    const messageV0 = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(lookupTableAccounts);
    
    // Create versioned transaction
    const transaction = new VersionedTransaction(messageV0);
    
    const lookedUpWritableAccounts = messageV0.addressTableLookups.reduce(
      (sum, lookup) => sum + lookup.writableIndexes.length,
      0
    );
    const lookedUpReadonlyAccounts = messageV0.addressTableLookups.reduce(
      (sum, lookup) => sum + lookup.readonlyIndexes.length,
      0
    );
    console.log("[raceswap] Address table usage summary:", {
      dedupedAccounts: deduplicatedAccounts.length,
      staticAccountKeys: messageV0.staticAccountKeys.length,
      lookedUpWritable: lookedUpWritableAccounts,
      lookedUpReadonly: lookedUpReadonlyAccounts,
      lookupTablesUsed: lookupTableAccounts.length,
    });
    console.log("[raceswap] Created VersionedTransaction (v0) with", instructions.length, "instructions");
  
    // OPTIMIZATION: Log transaction size after serialization to confirm estimates
    // Solana transactions have a 1232 byte limit (1280 MTU - 48 byte overhead)
    try {
      // Serialize the message to get EXACT size (this works even without signatures)
      const messageBytes = messageV0.serialize();
      const numSignatures = messageV0.header.numRequiredSignatures || 1;
      const signatureBytes = 64 * numSignatures;
      const actualSize = messageBytes.length + signatureBytes;
      
      console.log(`[raceswap] ACTUAL serialized tx size:`);
      console.log(`  - Message: ${messageBytes.length} bytes`);
      console.log(`  - Signatures: ${signatureBytes} bytes (${numSignatures} signer${numSignatures > 1 ? 's' : ''})`);
      console.log(`  - Total: ${actualSize} bytes (limit: 1232 bytes, ${1232 - actualSize} bytes remaining)`);
      
      if (actualSize > 1232) {
        console.error(`[raceswap] ❌ Transaction size ${actualSize} exceeds Solana's 1232 byte limit by ${actualSize - 1232} bytes!`);
        throw new Error(`Transaction too large: ${actualSize} bytes (max 1232, over by ${actualSize - 1232}). Try: 1) Smaller amount, 2) Disable reflection, or 3) Different token pair.`);
      } else if (actualSize > 1150) {
        console.warn(`[raceswap] ⚠️  Transaction size ${actualSize} is close to the limit (${1232 - actualSize} bytes remaining).`);
      } else {
        console.log(`[raceswap] ✓ Transaction size confirmed: ${actualSize}/1232 bytes`);
      }
    } catch (e: any) {
      // If serialization fails, it's likely because the transaction is way too large
      if (e.message?.includes('Transaction too large')) {
        throw e; // Re-throw our custom error
      }
      if (e.message?.includes('encoding overruns Uint8Array') || e.message?.includes('overruns')) {
        console.error(`[raceswap] ❌ Transaction serialization failed: message is too large to encode`);
        throw new Error(`Transaction way too large to serialize. Try: 1) Much smaller amount, 2) Disable reflection, or 3) Different token pair.`);
      }
      console.error(`[raceswap] Failed to serialize transaction for size check: ${e.message || e}`);
      throw new Error(`Transaction serialization failed: ${e.message || e}. The transaction may be too large.`);
    }

    return transaction;
  }
