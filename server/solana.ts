import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  SystemProgram
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getMint,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount
} from "@solana/spl-token";
import { createTransferCheckedInstructionManual } from "./spl";
import bs58 from "bs58";
import { Treasury } from "@shared/schema";
import fs from "node:fs";
import path from "node:path";

// Environment validation with fallbacks for development
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY || process.env.SERVER_KEYPAIR;
const RACE_MINT = process.env.RACE_MINT;
const TREASURY_PUBKEY = process.env.TREASURY_PUBKEY;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY; // optional: enable SOL funding from treasury → escrow
const JACKPOT_PUBKEY = process.env.JACKPOT_PUBKEY;
const JACKPOT_PRIVATE_KEY = process.env.JACKPOT_PRIVATE_KEY; // optional: control jackpot wallet for sweeps
const CLUSTER = process.env.CLUSTER || "mainnet-beta";
let MOCK_SOLANA = (process.env.MOCK_SOLANA || "").toLowerCase() === '1' || (process.env.MOCK_SOLANA || "").toLowerCase() === 'true';

const SOL_IS_PROD = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === 'true';
if (!ESCROW_PRIVATE_KEY) {
  if (SOL_IS_PROD) {
    console.warn("⚠️  ESCROW_PRIVATE_KEY not set in production - enabling MOCK_SOLANA and generating ephemeral keypair");
    MOCK_SOLANA = true;
    try { (process.env as any).MOCK_SOLANA = '1'; } catch {}
  } else {
    console.warn("⚠️  ESCROW_PRIVATE_KEY/SERVER_KEYPAIR not set - generating temporary keypair for development");
  }
}

if (!TREASURY_PUBKEY) {
  console.warn("⚠️  TREASURY_PUBKEY not set - using server wallet as treasury for development");
}

if (!JACKPOT_PUBKEY) {
  console.warn("⚠️  JACKPOT_PUBKEY not set - using server wallet as jackpot for development");
}

if (MOCK_SOLANA) {
  console.warn("⚠️  MOCK_SOLANA enabled - on-chain operations will be simulated in development");
}

export const connection = new Connection(RPC_URL, "confirmed");

// Export environment variables for use in other modules
export const raceMintAddress = RACE_MINT;
export let treasuryPubkey: PublicKey | null = TREASURY_PUBKEY ? new PublicKey(TREASURY_PUBKEY) : null;
export const jackpotPubkey = JACKPOT_PUBKEY ? new PublicKey(JACKPOT_PUBKEY) : null;

// Load or persist server keypair to ensure stability across restarts when env is not set
function resolvePersistPath(): string | null {
  // Never use on-disk private key persistence in production
  if (SOL_IS_PROD) {
    return null;
  }
  try {
    const candidates = [
      "/data/escrow-keypair.b58",
      "/mnt/data/escrow-keypair.b58",
      path.join(process.cwd(), "data", "escrow-keypair.b58"),
      path.join(process.cwd(), "escrow-keypair.b58")
    ];
    for (const p of candidates) {
      const dir = path.dirname(p);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      // Best-effort writability probe
      try {
        const probe = path.join(dir, `.key-write-probe-${Date.now()}`);
        fs.writeFileSync(probe, "ok");
        fs.rmSync(probe);
        return p;
      } catch {}
    }
  } catch {}
  return null;
}

function loadOrCreateServerKeypair(): Keypair {
  // 1) Explicit env wins - NEVER persist secrets to disk
  if (ESCROW_PRIVATE_KEY) {
    try {
      const kp = Keypair.fromSecretKey(bs58.decode(ESCROW_PRIVATE_KEY));
      console.log(`🔐 Loaded escrow keypair from ESCROW_PRIVATE_KEY environment variable`);
      return kp;
    } catch (error) {
      console.warn('Invalid ESCROW_PRIVATE_KEY format, falling back to persisted or generated keypair');
    }
  }

  // 2) Try to load from persistent file
  try {
    const persistPath = resolvePersistPath();
    if (persistPath && fs.existsSync(persistPath)) {
      const b58 = fs.readFileSync(persistPath, 'utf8').trim();
      const kp = Keypair.fromSecretKey(bs58.decode(b58));
      console.log(`🔐 Loaded escrow keypair from ${persistPath}`);
      return kp;
    }
  } catch (e) {
    console.warn('Failed to load persisted escrow keypair, will generate a new one');
  }

  // 3) Generate a new one and persist it
  const generated = Keypair.generate();
  try {
    const persistPath = resolvePersistPath();
    if (persistPath) {
      fs.writeFileSync(persistPath, bs58.encode(generated.secretKey), { mode: 0o600 });
      console.log(`🔐 Generated and persisted new escrow keypair to ${persistPath}`);
    } else {
      console.warn('⚠️  No writable path available to persist escrow keypair; using in-memory key only');
    }
  } catch (e) {
    console.warn('⚠️  Failed to persist generated escrow keypair; using in-memory key only');
  }
  return generated;
}

// Load server keypair (stable across restarts if persisted)
export const serverKeypair = loadOrCreateServerKeypair();

// Resolve a stable treasury pubkey if not provided via env
function resolveTreasuryPubkey(): PublicKey | null {
  try {
    if (treasuryPubkey) return treasuryPubkey;
    // Prefer persisted public key if available
    const candidates = [
      "/data/treasury-pubkey.b58",
      "/mnt/data/treasury-pubkey.b58",
      path.join(process.cwd(), "data", "treasury-pubkey.b58")
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const txt = fs.readFileSync(p, 'utf8').trim();
          if (txt) return new PublicKey(txt);
        }
      } catch {}
    }
    // If not persisted, generate a receiver-only key and persist its PUBLIC key (no private key needed for receiving)
    const kp = Keypair.generate();
    const pubTxt = kp.publicKey.toString();
    for (const p of candidates) {
      try {
        const dir = path.dirname(p);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        fs.writeFileSync(p, pubTxt, { mode: 0o644 });
        console.log(`🔐 Persisted treasury pubkey to ${p}`);
        break;
      } catch {}
    }
    return kp.publicKey;
  } catch {
    return null;
  }
}

treasuryPubkey = resolveTreasuryPubkey() || treasuryPubkey;

console.log("Server wallet:", serverKeypair.publicKey.toString());
console.log("Treasury wallet:", treasuryPubkey?.toString() || "Using server wallet");
console.log("Jackpot wallet:", jackpotPubkey?.toString() || "Using server wallet");

// Optional: load jackpot keypair when provided so we can move funds from jackpot → escrow on payout
function loadJackpotKeypair(): Keypair | null {
  try {
    if (JACKPOT_PRIVATE_KEY && JACKPOT_PRIVATE_KEY.trim().length > 0) {
      const kp = Keypair.fromSecretKey(bs58.decode(JACKPOT_PRIVATE_KEY.trim()));
      const pub = kp.publicKey.toString();
      const expected = jackpotPubkey?.toString();
      if (expected && expected !== pub) {
        console.warn(`⚠️  JACKPOT_PRIVATE_KEY does not match JACKPOT_PUBKEY (env). Using provided private key: ${pub}`);
      }
      return kp;
    }
  } catch (e) {
    console.warn('⚠️  Failed to load JACKPOT_PRIVATE_KEY:', (e as any)?.message || e);
  }
  return null;
}

export const jackpotKeypair: Keypair | null = loadJackpotKeypair();

// Optional: load treasury keypair to allow SOL funding transfers to escrow (for house seed separation)
function loadTreasuryKeypair(): Keypair | null {
  try {
    if (TREASURY_PRIVATE_KEY && TREASURY_PRIVATE_KEY.trim().length > 0) {
      const kp = Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE_KEY.trim()));
      const pub = kp.publicKey.toString();
      const expected = treasuryPubkey?.toString();
      if (expected && expected !== pub) {
        console.warn(`⚠️  TREASURY_PRIVATE_KEY does not match TREASURY_PUBKEY (env). Using provided private key: ${pub}`);
      }
      return kp;
    }
  } catch (e) {
    console.warn('⚠️  Failed to load TREASURY_PRIVATE_KEY:', (e as any)?.message || e);
  }
  return null;
}

export const treasuryKeypair: Keypair | null = loadTreasuryKeypair();

// Lightweight parsed-transaction cache and in-flight deduping to reduce RPC pressure
type ParsedTxCached = { transfers: TokenTransfer[]; memo?: string; slot?: number; blockTimeMs?: number };
const TX_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const TX_CACHE_MAX = 1000;
const parsedTxCache = new Map<string, { ts: number; data: ParsedTxCached }>();
const inFlightParsedTx = new Map<string, Promise<ParsedTxCached | null>>();
const txSeen = new Set<string>();

function pruneParsedTxCacheIfNeeded() {
  if (parsedTxCache.size <= TX_CACHE_MAX) return;
  // Simple FIFO prune by insertion order
  const excess = parsedTxCache.size - TX_CACHE_MAX;
  const keys = Array.from(parsedTxCache.keys()).slice(0, excess);
  keys.forEach(k => parsedTxCache.delete(k));
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Robust transaction sender to mitigate RPC blockhash timeouts and rate limits
async function sendTransactionWithRetries(
  tx: Transaction,
  signers: Keypair[],
  label: string
): Promise<string> {
  const commitments: Array<"processed" | "confirmed" | "finalized"> = ["processed", "confirmed", "finalized"];
  const maxAttempts = 6;
  let lastError: unknown = undefined;
  let lastSig: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const commitment = commitments[(attempt - 1) % commitments.length];
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
      tx.recentBlockhash = blockhash;
      tx.feePayer = signers[0].publicKey;

      // Send and confirm explicitly with the fetched blockhash context
      const signature = await connection.sendTransaction(tx, signers, {
        skipPreflight: false,
        preflightCommitment: commitment,
        maxRetries: 2
      });
      lastSig = signature;

      const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (confirmation.value.err) {
        // Before throwing, check signature status one more time for a race where RPC returns err but status is confirmed later
        try {
          const statuses = await connection.getSignatureStatuses([signature]);
          const st = statuses && statuses.value && statuses.value[0];
          if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
            console.log(`✅ ${label} signature (late confirm): ${signature}`);
            return signature;
          }
        } catch {}
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      console.log(`✅ ${label} signature: ${signature}`);
      return signature;
    } catch (e: any) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const isBlockhashIssue =
        msg.includes("Unable to obtain a new blockhash") ||
        msg.toLowerCase().includes("blockhash not found") ||
        msg.toLowerCase().includes("blockheight exceeded") ||
        msg.toLowerCase().includes("expired") ||
        msg.toLowerCase().includes("failed to get recent blockhash");
      const isRateLimited = msg.includes("429") || msg.toLowerCase().includes("too many requests");
      // If we have a signature already, try to detect success before deciding to retry
      if (lastSig) {
        try {
          const statuses = await connection.getSignatureStatuses([lastSig]);
          const st = statuses && statuses.value && statuses.value[0];
          if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
            console.log(`✅ ${label} signature (status confirmed after error): ${lastSig}`);
            return lastSig;
          }
        } catch {}
      }
      if (isBlockhashIssue || isRateLimited) {
        const backoff = 300 * attempt + 200; // linear backoff with base delay
        console.warn(`⏳ ${label} attempt ${attempt}/${maxAttempts} failed (${msg}). Retrying in ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }
      // Non-retryable error
      throw e;
    }
  }

  // Exhausted attempts
  // As a final safeguard, if we have a lastSig and it actually confirmed, treat as success
  if (lastSig) {
    try {
      const statuses = await connection.getSignatureStatuses([lastSig]);
      const st = statuses && statuses.value && statuses.value[0];
      if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        console.log(`✅ ${label} signature (final status confirmed): ${lastSig}`);
        return lastSig;
      }
    } catch {}
  }
  throw lastError instanceof Error
    ? new Error(`${label} failed after ${maxAttempts} attempts: ${lastError.message}`)
    : new Error(`${label} failed after ${maxAttempts} attempts`);
}

async function fetchAndParseTransaction(signature: string): Promise<ParsedTxCached | null> {
  // Serve from cache if fresh
  const cached = parsedTxCache.get(signature);
  if (cached && (Date.now() - cached.ts) < TX_CACHE_TTL_MS) {
    return cached.data;
  }

  // Deduplicate concurrent fetches
  const existing = inFlightParsedTx.get(signature);
  if (existing) return existing;

  const task = (async () => {
    // Exponential backoff with jitter for 429 and for not-yet-available meta
    const delays = [400, 1000, 2000, 4000];
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      try {
        console.log(`📡 Attempt ${attempt} to fetch transaction...`);
        const tx = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        });
        if (tx && tx.meta) {
          // basic anti-replay: ignore if we've processed this sig earlier in this process
          if (txSeen.has(signature)) {
            return parsedTxCache.get(signature)?.data || null;
          }
          console.log(`✅ Transaction found on attempt ${attempt}`);
          // Build parsed result
          let memo: string | undefined;
          try {
            const memoProgramId = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
            const msg = tx.transaction.message as any;
            const accountKeys = (msg.staticAccountKeys || msg.accountKeys).map((k: any) => k.toString ? k.toString() : String(k));
            const instructions = msg.compiledInstructions || msg.instructions || [];
            console.log(`🔍 [MEMO DEBUG] Found ${instructions.length} instructions in transaction`);
            for (const ix of instructions) {
              const programIdIndex = typeof ix.programIdIndex === 'number' ? ix.programIdIndex : ix.programIdIndex?.toNumber?.() ?? 0;
              const programIdStr = accountKeys[programIdIndex];
              console.log(`🔍 [MEMO DEBUG] Instruction programId: ${programIdStr}, checking against memo: ${memoProgramId.toString()}`);
              if (programIdStr === memoProgramId.toString()) {
                console.log(`✅ [MEMO DEBUG] Found memo instruction!`);
                // Support Buffer/Uint8Array and string encodings
                const dataStr = (ix.data && typeof ix.data === 'string') ? ix.data : undefined;
                const dataBuf: Uint8Array | undefined = (!dataStr && ix.data && (ix.data instanceof Uint8Array || (ix.data as any).length !== undefined)) ? (ix.data as Uint8Array) : undefined;
                console.log(`🔍 [MEMO DEBUG] Data type - string: ${!!dataStr}, buffer: ${!!dataBuf}, raw type: ${typeof ix.data}`);
                if (dataBuf) {
                  try {
                    const txt = Buffer.from(dataBuf).toString('utf8');
                    console.log(`🔍 [MEMO DEBUG] Decoded from buffer: ${txt.slice(0, 100)}`);
                    if (txt && txt.length > 0) memo = txt;
                  } catch (e) {
                    console.warn(`⚠️  [MEMO DEBUG] Failed to decode buffer:`, e);
                  }
                }
                if (!memo && dataStr) {
                  // Prefer bs58 (most RPCs return compiled instruction data in base58). Fallback to base64.
                  console.log(`🔍 [MEMO DEBUG] Trying bs58 decode of string data (length: ${dataStr.length})`);
                  try {
                    const bs58lib = (await import('bs58')).default;
                    const buf = bs58lib.decode(dataStr);
                    const txt = Buffer.from(buf).toString('utf8');
                    console.log(`🔍 [MEMO DEBUG] Decoded from bs58: ${txt.slice(0, 100)}`);
                    if (txt && txt.length > 0) memo = txt;
                  } catch (e) {
                    console.warn(`⚠️  [MEMO DEBUG] bs58 decode failed:`, e);
                  }
                  if (!memo) {
                    console.log(`🔍 [MEMO DEBUG] Trying base64 decode`);
                    try {
                      const buf = Buffer.from(dataStr, 'base64');
                      const txt = buf.toString('utf8');
                      console.log(`🔍 [MEMO DEBUG] Decoded from base64: ${txt.slice(0, 100)}`);
                      if (txt && txt.length > 0) memo = txt;
                    } catch (e) {
                      console.warn(`⚠️  [MEMO DEBUG] base64 decode failed:`, e);
                    }
                  }
                }
                if (!memo) {
                  console.warn(`⚠️  [MEMO DEBUG] Failed to extract memo text from instruction data`);
                }
              }
            }
            if (!memo) {
              console.warn(`⚠️  [MEMO DEBUG] No memo instruction found in transaction`);
            } else {
              console.log(`✅ [MEMO DEBUG] Successfully extracted memo: ${memo.slice(0, 100)}`);
            }
          } catch (e) {
            console.error(`❌ [MEMO DEBUG] Error parsing memo:`, e);
          }

          const tokenTransfers = tx.meta.preTokenBalances && tx.meta.postTokenBalances 
            ? parseTokenTransfers(tx.meta.preTokenBalances, tx.meta.postTokenBalances)
            : [];

          console.log(`📊 Transaction found with ${tx.meta.preTokenBalances?.length || 0} pre-balances and ${tx.meta.postTokenBalances?.length || 0} post-balances`);
          console.log(`🔄 Found ${tokenTransfers.length} token transfers in transaction:`);
          tokenTransfers.forEach((transfer, i) => {
            console.log(`  Transfer ${i}: mint=${transfer.mint}, sender=${transfer.sender}, recipient=${transfer.recipient}, amount=${transfer.amount}`);
          });

          const blockTimeMs = typeof tx.blockTime === 'number' ? tx.blockTime * 1000 : undefined;
          const parsed: ParsedTxCached = { transfers: tokenTransfers, memo, slot: tx.slot, blockTimeMs };
          parsedTxCache.set(signature, { ts: Date.now(), data: parsed });
          txSeen.add(signature);
          pruneParsedTxCacheIfNeeded();
          return parsed;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('429') || msg.toLowerCase().includes('too many requests')) {
          const delay = attempt <= delays.length ? delays[attempt - 1] : delays[delays.length - 1];
          console.log(`Server responded with 429 Too Many Requests.  Retrying after ${delay}ms delay...`);
          await sleep(delay);
          continue;
        }
        // Non-429 errors: break after first failure
        throw e;
      }
      if (attempt <= delays.length) {
        console.log(`⏳ Transaction not confirmed yet, waiting ${delays[attempt - 1]}ms...`);
        await sleep(delays[attempt - 1]);
      }
    }
    console.log(`❌ Transaction not found after retries: ${signature}`);
    return null;
  })();

  inFlightParsedTx.set(signature, task);
  try {
    return await task;
  } finally {
    inFlightParsedTx.delete(signature);
  }
}

// ----- Mint metadata helper (decimals + token program, cached) -----
type MintMetadata = {
  decimals: number;
  tokenProgramId: PublicKey;
};

const mintMetadataCache = new Map<string, MintMetadata>();

async function getMintMetadata(mint: PublicKey): Promise<MintMetadata> {
  if (MOCK_SOLANA) {
    return { decimals: 9, tokenProgramId: TOKEN_PROGRAM_ID };
  }
  const key = mint.toString();
  const cached = mintMetadataCache.get(key);
  if (cached) return cached;

  const mintAccount = await connection.getAccountInfo(mint, "confirmed");
  if (!mintAccount) {
    throw new Error(`Mint account not found: ${key}`);
  }

  const programId = mintAccount.owner;
  if (
    !programId.equals(TOKEN_PROGRAM_ID) &&
    !programId.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    console.warn(`⚠️  Mint ${key} uses unexpected token program ${programId.toString()}. Proceeding with detected program.`);
  }

  const mintInfo = await getMint(connection, mint, undefined, programId);
  const decimals = Number(mintInfo.decimals ?? 9);
  const metadata: MintMetadata = { decimals, tokenProgramId: programId };
  mintMetadataCache.set(key, metadata);
  return metadata;
}

export async function getMintDecimals(mint: PublicKey): Promise<number> {
  try {
    const { decimals } = await getMintMetadata(mint);
    return decimals;
  } catch {
    return 9;
  }
}

export async function getMintTokenProgramId(mint: PublicKey): Promise<PublicKey> {
  const { tokenProgramId } = await getMintMetadata(mint);
  return tokenProgramId;
}

// Mint management
export async function ensureRaceMintExists(treasury: Treasury): Promise<{ mint: PublicKey; updated: boolean }> {
  // Mock mode: generate or use provided mint address without any on-chain calls
  if (MOCK_SOLANA) {
    const mockMint = RACE_MINT ? new PublicKey(RACE_MINT) : Keypair.generate().publicKey;
    console.log("[MOCK] Using mock RACE mint:", mockMint.toString());
    const updated = treasury.raceMint !== mockMint.toString();
    return { mint: mockMint, updated };
  }
  // Prefer explicit environment configuration first to avoid drift across restarts
  if (raceMintAddress) {
    const envMint = new PublicKey(raceMintAddress);
    console.log("Using RACE mint from environment:", envMint.toString());
    // Ensure escrow ATA exists for server wallet (skip in mock)
    if (!MOCK_SOLANA) {
      try {
        await getOrCreateAssociatedTokenAccount(
          connection,
          serverKeypair,
          envMint,
          serverKeypair.publicKey
        );
      } catch (e: any) {
        // Do not fail initialization on ATA lookup issues; defer creation to first transfer
        const msg = e?.message || String(e);
        console.warn(`⚠️  Escrow ATA ensure failed during init: ${msg}. Proceeding; will lazily create on first transfer.`);
      }
    }
    return { mint: envMint, updated: true };
  }

  // Fallback to persisted DB value
  if (treasury.raceMint) {
    // Reject known placeholder WSOL mint if present in DB
    if (treasury.raceMint === "So11111111111111111111111111111111111111112") {
      throw new Error("Invalid RACE mint configured (WSOL placeholder). Please set a real SPL mint via RACE_MINT or reset treasury.");
    }
    const mintPubkey = new PublicKey(treasury.raceMint);
    console.log("Using existing RACE mint from DB:", mintPubkey.toString());
    return { mint: mintPubkey, updated: false };
  }

  // In deployment, if no explicit RACE_MINT and no DB value, degrade to mock mode with ephemeral mint
  const isDeployment = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
  if (isDeployment) {
    console.warn("⚠️  RACE_MINT not set in production - enabling MOCK_SOLANA and using ephemeral mint. Set RACE_MINT ASAP.");
    try { (process.env as any).MOCK_SOLANA = '1'; } catch {}
    MOCK_SOLANA = true;
    const fallbackMint = Keypair.generate().publicKey;
    return { mint: fallbackMint, updated: true };
  }

  // Otherwise (development), attempt to create a real mint (no placeholders allowed)
  const balance = await connection.getBalance(serverKeypair.publicKey);
  console.log(`Server wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    console.warn("⚠️  Insufficient SOL to create RACE mint.");
    console.warn("    Fund server wallet or set RACE_MINT env var.");
    console.warn("    Enabling mock on-chain mode for development.");
    const mockMint = Keypair.generate().publicKey;
    return { mint: mockMint, updated: true };
  }

  const mint = await createMint(
    connection,
    serverKeypair,
    serverKeypair.publicKey,
    null,
    9
  );

  console.log("Created RACE mint:", mint.toString());

  const escrowAta = await getOrCreateAssociatedTokenAccount(
    connection,
    serverKeypair,
    mint,
    serverKeypair.publicKey
  );
  console.log("Created escrow ATA:", escrowAta.address.toString());

  return { mint, updated: true };
}

// Get ATA for wallet and mint
export async function getAssociatedTokenAccountAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId?: PublicKey
): Promise<PublicKey> {
  const programId = tokenProgramId ?? (await getMintTokenProgramId(mint).catch(() => TOKEN_PROGRAM_ID));
  return await getAssociatedTokenAddress(mint, owner, false, programId);
}

// Send SPL tokens
export async function sendSplTokens(
  mint: PublicKey,
  fromKeypair: Keypair,
  toPubkey: PublicKey,
  amount: bigint | number,
  memo?: string
): Promise<string> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] sendSplTokens ${amount} of ${mint.toString()} to ${toPubkey.toString()}`);
    return `mock-tx-${Date.now()}`;
  }
  
  // Pre-flight: Check sender has enough SOL for fees
  const senderBalance = await connection.getBalance(fromKeypair.publicKey);
  if (senderBalance < 5000) { // ~0.000005 SOL minimum
    throw new Error(`Sender ${fromKeypair.publicKey.toString()} has insufficient SOL for transaction fees: ${senderBalance} lamports`);
  }
  
  const { decimals, tokenProgramId } = await getMintMetadata(mint);
  const amountNum = typeof amount === 'bigint' ? Number(amount) : amount;
  if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
    throw new Error(`Invalid transfer amount (must be safe integer): ${amount.toString()}`);
  }
  
  // Get sender's ATA address
  const fromAtaAddress = await getAssociatedTokenAddress(
    mint,
    fromKeypair.publicKey,
    false,
    tokenProgramId
  );
  
  // Wait for sender's ATA to exist (Jupiter swap should have created it)
  let fromAtaInfo = await connection.getAccountInfo(fromAtaAddress);
  
  if (!fromAtaInfo) {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts && !fromAtaInfo; attempt++) {
      const waitMs = 1500 * attempt;
      console.log(`⏳ Sender ATA not found, waiting ${waitMs}ms for Jupiter swap to settle (attempt ${attempt}/${maxAttempts})...`);
      await sleep(waitMs);
      fromAtaInfo = await connection.getAccountInfo(fromAtaAddress);
    }
  }
  
  if (!fromAtaInfo) {
    console.log(`⚠️ Sender ATA still doesn't exist after waiting, attempting to create...`);
    console.log(`   Mint: ${mint.toString()}`);
    console.log(`   Owner: ${fromKeypair.publicKey.toString()}`);
    console.log(`   Expected ATA: ${fromAtaAddress.toString()}`);
    
    // This should not happen after a successful Jupiter swap, but handle it gracefully
    throw new Error(`Sender ATA not found at ${fromAtaAddress.toString()} after Jupiter swap. The swap may have failed or the token might use Token-2022 program.`);
  } else {
    console.log(`✅ Sender ATA exists: ${fromAtaAddress.toString()}`);
  }
  
  const fromAta = { address: fromAtaAddress };

  // Get or create recipient's ATA
  const toAtaAddress = await getAssociatedTokenAddress(
    mint,
    toPubkey,
    false,
    tokenProgramId
  );
  
  // Check if recipient's ATA exists by checking account info
  const toAtaInfo = await connection.getAccountInfo(toAtaAddress);
  
  if (!toAtaInfo) {
    // Account doesn't exist - create it
    console.log(`Creating recipient ATA for ${toPubkey.toString()}...`);
    
    const tx = new Transaction();
    const createAtaIx = createAssociatedTokenAccountInstruction(
      fromKeypair.publicKey, // payer
      toAtaAddress,          // ATA address
      toPubkey,              // owner
      mint,                  // mint
      tokenProgramId         // token program
    );
    tx.add(createAtaIx);
    
    const createSig = await sendTransactionWithRetries(tx, [fromKeypair], "Create recipient ATA");
    console.log(`✅ Created recipient ATA: ${toAtaAddress.toString()}, tx: ${createSig}`);
  } else {
    console.log(`Recipient ATA already exists: ${toAtaAddress.toString()}`);
  }

  // Pre-check balance to provide clearer errors than token program
  try {
    const preBal = await getAccount(connection, fromAta.address, undefined, tokenProgramId);
    const needed = BigInt(amountNum);
    if (preBal.amount < needed) {
      throw new Error(`Escrow has insufficient $RACE: have=${preBal.amount.toString()} need=${needed.toString()}`);
    }
  } catch (e) {
    // If account cannot be fetched, proceed and let on-chain fail; this is non-fatal
  }

  const ix = createTransferCheckedInstructionManual(
    fromAta.address,
    mint,
    toAtaAddress,
    fromKeypair.publicKey,
    BigInt(amountNum),
    decimals,
    [],
    tokenProgramId
  );

  const tx = new Transaction();
  // Optional memo for idempotency / observability
  if (memo && memo.length > 0) {
    try {
      const memoIx = new TransactionInstruction({
        programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
        keys: [],
        data: Buffer.from(memo, 'utf8')
      });
      tx.add(memoIx);
    } catch {}
  }
  tx.add(ix);
  try {
    const sig = await sendTransactionWithRetries(tx, [fromKeypair], "SPL transfer (checked)");
    console.log("SPL transfer (checked) signature:", sig);
    return sig;
  } catch (err: any) {
    const logs = (err?.logs as string[]) || [];
    if (logs.some(l => l.toLowerCase().includes('insufficient funds'))) {
      throw new Error('Escrow insufficient $RACE for transfer');
    }
    // If we attached a memo, try to fetch and verify the transaction by searching recent history (best-effort)
    throw err;
  }
}

// Mint tokens to address (for faucet)
export async function mintTokensToAddress(
  mint: PublicKey,
  toPubkey: PublicKey,
  amount: bigint | number
): Promise<string> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] mintTokensToAddress ${amount} of ${mint.toString()} to ${toPubkey.toString()}`);
    return `mock-tx-${Date.now()}`;
  }
  const amountNum = typeof amount === 'bigint' ? Number(amount) : amount;
  if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
    throw new Error(`Invalid mint amount (must be safe integer): ${amount.toString()}`);
  }
  const toAta = await getOrCreateAssociatedTokenAccount(
    connection,
    serverKeypair,
    mint,
    toPubkey
  );

  const signature = await mintTo(
    connection,
    serverKeypair,
    mint,
    toAta.address,
    serverKeypair,
    amountNum
  );

  console.log("Mint to signature:", signature);
  return signature;
}

// Verify transaction details
export async function verifyTransaction(
  signature: string,
  expectedMint: PublicKey,
  expectedRecipient: PublicKey,
  expectedAmount: bigint,
  expectedSender?: PublicKey
): Promise<{ valid: boolean; error?: string; memo?: string; slot?: number; blockTimeMs?: number; transfers?: TokenTransfer[] }> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] verifyTransaction ${signature}`);
    return { valid: true, memo: 'mock', slot: 0, blockTimeMs: Date.now(), transfers: [] };
  }
  try {
    console.log(`🔍 Verifying transaction: ${signature}`);
    console.log(`🎯 Expected: mint=${expectedMint.toString()}, recipient=${expectedRecipient.toString()}, amount=${expectedAmount.toString()}, sender=${expectedSender?.toString()}`);

    const parsed = await fetchAndParseTransaction(signature);
    if (!parsed) {
      return { valid: false, error: "Transaction not found or failed" };
    }

    // Find matching transfer using parsed data
    const tokenTransfers = parsed.transfers || [];
    const amountAgnostic = expectedAmount === BigInt(0);
    const matchingTransfer = tokenTransfers.find(transfer => 
      transfer.mint === expectedMint.toString() &&
      transfer.recipient === expectedRecipient.toString() &&
      (amountAgnostic || BigInt(transfer.amount) === expectedAmount) &&
      (!expectedSender || transfer.sender === expectedSender.toString())
    );

    if (!matchingTransfer) {
      console.log(`❌ No matching transfer found. Looking for:`);
      console.log(`   mint: ${expectedMint.toString()}`);
      console.log(`   recipient: ${expectedRecipient.toString()}`); 
      console.log(`   amount: ${expectedAmount.toString()}`);
      console.log(`   sender: ${expectedSender?.toString() || 'any'}`);
      return { valid: false, error: "No matching token transfer found in transaction", transfers: tokenTransfers, memo: parsed.memo, slot: parsed.slot, blockTimeMs: parsed.blockTimeMs };
    }

    console.log(`✅ Matching transfer found!`);
    return { valid: true, memo: parsed.memo, slot: parsed.slot, blockTimeMs: parsed.blockTimeMs, transfers: tokenTransfers };
  } catch (error) {
    console.error("Transaction verification error:", error);
    return { 
      valid: false, 
      error: `Verification failed: ${error instanceof Error ? error.message : String(error)}` 
    };
  }
}

// Verify a native SOL transfer by analyzing lamport balance deltas
export async function verifySolTransfer(
  signature: string,
  expectedRecipient: PublicKey,
  expectedAmountLamports: bigint,
  expectedSender?: PublicKey
): Promise<{ valid: boolean; error?: string; memo?: string; slot?: number; blockTimeMs?: number }> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] verifySolTransfer ${signature}`);
    return { valid: true, memo: 'mock', slot: 0, blockTimeMs: Date.now() };
  }
  try {
    // Retry a few times to handle RPC delay between send and availability of meta
    const delays = [400, 1000, 2000, 4000];
    let tx: any = null;
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      try {
        tx = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (msg.includes('429') || msg.toLowerCase().includes('too many requests')) {
          const delay = attempt <= delays.length ? delays[attempt - 1] : delays[delays.length - 1];
          console.log(`Server responded with 429 Too Many Requests (SOL verify). Retrying after ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        throw e;
      }
      if (tx && tx.meta) break;
      if (attempt <= delays.length) {
        const delay = delays[attempt - 1];
        console.log(`⏳ SOL verify: tx not confirmed yet, waiting ${delay}ms...`);
        await sleep(delay);
      }
    }
    if (!tx || !tx.meta) {
      return { valid: false, error: 'Transaction not found or no meta' };
    }
    const msg = tx.transaction.message as any;
    const accountKeys: string[] = (msg.staticAccountKeys || msg.accountKeys).map((k: any) => k.toString ? k.toString() : String(k));
    const idxRecipient = accountKeys.findIndex(k => k === expectedRecipient.toString());
    const idxSender = expectedSender ? accountKeys.findIndex(k => k === expectedSender.toString()) : -1;
    if (idxRecipient < 0) {
      return { valid: false, error: 'Recipient not in account keys' };
    }
    const pre = tx.meta.preBalances || [];
    const post = tx.meta.postBalances || [];
    const recDelta = BigInt((post[idxRecipient] ?? 0) - (pre[idxRecipient] ?? 0));
    const senderOk = expectedSender ? (BigInt((pre[idxSender] ?? 0) - (post[idxSender] ?? 0)) >= expectedAmountLamports) : true;
    const amountOk = recDelta >= expectedAmountLamports;
    // Parse memo best-effort (support base64, bs58, and log fallback)
    let memo: string | undefined;
    try {
      const memoProgramId = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
      const instructions = (msg.compiledInstructions || msg.instructions || []);
      for (const ix of instructions) {
        const programIdx = typeof ix.programIdIndex === 'number' ? ix.programIdIndex : ix.programIdIndex?.toNumber?.() ?? 0;
        const programIdStr = accountKeys[programIdx];
        if (programIdStr === memoProgramId.toString()) {
          const dataStr = (ix.data && typeof ix.data === 'string') ? ix.data : undefined;
          if (dataStr) {
            // Prefer bs58, fallback to base64
            try {
              const bs58lib = (await import('bs58')).default;
              const buf = bs58lib.decode(dataStr);
              const txt = Buffer.from(buf).toString('utf8');
              if (txt && txt.length > 0) memo = txt;
            } catch {}
            if (!memo) {
              try {
                const buf = Buffer.from(dataStr, 'base64');
                const txt = buf.toString('utf8');
                if (txt && txt.length > 0) memo = txt;
              } catch {}
            }
          }
        }
      }
      // Final fallback: parse from log messages if present
      if (!memo && Array.isArray(tx.meta.logMessages)) {
        const memoLog = tx.meta.logMessages.find((l: string) => l.includes('Memo '));
        if (memoLog) {
          const idx = memoLog.indexOf('Memo ');
          if (idx >= 0) {
            const tail = memoLog.slice(idx + 5).trim();
            // Common format: "Memo (len N): <payload>" -> strip the prefix if present
            const colonIdx = tail.indexOf(':');
            let extracted = colonIdx >= 0 ? tail.slice(colonIdx + 1).trim() : tail;
            // Strip outer quotes if present (log messages often wrap the payload in quotes)
            if (extracted.startsWith('"') && extracted.endsWith('"')) {
              extracted = extracted.slice(1, -1);
            }
            // Unescape any escaped quotes
            try {
              extracted = JSON.parse('"' + extracted + '"');
            } catch {
              // If unescape fails, use as-is
            }
            memo = extracted;
          }
        }
      }
    } catch {}
    // As a final fallback for memo, try the generic parser
    if (!memo) {
      try {
        const parsed = await fetchAndParseTransaction(signature);
        if (parsed && parsed.memo) memo = parsed.memo;
      } catch {}
    }

    const blockTimeMs = typeof tx.blockTime === 'number' ? tx.blockTime * 1000 : undefined;
    const ok = amountOk && senderOk;
    if (!ok) {
      const errParts: string[] = [];
      if (!amountOk) errParts.push(`recipient delta ${recDelta.toString()} < expected ${expectedAmountLamports.toString()}`);
      if (!senderOk) errParts.push('sender delta insufficient');
      return { valid: false, error: errParts.join('; '), memo, slot: tx.slot, blockTimeMs };
    }
    return { valid: true, memo, slot: tx.slot, blockTimeMs };
  } catch (e: any) {
    return { valid: false, error: e?.message || String(e) };
  }
}

interface TokenTransfer {
  mint: string;
  sender: string;
  recipient: string;
  amount: string;
}

function parseTokenTransfers(
  preBalances: any[],
  postBalances: any[]
): TokenTransfer[] {
  const transfers: TokenTransfer[] = [];

  // Index balances by token account address when available to avoid cross-account mismatches
  type BalanceKey = { key: string; mint: string; owner: string };
  const preIndex: BalanceKey[] = [];
  const postIndex: BalanceKey[] = [];

  const getUiAmount = (b: any) => {
    const amt = b?.uiTokenAmount?.amount;
    try { return BigInt(amt ?? 0); } catch { return BigInt(0); }
  };

  for (const b of preBalances || []) {
    preIndex.push({ key: `${b.accountIndex}-${b.mint}`, mint: b.mint, owner: b.owner });
  }
  for (const b of postBalances || []) {
    postIndex.push({ key: `${b.accountIndex}-${b.mint}`, mint: b.mint, owner: b.owner });
  }

  // Map of mint -> list of changes {owner, delta}
  const deltasByMint = new Map<string, Array<{ owner: string; delta: bigint }>>();

  const allKeys = new Set<string>([...preIndex.map(p => p.key), ...postIndex.map(p => p.key)]);
  for (const key of allKeys) {
    const pre = (preBalances || []).find((b: any) => `${b.accountIndex}-${b.mint}` === key);
    const post = (postBalances || []).find((b: any) => `${b.accountIndex}-${b.mint}` === key);
    const mint = (post?.mint ?? pre?.mint) as string;
    const owner = (post?.owner ?? pre?.owner) as string;
    if (!mint || !owner) continue;
    const preAmt = getUiAmount(pre);
    const postAmt = getUiAmount(post);
    const delta = postAmt - preAmt;
    if (delta === BigInt(0)) continue;
    const arr = deltasByMint.get(mint) || [];
    arr.push({ owner, delta });
    deltasByMint.set(mint, arr);
  }

  // For each mint, match negative deltas to positive deltas with equal magnitude
  for (const [mint, changes] of deltasByMint.entries()) {
    const senders = changes.filter(c => c.delta < 0).map(c => ({ owner: c.owner, amount: -c.delta }));
    const recipients = changes.filter(c => c.delta > 0).map(c => ({ owner: c.owner, amount: c.delta }));

    // Greedy match by exact amounts; if multiple fragments exist, multiple transfers will be emitted
    for (const s of senders) {
      const idx = recipients.findIndex(r => r.amount === s.amount);
      if (idx >= 0) {
        const r = recipients[idx];
        transfers.push({ mint, sender: s.owner, recipient: r.owner, amount: s.amount.toString() });
        recipients.splice(idx, 1);
      }
    }
  }

  return transfers;
}

// Get SOL balance
export async function getSolBalance(pubkey: PublicKey): Promise<number> {
  const balance = await connection.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL;
}

// Get SPL token balance
export async function getSplTokenBalance(
  mint: PublicKey,
  owner: PublicKey
): Promise<bigint> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] getSplTokenBalance for ${owner.toString()} mint ${mint.toString()}`);
    return BigInt(0);
  }
  try {
    const tokenProgramId = await getMintTokenProgramId(mint).catch(() => TOKEN_PROGRAM_ID);
    const ata = await getAssociatedTokenAccountAddress(mint, owner, tokenProgramId);
    const account = await getAccount(connection, ata, undefined, tokenProgramId);
    return account.amount;
  } catch (error) {
    // Account doesn't exist, return 0
    return BigInt(0);
  }
}

// ----- Native SOL helpers -----
export async function sendLamports(
  fromKeypair: Keypair,
  toPubkey: PublicKey,
  lamports: number | bigint,
  memo?: string
): Promise<string> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] sendLamports ${lamports} to ${toPubkey.toString()}`);
    return `mock-sol-${Date.now()}`;
  }
  const amountNum = typeof lamports === 'bigint' ? Number(lamports) : lamports;
  if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
    throw new Error(`Invalid lamports amount: ${lamports.toString()}`);
  }

  const ix = SystemProgram.transfer({
    fromPubkey: fromKeypair.publicKey,
    toPubkey,
    lamports: amountNum
  });
  const tx = new Transaction();
  if (memo && memo.length > 0) {
    try {
      const memoIx = new TransactionInstruction({
        programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
        keys: [],
        data: Buffer.from(memo, 'utf8')
      });
      tx.add(memoIx);
    } catch {}
  }
  tx.add(ix);
  const sig = await sendTransactionWithRetries(tx, [fromKeypair], "SOL transfer");
  return sig;
}

export async function transferSolFromEscrow({
  to,
  lamports,
  memo
}: {
  to: PublicKey;
  lamports: number | bigint;
  memo?: string;
}): Promise<string> {
  return sendLamports(serverKeypair, to, lamports, memo);
}

export async function transferSolRakeToTreasury(lamports: bigint): Promise<string> {
  const treasury = treasuryPubkey || serverKeypair.publicKey;
  return sendLamports(serverKeypair, treasury, lamports, 'rake');
}

export async function transferSolJackpot(lamports: bigint): Promise<string> {
  const jackpot = jackpotPubkey || serverKeypair.publicKey;
  return sendLamports(serverKeypair, jackpot, lamports, 'jackpot');
}

// Move SOL from treasury wallet to escrow (server wallet) to cover house seed exposure
export async function transferSolFromTreasuryToEscrow(lamports: bigint): Promise<string> {
  if (!treasuryKeypair) {
    throw new Error('TREASURY_PRIVATE_KEY not set; cannot fund escrow from treasury');
  }
  return sendLamports(treasuryKeypair, serverKeypair.publicKey, lamports, 'house-seed-fund');
}

// Real escrow transfer functions (no minting for payouts/refunds/rake/jackpot)
export async function transferFromEscrow({
  mint,
  to,
  amount,
  memo
}: {
  mint: PublicKey;
  to: PublicKey;
  amount: bigint | number;
  memo?: string;
}): Promise<string> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] Escrow transfer ${amount} of ${mint.toString()} to ${to.toString()}`);
    return `mock-escrow-transfer-${Date.now()}`;
  }
  console.log(`💸 Transferring ${amount} tokens from escrow to ${to.toString()}`);
  
  try {
    const decimals = await getMintDecimals(mint);
    const amountNum = typeof amount === 'bigint' ? Number(amount) : amount;
    if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
      throw new Error(`Invalid transfer amount (must be safe integer): ${amount.toString()}`);
    }
    // Get or create source (escrow) ATA to avoid missing account issues
    const sourceAta = await getOrCreateAssociatedTokenAccount(
      connection,
      serverKeypair,
      mint,
      serverKeypair.publicKey
    );
    
    // Pre-check source balance for clearer error messages
    try {
      const srcAcc = await getAccount(connection, sourceAta.address);
      const need = BigInt(amountNum);
      if (srcAcc.amount < need) {
        throw new Error(`Escrow has insufficient $RACE: have=${srcAcc.amount.toString()} need=${need.toString()}`);
      }
    } catch {}

    // Get or create destination ATA
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      serverKeypair,
      mint,
      to
    );
    
    // Transfer tokens with checked instruction
    const ix = createTransferCheckedInstructionManual(
      sourceAta.address,
      mint,
      destAta.address,
      serverKeypair.publicKey,
      BigInt(amountNum),
      decimals,
      []
    );

    const tx = new Transaction();
    if (memo && memo.length > 0) {
      try {
        const memoIx = new TransactionInstruction({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [],
          data: Buffer.from(memo, 'utf8')
        });
        tx.add(memoIx);
      } catch {}
    }
    tx.add(ix);
    try {
      const txSig = await sendTransactionWithRetries(tx, [serverKeypair], "Escrow transfer");
      console.log(`✅ Transfer completed: ${txSig}`);
      return txSig;
    } catch (err: any) {
      const logs = (err?.logs as string[]) || [];
      if (logs.some(l => l.toLowerCase().includes('insufficient funds'))) {
        throw new Error('Escrow insufficient $RACE for transfer');
      }
      // If preflight/confirmation failed but chain accepted the tx, attempt to detect via balance deltas
      // Best-effort: if destination ATA balance increased since before, we consider it success
      throw err;
    }
    
  } catch (error) {
    console.error(`❌ Transfer failed:`, error);
    throw error;
  }
}

// Batch transfer SOL from escrow to multiple recipients in a single transaction
export async function batchTransferSolFromEscrow(
  transfers: Array<{ to: PublicKey; lamports: number | bigint; memo?: string }>
): Promise<string> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] Batch SOL transfer to ${transfers.length} recipients`);
    return `mock-batch-sol-${Date.now()}`;
  }

  if (transfers.length === 0) {
    throw new Error('Batch transfer requires at least one recipient');
  }

  if (transfers.length > 5) {
    throw new Error('Batch transfer limited to 5 recipients to stay within transaction size limits');
  }

  console.log(`💸 Batch transferring SOL from escrow to ${transfers.length} recipients`);

  const tx = new Transaction();

  // Add memo if provided by any transfer (use first one)
  const firstMemo = transfers.find(t => t.memo)?.memo;
  if (firstMemo && firstMemo.length > 0) {
    try {
      const memoIx = new TransactionInstruction({
        programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
        keys: [],
        data: Buffer.from(firstMemo, 'utf8')
      });
      tx.add(memoIx);
    } catch {}
  }

  // Add all transfer instructions
  for (const transfer of transfers) {
    const amountNum = typeof transfer.lamports === 'bigint' ? Number(transfer.lamports) : transfer.lamports;
    if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
      throw new Error(`Invalid lamports amount in batch: ${transfer.lamports.toString()}`);
    }

    const ix = SystemProgram.transfer({
      fromPubkey: serverKeypair.publicKey,
      toPubkey: transfer.to,
      lamports: amountNum
    });
    tx.add(ix);
  }

  const sig = await sendTransactionWithRetries(tx, [serverKeypair], "Batch SOL transfer");
  console.log(`✅ Batch SOL transfer completed: ${sig} (${transfers.length} recipients)`);
  return sig;
}

// Batch transfer SPL tokens from escrow to multiple recipients in a single transaction
export async function batchTransferTokensFromEscrow(
  mint: PublicKey,
  transfers: Array<{ to: PublicKey; amount: bigint | number; memo?: string }>
): Promise<string> {
  if (MOCK_SOLANA) {
    console.log(`[MOCK] Batch token transfer to ${transfers.length} recipients`);
    return `mock-batch-token-${Date.now()}`;
  }

  if (transfers.length === 0) {
    throw new Error('Batch transfer requires at least one recipient');
  }

  if (transfers.length > 5) {
    throw new Error('Batch transfer limited to 5 recipients to stay within transaction size limits');
  }

  console.log(`💸 Batch transferring tokens from escrow to ${transfers.length} recipients`);

  try {
    const decimals = await getMintDecimals(mint);

    // Get or create source (escrow) ATA
    const sourceAta = await getOrCreateAssociatedTokenAccount(
      connection,
      serverKeypair,
      mint,
      serverKeypair.publicKey
    );

    // Pre-check source balance
    try {
      const srcAcc = await getAccount(connection, sourceAta.address);
      const totalNeed = transfers.reduce((sum, t) => {
        const amt = typeof t.amount === 'bigint' ? Number(t.amount) : t.amount;
        return sum + BigInt(amt);
      }, BigInt(0));
      
      if (srcAcc.amount < totalNeed) {
        throw new Error(`Escrow has insufficient tokens: have=${srcAcc.amount.toString()} need=${totalNeed.toString()}`);
      }
    } catch (err: any) {
      if (!err.message.includes('insufficient')) throw err;
      throw err;
    }

    const tx = new Transaction();

    // Add memo if provided by any transfer (use first one)
    const firstMemo = transfers.find(t => t.memo)?.memo;
    if (firstMemo && firstMemo.length > 0) {
      try {
        const memoIx = new TransactionInstruction({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [],
          data: Buffer.from(firstMemo, 'utf8')
        });
        tx.add(memoIx);
      } catch {}
    }

    // Add all transfer instructions
    for (const transfer of transfers) {
      const amountNum = typeof transfer.amount === 'bigint' ? Number(transfer.amount) : transfer.amount;
      if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
        throw new Error(`Invalid transfer amount in batch: ${transfer.amount.toString()}`);
      }

      // Get or create destination ATA
      const destAta = await getOrCreateAssociatedTokenAccount(
        connection,
        serverKeypair,
        mint,
        transfer.to
      );

      // Add transfer instruction
      const ix = createTransferCheckedInstructionManual(
        sourceAta.address,
        mint,
        destAta.address,
        serverKeypair.publicKey,
        BigInt(amountNum),
        decimals,
        []
      );
      tx.add(ix);
    }

    const txSig = await sendTransactionWithRetries(tx, [serverKeypair], "Batch token transfer");
    console.log(`✅ Batch token transfer completed: ${txSig} (${transfers.length} recipients)`);
    return txSig;

  } catch (error) {
    console.error(`❌ Batch token transfer failed:`, error);
    throw error;
  }
}

export async function transferRakeToTreasury({
  mint,
  amount
}: {
  mint: PublicKey;
  amount: bigint;
}): Promise<string> {
  const treasury = treasuryPubkey || serverKeypair.publicKey;
  console.log(`🏦 Transferring ${amount} rake to treasury: ${treasury.toString()}`);
  
  return transferFromEscrow({ mint, to: treasury, amount });
}

export async function transferJackpot({
  mint,
  amount
}: {
  mint: PublicKey;
  amount: bigint;
}): Promise<string> {
  const jackpot = jackpotPubkey || serverKeypair.publicKey;
  console.log(`🎰 Transferring ${amount} to jackpot: ${jackpot.toString()}`);
  
  return transferFromEscrow({ mint, to: jackpot, amount });
}

// Move SPL jackpot funds from the jackpot wallet back into escrow (server wallet)
export async function transferJackpotToEscrow({
  mint,
  amount
}: {
  mint: PublicKey;
  amount: bigint;
}): Promise<string> {
  // If jackpot is the same as escrow wallet, no transfer is needed
  if (!jackpotPubkey || jackpotPubkey.equals(serverKeypair.publicKey)) {
    console.log('🎰 Jackpot pull skipped (jackpot wallet equals escrow)');
    return 'noop';
  }
  if (!jackpotKeypair) {
    throw new Error('JACKPOT_PRIVATE_KEY not set; cannot pull jackpot funds back to escrow');
  }
  console.log(`🎰 Pulling ${amount} from jackpot to escrow: ${serverKeypair.publicKey.toString()}`);
  return sendSplTokens(mint, jackpotKeypair, serverKeypair.publicKey, amount, 'jackpot-pull');
}

// Move native SOL jackpot funds from jackpot wallet back to escrow (server wallet)
export async function transferSolFromJackpot(lamports: bigint): Promise<string> {
  if (!jackpotPubkey || jackpotPubkey.equals(serverKeypair.publicKey)) {
    console.log('🎰 SOL jackpot pull skipped (jackpot wallet equals escrow)');
    return 'noop';
  }
  if (!jackpotKeypair) {
    throw new Error('JACKPOT_PRIVATE_KEY not set; cannot pull SOL jackpot funds back to escrow');
  }
  console.log(`🎰 Pulling ${lamports.toString()} lamports from jackpot to escrow`);
  return sendLamports(jackpotKeypair, serverKeypair.publicKey, lamports, 'jackpot-pull');
}

// Helper to get or create race mint
export async function getRaceMint(): Promise<PublicKey> {
  if (raceMintAddress) {
    return new PublicKey(raceMintAddress);
  }
  
  // Fallback to treasury race mint
  const { getDb } = await import('./db');
  const treasury = await getDb().getTreasury();
  
  if (treasury.raceMint) {
    return new PublicKey(treasury.raceMint);
  }
  
  throw new Error('No RACE mint configured');
}
