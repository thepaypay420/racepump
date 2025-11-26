import NodeCache from "node-cache";
import Decimal from "decimal.js";
import {
  PublicKey,
  VersionedTransaction,
  Transaction,
  TransactionInstruction,
  MessageCompiledInstruction,
  CompiledInstruction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getDb } from "./db";
import { getJupiterQuote, getJupiterSwapTransaction, JupiterSwapQuote } from "./jupiter";
import { connection, getMintDecimals, treasuryPubkey, raceMintAddress } from "./solana";
import {
  ReflectionTokenMeta,
  RaceswapPlanResponse,
  RaceswapPublicConfig,
} from "@shared/raceswap";
import { registerCache } from "./cache-coordinator";

const JUPITER_PROGRAM_ID = new PublicKey("JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJk");
const CONFIG_SEED = Buffer.from("raceswap-config");
const AUTHORITY_SEED = Buffer.from("raceswap-authority");
const FEE_DENOMINATOR = new Decimal(10_000);
const DEFAULT_PROGRAM_ID = new PublicKey("Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk");
const DEFAULT_CONFIG_PDA = new PublicKey("EaD9EQSfe7Lnz5c12vaEasmrje7xtML9vUEJsCYuLpHP");
const DEFAULT_TREASURY_WALLET = new PublicKey("Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L");
const DEFAULT_REFLECTION_FEE_BPS = 100;
const DEFAULT_TREASURY_FEE_BPS = 20;

// DUST THRESHOLD: Skip reflection swap if amount is below this value (1000 lamports ~= 0.000001 SOL)
// This prevents failing routes and unnecessary instructions for tiny reflection amounts
const DUST_THRESHOLD_LAMPORTS = 1000n;

// MINIMUM BUY AMOUNT: Recommended minimum to ensure 1% reflection is meaningful (0.01 SOL = 10,000,000 lamports)
// At 0.01 SOL, the 1% reflection is 0.0001 SOL = 100,000 lamports (well above dust threshold)
export const MINIMUM_BUY_LAMPORTS = 10_000_000n;

// SMALL REFLECTION THRESHOLD: Use aggressive optimizations for reflections below this value (0.001 SOL = 1,000,000 lamports)
const SMALL_REFLECTION_THRESHOLD_LAMPORTS = 1_000_000n;

type RouteConstraintProfile = {
  name: string;
  maxAccounts: number;
  onlyDirectRoutes?: boolean;
  restrictIntermediateTokens?: boolean;
  slippageBps?: number;
};

function isRouteAvailabilityError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("no route") ||
    msg.includes("route not found") ||
    msg.includes("could not find any route") ||
    msg.includes("max account") ||
    msg.includes("maxaccounts") ||
    msg.includes("path not found") ||
    msg.includes("market not supported")
  );
}

function buildRouteConstraintProfiles(args: {
  isReflection: boolean;
  isTinyReflection: boolean;
  amountLamports: bigint;
  baseSlippageBps: number;
}): RouteConstraintProfile[] {
  const { isReflection, isTinyReflection, amountLamports, baseSlippageBps } = args;

  if (isReflection) {
    if (isTinyReflection) {
      return [
        {
          name: "reflection-direct-tight",
          maxAccounts: 18,
          onlyDirectRoutes: true,
          restrictIntermediateTokens: true,
          slippageBps: Math.max(baseSlippageBps, 500),
        },
        {
          name: "reflection-direct-relaxed",
          maxAccounts: 22,
          onlyDirectRoutes: true,
          restrictIntermediateTokens: true,
          slippageBps: Math.max(baseSlippageBps, 400),
        },
        {
          name: "reflection-flex",
          maxAccounts: 28,
          slippageBps: Math.max(baseSlippageBps, 300),
        },
      ];
    }

    return [
      {
        name: "reflection-default",
        maxAccounts: 26,
        slippageBps: Math.max(baseSlippageBps, 300),
      },
      {
        name: "reflection-wide",
        maxAccounts: 32,
        slippageBps: Math.max(baseSlippageBps, 400),
      },
    ];
  }

  if (amountLamports > MINIMUM_BUY_LAMPORTS * 100n) {
    return [
      { name: "main-large", maxAccounts: 36, slippageBps: Math.max(baseSlippageBps, 200) },
      { name: "main-large-fallback", maxAccounts: 42, slippageBps: Math.max(baseSlippageBps, 300) },
    ];
  }

  if (amountLamports > MINIMUM_BUY_LAMPORTS * 20n) {
    return [
      { name: "main-medium", maxAccounts: 32, slippageBps: Math.max(baseSlippageBps, 200) },
      { name: "main-medium-fallback", maxAccounts: 38, slippageBps: Math.max(baseSlippageBps, 300) },
    ];
  }

  if (amountLamports > MINIMUM_BUY_LAMPORTS * 5n) {
    return [
      { name: "main-small", maxAccounts: 28, slippageBps: Math.max(baseSlippageBps, 250) },
      { name: "main-small-fallback", maxAccounts: 34, slippageBps: Math.max(baseSlippageBps, 350) },
    ];
  }

  return [
    {
      name: "main-tiny-direct",
      maxAccounts: 24,
      restrictIntermediateTokens: true,
      slippageBps: Math.max(baseSlippageBps, 300),
    },
    {
      name: "main-tiny-flex",
      maxAccounts: 30,
      slippageBps: Math.max(baseSlippageBps, 400),
    },
  ];
}

async function fetchQuoteWithProfiles(args: {
  legLabel: string;
  inputMint: string;
  outputMint: string;
  amount: bigint;
  baseSlippageBps: number;
  profiles: RouteConstraintProfile[];
  isReflectionSwap: boolean;
}): Promise<{ quote: JupiterSwapQuote; profile: RouteConstraintProfile }> {
  const { legLabel, inputMint, outputMint, amount, baseSlippageBps, profiles, isReflectionSwap } = args;
  let lastError: unknown = null;

  for (const profile of profiles) {
    try {
      const quote = await getJupiterQuote({
        inputMint,
        outputMint,
        amount,
        slippageBps: profile.slippageBps ?? baseSlippageBps,
        maxAccounts: profile.maxAccounts,
        onlyDirectRoutes: profile.onlyDirectRoutes,
        restrictIntermediateTokens: profile.restrictIntermediateTokens,
        isReflectionSwap,
      });
      console.log(
        `[raceswap] Quote for ${legLabel} succeeded with profile ${profile.name} (maxAccounts=${profile.maxAccounts}, slippage=${profile.slippageBps ?? baseSlippageBps}bps, direct=${profile.onlyDirectRoutes ? "yes" : "no"})`
      );
      return { quote, profile };
    } catch (error) {
      lastError = error;
      const errMsg = error instanceof Error ? error.message : String(error);
      if (isRouteAvailabilityError(error)) {
        console.warn(`[raceswap] Quote attempt ${profile.name} for ${legLabel} failed: ${errMsg}`);
        continue;
      }
      throw error;
    }
  }

  const finalMessage =
    lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "unknown error";
  throw new Error(`[raceswap] No Jupiter route satisfied constraints for ${legLabel}: ${finalMessage}`);
}

const reflectionCache = new NodeCache({ stdTTL: 20, checkperiod: 30 });
registerCache("raceswapReflection", reflectionCache);

export class RaceswapPlanError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "RaceswapPlanError";
    this.statusCode = statusCode;
  }
}

const FALLBACK_REFLECTION_MINT = (() => {
  const fromEnv = process.env.RACESWAP_REFLECTION_FALLBACK_MINT?.trim();
  if (fromEnv) return fromEnv;
  return raceMintAddress?.trim();
})();
const FALLBACK_REFLECTION_SYMBOL = process.env.RACESWAP_REFLECTION_SYMBOL?.trim() || "RACE";
const FALLBACK_REFLECTION_NAME = process.env.RACESWAP_REFLECTION_NAME?.trim() || "Pump Racers";
const FALLBACK_REFLECTION_LOGO = process.env.RACESWAP_REFLECTION_LOGO?.trim() || "/racepump.svg";

async function resolveFallbackReflectionMeta(): Promise<ReflectionTokenMeta | null> {
  if (!FALLBACK_REFLECTION_MINT) {
    return null;
  }
  try {
    const fallbackMintKey = new PublicKey(FALLBACK_REFLECTION_MINT);
    const decimals = await getMintDecimals(fallbackMintKey);
    return {
      mint: FALLBACK_REFLECTION_MINT,
      symbol: FALLBACK_REFLECTION_SYMBOL,
      name: FALLBACK_REFLECTION_NAME,
      logoURI: FALLBACK_REFLECTION_LOGO,
      decimals,
      lastUpdated: Date.now(),
      reflectionEnabled: true,
    };
  } catch (error) {
    console.warn("[raceswap] fallback reflection mint invalid:", error);
    return null;
  }
}

export interface BuildRaceswapPlanInput {
  inputMint: string;
  outputMint: string;
  totalAmount: string;
  slippageBps: number;
  disableReflection?: boolean;
  forceNuclear?: boolean;
  reflectionMintOverride?: string;
}

interface FeeConfig {
  reflectionFeeBps: number;
  treasuryFeeBps: number;
  treasuryWallet: PublicKey;
  programId: PublicKey;
}

export function getRaceswapProgramId(): PublicKey {
  try {
    const fromEnv = process.env.RACESWAP_PROGRAM_ID;
    if (fromEnv) return new PublicKey(fromEnv);
  } catch (e) {
    console.warn("[raceswap] invalid RACESWAP_PROGRAM_ID env:", e);
  }
  return DEFAULT_PROGRAM_ID;
}

function getConfiguredConfigPda(programId: PublicKey): PublicKey | null {
  try {
    const fromEnv = process.env.RACESWAP_CONFIG_PDA;
    if (fromEnv) {
      return new PublicKey(fromEnv);
    }
  } catch (e) {
    console.warn("[raceswap] invalid RACESWAP_CONFIG_PDA env:", e);
  }
  if (programId.equals(DEFAULT_PROGRAM_ID)) {
    return DEFAULT_CONFIG_PDA;
  }
  return null;
}

export function deriveConfigAddress(programId = getRaceswapProgramId()): [PublicKey, number] {
  const configured = getConfiguredConfigPda(programId);
  if (configured) {
    return [configured, 255];
  }
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

export function deriveSwapAuthority(configAddress: PublicKey, programId = getRaceswapProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AUTHORITY_SEED, configAddress.toBuffer()], programId);
}

function readFeeBps(rawValue: string | undefined, fallback: number): number {
  if (!rawValue || !rawValue.trim()) return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[raceswap] invalid fee value "${rawValue}", falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function getFeeConfig(): FeeConfig {
  const programId = getRaceswapProgramId();
  const reflectionFee = readFeeBps(process.env.RACESWAP_REFLECTION_FEE_BPS, DEFAULT_REFLECTION_FEE_BPS);
  const treasuryFee = readFeeBps(process.env.RACESWAP_TREASURY_FEE_BPS, DEFAULT_TREASURY_FEE_BPS);
  let treasuryWallet: PublicKey;
  try {
    const fromEnv = process.env.RACESWAP_TREASURY_WALLET;
    if (fromEnv) {
      treasuryWallet = new PublicKey(fromEnv);
    } else if (treasuryPubkey) {
      treasuryWallet = treasuryPubkey;
    } else {
      treasuryWallet = DEFAULT_TREASURY_WALLET;
    }
  } catch (e) {
    console.warn("[raceswap] invalid treasury wallet, falling back to defaults", e);
    treasuryWallet = treasuryPubkey ?? DEFAULT_TREASURY_WALLET;
  }
  return {
    reflectionFeeBps: reflectionFee,
    treasuryFeeBps: treasuryFee,
    treasuryWallet,
    programId,
  };
}

export async function getReflectionTokenMeta(forceRefresh = false): Promise<ReflectionTokenMeta> {
  const cached = forceRefresh ? null : reflectionCache.get<ReflectionTokenMeta>("latest");
  if (cached) {
    return cached;
  }

  const disableReflectionEnv =
    String(process.env.RACESWAP_DISABLE_REFLECTION || "").toLowerCase() === "true" ||
    String(process.env.RACESWAP_DISABLE_REFLECTION || "").toLowerCase() === "1";

  if (disableReflectionEnv) {
    const disabled: ReflectionTokenMeta = {
      mint: "",
      symbol: "",
      name: "",
      decimals: 0,
      lastUpdated: Date.now(),
      disabledReason: "disabled_via_env",
    };
    reflectionCache.set("latest", disabled);
    return disabled;
  }

  try {
    // Fast path: try recent_winners table first (optimized for this use case)
    const db = getDb();
    let recentResult = db?.getRecentWinners(1);
    // Handle both sync (SQLite) and async (Postgres) getRecentWinners methods
    let recent = recentResult instanceof Promise ? await recentResult : recentResult;
    
    // Fast fallback: if recent_winners is empty, query settled races directly
    // This ensures raceswap always gets the latest winner quickly
    if (!recent || recent.length === 0) {
      const { RaceStatus } = await import("@shared/schema");
      const db = getDb();
      if (db) {
        // Handle both sync (SQLite) and async (Postgres) getRaces methods
        const settledRacesResult = db.getRaces(RaceStatus.SETTLED as any);
        const settledRaces = settledRacesResult instanceof Promise 
          ? await settledRacesResult 
          : settledRacesResult;
        
        // Sort by settled time (most recent first) and filter for races with winners
        const racesWithWinners = (settledRaces || [])
          .filter((r: any) => r.winnerIndex !== undefined && r.runners?.length > 0)
          .sort((a: any, b: any) => (b.settledBlockTimeMs || b.startTs || 0) - (a.settledBlockTimeMs || a.startTs || 0));
        
        if (racesWithWinners.length > 0) {
          recent = [racesWithWinners[0]];
        }
      }
    }
    
    if (!recent || recent.length === 0) {
      throw new Error("No settled races yet");
    }
    const race = recent[0];
    const winnerIdx = race.winnerIndex ?? race.runners?.findIndex((_: any, idx: number) => idx === race.winnerIndex) ?? 0;
    const winner = race.runners?.[winnerIdx];
    if (!winner?.mint) {
      throw new Error("Winner mint missing");
    }
    const decimals = await getMintDecimals(new PublicKey(winner.mint));
    const meta: ReflectionTokenMeta = {
      mint: winner.mint,
      symbol: winner.symbol || "WIN",
      name: winner.name || winner.symbol || "Winner",
      logoURI: winner.logoURI,
      decimals,
      raceId: race.id,
      lastUpdated: Date.now(),
      reflectionEnabled: true,
    };
    reflectionCache.set("latest", meta);
    return meta;
  } catch (error) {
    const fallbackMeta = await resolveFallbackReflectionMeta();
    if (fallbackMeta) {
      reflectionCache.set("latest", fallbackMeta);
      return fallbackMeta;
    }
    const disabled: ReflectionTokenMeta = {
      mint: "",
      symbol: "",
      name: "",
      decimals: 0,
      disabledReason: (error as Error)?.message || "failed_fetch_recent_winner",
      lastUpdated: Date.now(),
      reflectionEnabled: false,
    };
    reflectionCache.set("latest", disabled);
    return disabled;
  }
}

export async function buildRaceswapPlan(params: BuildRaceswapPlanInput): Promise<RaceswapPlanResponse> {
  if (params.inputMint === params.outputMint) {
    throw new RaceswapPlanError("Input and output tokens must be different", 400);
  }

  const feeConfig = getFeeConfig();
  const configAddress = deriveConfigAddress(feeConfig.programId)[0];
  const swapAuthority = deriveSwapAuthority(configAddress, feeConfig.programId)[0];
  const inputMintKey = new PublicKey(params.inputMint);
  const outputMintKey = new PublicKey(params.outputMint);
  
  // Fetch actual decimals from chain to ensure accurate quote display
  const [inputDecimals, outputDecimals] = await Promise.all([
    getMintDecimals(inputMintKey),
    getMintDecimals(outputMintKey),
  ]);

  // Use BigInt for precise lamport calculations
  const totalAmount = BigInt(params.totalAmount);
  if (totalAmount <= 0n) {
    throw new Error("totalAmount must be positive");
  }
  
  // Log minimum buy amount warning for very small swaps
  if (totalAmount < MINIMUM_BUY_LAMPORTS) {
    console.warn(`[raceswap] Swap amount ${totalAmount} lamports is below recommended minimum of ${MINIMUM_BUY_LAMPORTS} lamports (0.01 SOL). Reflection may be very small or skipped.`);
  }

  const minDisableReflection = params.disableReflection || false;
  const rawReflectionMeta = await getReflectionTokenMeta();
  const reflectionMeta = { ...rawReflectionMeta };

  if (params.reflectionMintOverride) {
      console.log(`[raceswap] Overriding reflection mint to: ${params.reflectionMintOverride}`);
      reflectionMeta.mint = params.reflectionMintOverride;
      reflectionMeta.reflectionEnabled = true;
      reflectionMeta.disabledReason = undefined;
  }

  let reflectionDisabled = minDisableReflection || !reflectionMeta.mint || Boolean(reflectionMeta.disabledReason);
  let reflectionDisabledReason = reflectionDisabled
    ? reflectionMeta.disabledReason ?? "reflection_disabled"
    : undefined;

  let effectiveReflectionMint = reflectionDisabled ? params.outputMint : reflectionMeta.mint!;
  if (!reflectionDisabled && effectiveReflectionMint === params.inputMint) {
    reflectionDisabled = true;
    reflectionDisabledReason = "reflection_matches_input";
    effectiveReflectionMint = params.outputMint;
  }
  const reflectionEnabled = !reflectionDisabled;
  const reflectionMetaForPlan: ReflectionTokenMeta = {
    ...reflectionMeta,
    mint: reflectionEnabled ? reflectionMeta.mint! : params.outputMint,
    reflectionEnabled,
    disabledReason: reflectionEnabled ? undefined : reflectionDisabledReason,
  };

  const reflectionFee = reflectionDisabled ? 0 : feeConfig.reflectionFeeBps;
  const treasuryFee = feeConfig.treasuryFeeBps;
  const totalDec = new Decimal(params.totalAmount);
  const { reflectionAmount, treasuryAmount, mainAmount } = splitSwapAmounts(totalDec, reflectionFee, treasuryFee);
  
  // DUST THRESHOLD CHECK: Skip reflection if below threshold to avoid tx failures
  // Convert reflectionAmount to BigInt for precise comparison
  const reflectionAmountBigInt = BigInt(reflectionAmount.toFixed(0));
  const isReflectionBelowDust = reflectionAmountBigInt < DUST_THRESHOLD_LAMPORTS;
  
  if (isReflectionBelowDust && !reflectionDisabled) {
    console.warn(`[raceswap] Reflection amount ${reflectionAmountBigInt} lamports is below dust threshold ${DUST_THRESHOLD_LAMPORTS}. Skipping reflection swap and merging into main swap.`);
    reflectionDisabled = true;
    reflectionDisabledReason = "reflection_below_dust_threshold";
    effectiveReflectionMint = params.outputMint;
  }
  
  // Recalculate amounts if reflection was disabled due to dust
  const finalReflectionFee = reflectionDisabled ? 0 : feeConfig.reflectionFeeBps;
  const finalAmounts = finalReflectionFee !== reflectionFee 
    ? splitSwapAmounts(totalDec, finalReflectionFee, treasuryFee)
    : { reflectionAmount, treasuryAmount, mainAmount };

  const slippageBps = Number(params.slippageBps ?? 300) || 300; // 3% default slippage
  const legs: Array<{
    kind: "main" | "reflection";
    amount: Decimal;
    inputMint: string;
    outputMint: string;
  }> = [
    {
      kind: "main",
      amount: finalAmounts.mainAmount,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
    },
  ];

  if (!reflectionDisabled && finalAmounts.reflectionAmount.gt(0)) {
    legs.unshift({
      kind: "reflection",
      amount: finalAmounts.reflectionAmount,
      inputMint: params.inputMint,
      outputMint: effectiveReflectionMint,
    });
  }

    const quotes: JupiterSwapQuote[] = [];
    const chosenProfiles: Record<"main" | "reflection", string | undefined> = {
      main: undefined,
      reflection: undefined,
    };

    for (const leg of legs) {
      const amountBigInt = BigInt(leg.amount.toString());
      const isReflection = leg.kind === "reflection";
      
      let profiles: RouteConstraintProfile[];
      if (params.forceNuclear) {
          console.log(`[raceswap] Using NUCLEAR settings for ${leg.kind} leg`);
          profiles = [{
              name: "nuclear",
              maxAccounts: 20,
              onlyDirectRoutes: true,
              restrictIntermediateTokens: true,
              slippageBps: 5000,
          }];
          // Add fallback for Main leg if nuclear fails
          if (leg.kind === 'main') {
              profiles.push({
                  name: "nuclear-fallback",
                  maxAccounts: 30,
                  onlyDirectRoutes: false,
                  restrictIntermediateTokens: false,
                  slippageBps: 5000
              });
          }
      } else {
          profiles = buildRouteConstraintProfiles({
            isReflection,
            isTinyReflection: isReflection && amountBigInt < SMALL_REFLECTION_THRESHOLD_LAMPORTS,
            amountLamports: amountBigInt,
            baseSlippageBps: slippageBps,
          });
      }

      console.log(
        `[raceswap] ${leg.kind} leg constraint profiles:`,
        profiles.map((p) => `${p.name}<=${p.maxAccounts}`).join(", ")
      );

      const { quote, profile } = await fetchQuoteWithProfiles({
        legLabel: leg.kind,
        inputMint: leg.inputMint,
        outputMint: leg.outputMint,
        amount: amountBigInt,
        baseSlippageBps: slippageBps,
        profiles,
        isReflectionSwap: isReflection,
      });

      chosenProfiles[leg.kind] = profile.name;
      quotes.push(quote);
    }

    console.log("[raceswap] Selected Jupiter route profiles:", chosenProfiles);

    // Validate all quotes are valid
    console.log(`[raceswap] Validating ${quotes.length} quotes...`);
    for (let i = 0; i < quotes.length; i++) {
      const quote = quotes[i];
      if (!quote || !quote.outAmount || typeof quote.outAmount !== 'string') {
        throw new Error(`Invalid quote received for leg ${i}: ${JSON.stringify(quote)}`);
      }
      console.log(`[raceswap] Quote ${i} (${legs[i].kind}): ${quote.routePlan?.length || 0} hops, output=${quote.outAmount}`);
    }

    const planLegs: Record<
      "main" | "reflection",
      | {
          data: string;
          accounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[];
          outAmount: string;
          minOut: string;
        }
      | undefined
    > = {
      main: undefined,
      reflection: undefined,
    };

    const remainingAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[] = [];
      const lookupTableAddresses = new Set<string>();

    let detectedJupiterProgramId: string | undefined;
    let totalComputeUnitLimit = 0;
    let maxComputeUnitPrice = 0n;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const quote = quotes[i];
      
      // Validate quote has required fields
      if (!quote || !quote.outAmount || typeof quote.outAmount !== 'string') {
        throw new Error(`Invalid quote for ${leg.kind} leg: missing or invalid outAmount`);
      }

      // Use Jupiter's otherAmountThreshold directly - DO NOT modify it
      // Jupiter's swap transaction already has the correct slippage encoded
      // Modifying otherAmountThreshold creates a mismatch with the instruction data
      console.log(`[raceswap] ${leg.kind} leg slippage: ${quote.slippageBps}bps, otherAmountThreshold: ${quote.otherAmountThreshold}`);
      
        let payload: Awaited<ReturnType<typeof extractJupiterInstructionPayload>> | null = null;
        let lastSwapError: unknown = null;
        const swapAttempts = [
          { label: "versioned_lut", legacy: false },
          { label: "legacy_fallback", legacy: true },
        ];
        for (const attempt of swapAttempts) {
          try {
            const swap = await getJupiterSwapTransaction(
              quote,
              swapAuthority.toBase58(),
              false,
              undefined,
              {
                useLegacyTransaction: attempt.legacy,
                isReflectionSwap: leg.kind === "reflection",
              }
            );
            payload = await extractJupiterInstructionPayload(swap.swapTransaction);
            if (attempt.legacy) {
              console.warn("[raceswap] Jupiter swap fallback: using legacy transaction without lookup tables");
            }
            break;
          } catch (error) {
            lastSwapError = error;
            console.warn(
              `[raceswap] Jupiter swap ${attempt.label} attempt failed:`,
              error instanceof Error ? error.message : error
            );
          }
        }
        if (!payload) {
          throw lastSwapError instanceof Error
            ? lastSwapError
            : new Error("Failed to build Jupiter swap transaction for raceswap plan");
        }

      if (!detectedJupiterProgramId) {
        detectedJupiterProgramId = payload.jupiterProgramId;
      }

      if (payload.computeUnitLimit) {
        totalComputeUnitLimit += payload.computeUnitLimit;
      }
      if (payload.computeUnitPrice) {
        const price = BigInt(payload.computeUnitPrice);
        if (price > maxComputeUnitPrice) {
          maxComputeUnitPrice = price;
        }
      }

        payload.addressLookupTableAddresses.forEach((addr) => {
          if (addr && addr.trim().length > 0) {
            lookupTableAddresses.add(addr.trim());
          }
        });
      
      console.log(`[raceswap] ${leg.kind} leg payload: ${payload.accounts.length} accounts, ${Buffer.from(payload.data, 'base64').length} bytes data`);
      
      // Ensure minOut is always a valid string
      const minOut = (quote.otherAmountThreshold && typeof quote.otherAmountThreshold === 'string') 
        ? quote.otherAmountThreshold 
        : quote.outAmount;
      
      if (!minOut || typeof minOut !== 'string') {
        throw new Error(`Invalid minOut for ${leg.kind} leg: ${minOut}`);
      }
      
      planLegs[leg.kind] = {
        data: payload.data,
        accounts: payload.accounts,
        outAmount: quote.outAmount,
        minOut: minOut,
      };
      remainingAccounts.push(...payload.accounts);
    }

    const inputVault = await getAssociatedTokenAddress(inputMintKey, swapAuthority, true);

  // Validate main leg exists (required)
  if (!planLegs.main || !planLegs.main.minOut || typeof planLegs.main.minOut !== 'string') {
    throw new Error("Main swap leg is missing or invalid");
  }

  // Build mainLeg payload with accounts as array of base58 strings
  const mainLegAccounts = (planLegs.main.accounts ?? []).map((a) => a.pubkey);
  const mainLegPayload = {
    accounts: mainLegAccounts,
    isWritable: (planLegs.main.accounts ?? []).map((a) => a.isWritable),
    isSigner: (planLegs.main.accounts ?? []).map((a) => a.isSigner),
    data: planLegs.main.data ?? "",
  };

  // Build reflectionLeg payload if present
  const reflectionLegPayload = planLegs.reflection
    ? {
        accounts: planLegs.reflection.accounts.map((a) => a.pubkey),
        isWritable: planLegs.reflection.accounts.map((a) => a.isWritable),
        isSigner: planLegs.reflection.accounts.map((a) => a.isSigner),
        data: planLegs.reflection.data,
      }
    : undefined;

  // Log plan structure for debugging
  console.log("[raceswap] RACESWAP PLAN mainLeg:", JSON.stringify({
    payload: {
      accountsLength: mainLegPayload.accounts.length,
      accountsFirst3: mainLegPayload.accounts.slice(0, 3),
      accountsTypes: mainLegPayload.accounts.slice(0, 3).map(a => typeof a),
      isWritableLength: mainLegPayload.isWritable.length,
      isSignerLength: mainLegPayload.isSigner.length,
      dataLength: mainLegPayload.data.length,
    },
  }, null, 2));
  
  if (reflectionLegPayload) {
    console.log("[raceswap] RACESWAP PLAN reflectionLeg:", JSON.stringify({
      payload: {
        accountsLength: reflectionLegPayload.accounts.length,
        accountsFirst3: reflectionLegPayload.accounts.slice(0, 3),
        accountsTypes: reflectionLegPayload.accounts.slice(0, 3).map(a => typeof a),
        isWritableLength: reflectionLegPayload.isWritable.length,
        isSignerLength: reflectionLegPayload.isSigner.length,
        dataLength: reflectionLegPayload.data.length,
      },
    }, null, 2));
  }

  const plan: RaceswapPlanResponse = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    reflectionMint: effectiveReflectionMint,
    totalAmount: totalDec.toFixed(0),
    reflectionAmount: finalAmounts.reflectionAmount.toFixed(0),
    treasuryAmount: finalAmounts.treasuryAmount.toFixed(0),
    mainAmount: finalAmounts.mainAmount.toFixed(0),
    minMainOut: planLegs.main.minOut,
    minReflectionOut: (planLegs.reflection?.minOut && typeof planLegs.reflection.minOut === 'string') 
      ? planLegs.reflection.minOut 
      : "0",
      disableReflection: reflectionDisabled || !planLegs.reflection,
      reflectionDisabledReason: reflectionDisabled ? reflectionDisabledReason ?? "disabled" : undefined,
    reflectionMeta: reflectionMetaForPlan,
    mainLeg: {
      payload: mainLegPayload,
    },
    reflectionLeg: reflectionLegPayload
      ? {
          payload: reflectionLegPayload,
        }
      : undefined,
    accounts: remainingAccounts.map(a => a.pubkey),
    accountMetas: remainingAccounts.map(a => ({ isWritable: a.isWritable, isSigner: a.isSigner })),
    quoteExpiresAt: Date.now() + 15_000,
    feeConfig: {
      reflectionFeeBps: feeConfig.reflectionFeeBps,
      treasuryFeeBps: feeConfig.treasuryFeeBps,
    },
    treasuryWallet: feeConfig.treasuryWallet.toBase58(),
    programId: feeConfig.programId.toBase58(),
    configAddress: configAddress.toBase58(),
    swapAuthority: swapAuthority.toBase58(),
    inputVault: inputVault.toBase58(),
    jupiterProgramId: detectedJupiterProgramId || JUPITER_PROGRAM_ID.toBase58(),
      addressLookupTableAddresses: Array.from(lookupTableAddresses),
      inputDecimals,
    outputDecimals,
    computeUnitLimit: totalComputeUnitLimit > 0 ? Math.min(totalComputeUnitLimit + 300000, 1_400_000) : undefined,
    computeUnitPrice: maxComputeUnitPrice > 0n ? maxComputeUnitPrice.toString() : undefined,
  };

  return plan;
}

export function splitSwapAmounts(totalAmount: Decimal, reflectionFeeBps: number, treasuryFeeBps: number) {
  if (totalAmount.lte(0)) {
    throw new Error("totalAmount must be positive");
  }
  if (reflectionFeeBps < 0 || treasuryFeeBps < 0) {
    throw new Error("Fee bps cannot be negative");
  }
  if (reflectionFeeBps + treasuryFeeBps >= FEE_DENOMINATOR.toNumber()) {
    throw new Error("Invalid fee configuration");
  }
  const reflectionAmount = totalAmount.mul(reflectionFeeBps).div(FEE_DENOMINATOR).floor();
  const treasuryAmount = totalAmount.mul(treasuryFeeBps).div(FEE_DENOMINATOR).floor();
  const mainAmount = totalAmount.sub(reflectionAmount).sub(treasuryAmount);
  if (mainAmount.lte(0)) {
    throw new Error("Main swap amount is zero");
  }
  return {
    reflectionAmount,
    treasuryAmount,
    mainAmount,
  };
}

export async function getRaceswapPublicConfig(): Promise<RaceswapPublicConfig> {
  const feeConfig = getFeeConfig();
  const programId = feeConfig.programId;
  const [configAddress] = deriveConfigAddress(programId);
  const [swapAuthority] = deriveSwapAuthority(configAddress, programId);
  const reflectionMeta = await getReflectionTokenMeta();
  const reflectionEnabled = Boolean(reflectionMeta.mint) && !reflectionMeta.disabledReason;

  return {
    programId: programId.toBase58(),
    configAddress: configAddress.toBase58(),
    swapAuthority: swapAuthority.toBase58(),
    treasuryWallet: feeConfig.treasuryWallet.toBase58(),
    reflectionFeeBps: feeConfig.reflectionFeeBps,
    treasuryFeeBps: feeConfig.treasuryFeeBps,
    reflectionEnabled,
    reflectionDisabledReason: reflectionEnabled ? undefined : reflectionMeta.disabledReason,
  };
}

async function extractJupiterInstructionPayload(serializedTxBase64: string): Promise<{
  data: string;
  accounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[];
  jupiterProgramId: string;
  addressLookupTableAddresses: string[];
  computeUnitLimit?: number;
  computeUnitPrice?: string;
}> {
  const raw = Buffer.from(serializedTxBase64, "base64");

  const resolveInstructionAccountIndexes = (
    instruction: CompiledInstruction | MessageCompiledInstruction
  ): number[] => {
    const directAccounts = (instruction as { accounts?: number[] }).accounts;
    if (Array.isArray(directAccounts)) {
      return directAccounts;
    }
    const accountKeyIndexes = (instruction as { accountKeyIndexes?: ArrayLike<number> }).accountKeyIndexes;
    if (Array.isArray(accountKeyIndexes)) {
      return accountKeyIndexes;
    }
    if (accountKeyIndexes && typeof accountKeyIndexes.length === "number") {
      return Array.from(accountKeyIndexes);
    }
    return [];
  };

  let accountKeys: PublicKey[] = [];
  let compiledInstructions: (CompiledInstruction | MessageCompiledInstruction)[];
  let isAccountWritable: (index: number) => boolean;
  let isAccountSigner: (index: number) => boolean;
  let lookupAddresses: string[] = [];

  try {
    const versioned = VersionedTransaction.deserialize(raw);
    const message: any = versioned.message;
    const lookups = Array.isArray(message.addressTableLookups) ? message.addressTableLookups : [];
    let addressLookupTableAccounts: AddressLookupTableAccount[] = [];

    if (lookups.length > 0) {
      const lookupPubkeys = lookups.map((lookup: any) => lookup.accountKey as PublicKey);
      const lookupInfos = await connection.getMultipleAccountsInfo(lookupPubkeys);
      addressLookupTableAccounts = lookupPubkeys.map((pubkey, idx) => {
        const info = lookupInfos[idx];
        if (!info) {
          throw new Error(
            `[raceswap] Address lookup table ${pubkey.toBase58()} missing on-chain while parsing Jupiter transaction`
          );
        }
        return new AddressLookupTableAccount({
          key: pubkey,
          state: AddressLookupTableAccount.deserialize(info.data),
        });
      });
      lookupAddresses = lookupPubkeys.map((pk) => pk.toBase58());
    }

    const compiledKeys = message.getAccountKeys({ addressLookupTableAccounts });
    const staticAccountKeys: PublicKey[] = compiledKeys.staticAccountKeys ?? [];
    const lookupWritableKeys = compiledKeys.accountKeysFromLookups?.writable ?? [];
    const lookupReadonlyKeys = compiledKeys.accountKeysFromLookups?.readonly ?? [];
    accountKeys = [...staticAccountKeys, ...lookupWritableKeys, ...lookupReadonlyKeys];
    compiledInstructions = message.compiledInstructions ?? message.instructions ?? [];

    const header = message.header ?? {
      numRequiredSignatures: 0,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0,
    };

    const numStatic = staticAccountKeys.length;
    const numLookupWritable = lookupWritableKeys.length;

    isAccountWritable = (index: number) => {
      if (index < numStatic) {
        if (index < header.numRequiredSignatures) {
          const writableSignerCutoff = header.numRequiredSignatures - header.numReadonlySignedAccounts;
          return index < writableSignerCutoff;
        }
        const unsignedIndex = index - header.numRequiredSignatures;
        const numUnsigned = numStatic - header.numRequiredSignatures;
        const writableUnsignedCutoff = numUnsigned - header.numReadonlyUnsignedAccounts;
        return unsignedIndex < writableUnsignedCutoff;
      }
      if (index < numStatic + numLookupWritable) {
        return true;
      }
      return false;
    };
    isAccountSigner = (index: number) => index < header.numRequiredSignatures;
  } catch (versionedError) {
    try {
      const legacy = Transaction.from(raw);
      lookupAddresses = [];

      const allAccounts = new Map<string, { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }>();
      for (const ix of legacy.instructions) {
        const progAddr = ix.programId.toBase58();
        if (!allAccounts.has(progAddr)) {
          allAccounts.set(progAddr, { pubkey: ix.programId, isWritable: false, isSigner: false });
        }
        for (const key of ix.keys) {
          const addr = key.pubkey.toBase58();
          const existing = allAccounts.get(addr);
          if (existing) {
            existing.isWritable = existing.isWritable || key.isWritable;
            existing.isSigner = existing.isSigner || key.isSigner;
          } else {
            allAccounts.set(addr, {
              pubkey: key.pubkey,
              isWritable: key.isWritable,
              isSigner: key.isSigner,
            });
          }
        }
      }

      accountKeys = Array.from(allAccounts.values()).map((a) => a.pubkey);
      const accountMeta = new Map<string, { isWritable: boolean; isSigner: boolean }>();
      for (const [addr, meta] of allAccounts.entries()) {
        accountMeta.set(addr, { isWritable: meta.isWritable, isSigner: meta.isSigner });
      }

      compiledInstructions = legacy.instructions.map((ix) => {
        const programIdIndex = accountKeys.findIndex((k) => k.equals(ix.programId));
        if (programIdIndex < 0) {
          throw new Error(`Program ID not found in account keys: ${ix.programId.toBase58()}`);
        }
        const accountIndices = ix.keys.map((k) => {
          const idx = accountKeys.findIndex((ak) => ak.equals(k.pubkey));
          if (idx < 0) {
            throw new Error(`Account key not found: ${k.pubkey.toBase58()}`);
          }
          return idx;
        });
        return {
          programIdIndex,
          accounts: accountIndices,
          data: ix.data,
        } as CompiledInstruction;
      });

      isAccountWritable = (index: number) => {
        const key = accountKeys[index];
        return accountMeta.get(key.toBase58())?.isWritable ?? false;
      };
      isAccountSigner = (index: number) => {
        const key = accountKeys[index];
        return accountMeta.get(key.toBase58())?.isSigner ?? false;
      };
    } catch (legacyError) {
      throw new Error(
        `Failed to deserialize transaction as versioned or legacy: ${(versionedError as Error).message}, ${(legacyError as Error).message}`
      );
    }
  }

  const foundProgramIds = compiledInstructions.map((ix) => accountKeys[ix.programIdIndex]?.toBase58());
  console.log(`[raceswap] Found ${compiledInstructions.length} instructions with program IDs:`, foundProgramIds);
  console.log(`[raceswap] Looking for Jupiter program ID: ${JUPITER_PROGRAM_ID.toBase58()}`);

  // --- Extract Compute Budget ---
  let computeUnitLimit: number | undefined;
  let computeUnitPrice: string | undefined;
  const COMPUTE_BUDGET_ID = "ComputeBudget111111111111111111111111111111";

  compiledInstructions.forEach((ix) => {
    const progId = accountKeys[ix.programIdIndex]?.toBase58();
    if (progId === COMPUTE_BUDGET_ID) {
      const data = Buffer.from(ix.data);
      if (data.length > 0) {
        const discriminator = data[0];
        // SetComputeUnitLimit: 0x02, u32
        if (discriminator === 2 && data.length >= 5) {
           computeUnitLimit = data.readUInt32LE(1);
        }
        // SetComputeUnitPrice: 0x03, u64
        if (discriminator === 3 && data.length >= 9) {
           // Read BigUInt64LE
           const hex = data.subarray(1, 9).reverse().toString("hex");
           computeUnitPrice = BigInt("0x" + hex).toString();
        }
      }
    }
  });

  if (computeUnitLimit) console.log(`[raceswap] Extracted ComputeUnitLimit: ${computeUnitLimit}`);
  if (computeUnitPrice) console.log(`[raceswap] Extracted ComputeUnitPrice: ${computeUnitPrice}`);

  if (compiledInstructions.length > 0) {
    console.log(`[raceswap] First instruction structure:`, {
      hasProgramIdIndex: compiledInstructions[0].programIdIndex !== undefined,
      programIdIndex: compiledInstructions[0].programIdIndex,
      hasAccounts: !!compiledInstructions[0].accounts,
      accountsIsArray: Array.isArray(compiledInstructions[0].accounts),
      accountsLength: Array.isArray(compiledInstructions[0].accounts)
        ? compiledInstructions[0].accounts.length
        : "N/A",
      keys: Object.keys(compiledInstructions[0]),
    });
  }

  const target = compiledInstructions.find((ix) => {
    const programId = accountKeys[ix.programIdIndex];
    return programId?.equals(JUPITER_PROGRAM_ID);
  });

  if (!target) {
    const JUPITER_V6_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    const altTarget = compiledInstructions.find((ix) => {
      const programId = accountKeys[ix.programIdIndex];
      return programId?.equals(JUPITER_V6_PROGRAM_ID);
    });

    if (altTarget) {
      const altProgramId = accountKeys[altTarget.programIdIndex];
      console.log(`[raceswap] Found alternative Jupiter program ID: ${altProgramId.toBase58()}`);

      const altAccountIndexes = resolveInstructionAccountIndexes(altTarget);
      if (altAccountIndexes.length === 0) {
        console.error(`[raceswap] Alternative target instruction structure:`, {
          hasAccounts: Array.isArray((altTarget as any).accounts),
          hasAccountKeyIndexes: Boolean((altTarget as any).accountKeyIndexes),
          accountKeyIndexesType: typeof (altTarget as any).accountKeyIndexes,
          accountKeyIndexesLength:
            Array.isArray((altTarget as any).accountKeyIndexes) ||
            typeof (altTarget as any).accountKeyIndexes?.length === "number"
              ? (altTarget as any).accountKeyIndexes.length
              : "N/A",
          targetKeys: Object.keys(altTarget),
          programIdIndex: altTarget.programIdIndex,
        });
        throw new Error(
          `Alternative Jupiter instruction found but missing or invalid account indexes. Instruction structure: ${JSON.stringify(
            Object.keys(altTarget)
          )}`
        );
      }

      const accounts = altAccountIndexes.map((index: number) => {
        const key = accountKeys[index];
        if (!key) {
          throw new Error(`Account key at index ${index} is undefined`);
        }
        const pubkeyStr = key.toBase58();
        if (!pubkeyStr || typeof pubkeyStr !== "string" || pubkeyStr.trim() === "") {
          throw new Error(`Account key at index ${index} has invalid base58 representation`);
        }
        return {
          pubkey: pubkeyStr.trim(),
          isWritable: isAccountWritable(index),
          isSigner: isAccountSigner(index),
        };
      });

      const ix = new TransactionInstruction({
        programId: altProgramId,
        keys: accounts.map((acct) => ({
          pubkey: new PublicKey(acct.pubkey),
          isWritable: acct.isWritable,
          isSigner: acct.isSigner,
        })),
        data: altTarget.data ? Buffer.from(altTarget.data) : Buffer.alloc(0),
      });

      return {
        data: ix.data.toString("base64"),
        accounts,
        jupiterProgramId: altProgramId.toBase58(),
        addressLookupTableAddresses: lookupAddresses,
        computeUnitLimit,
        computeUnitPrice,
      };
    }

    console.error(`[raceswap] Transaction analysis:`);
    console.error(`  - Total instructions: ${compiledInstructions.length}`);
    console.error(`  - Total account keys: ${accountKeys.length}`);
    console.error(`  - Program IDs found: ${foundProgramIds.join(", ")}`);
    console.error(`  - Expected Jupiter program ID: ${JUPITER_PROGRAM_ID.toBase58()}`);

    const instructionsWithManyAccounts = compiledInstructions
      .map((ix, idx) => ({
        ix,
        idx,
        accountCount: ix.accounts && Array.isArray(ix.accounts) ? ix.accounts.length : 0,
      }))
      .filter(({ accountCount }) => accountCount > 5)
      .sort((a, b) => b.accountCount - a.accountCount);

    if (instructionsWithManyAccounts.length > 0) {
      console.warn(
        `[raceswap] Found ${instructionsWithManyAccounts.length} instruction(s) with many accounts (possible swap instructions):`
      );
      instructionsWithManyAccounts.forEach(({ idx, accountCount, ix }) => {
        const programId = accountKeys[ix.programIdIndex];
        console.warn(`  - Instruction ${idx}: ${programId.toBase58()} with ${accountCount} accounts`);
      });
    }

    throw new Error(
      `Failed to locate Jupiter instruction in swap transaction. Found ${compiledInstructions.length} instructions with program IDs: ${foundProgramIds.join(
        ", "
      )}. Please check server logs for detailed transaction analysis.`
    );
  }

  const targetAccountIndexes = resolveInstructionAccountIndexes(target);
  if (targetAccountIndexes.length === 0) {
    console.error(`[raceswap] Target instruction structure:`, {
      hasAccounts: Array.isArray((target as any).accounts),
      hasAccountKeyIndexes: Boolean((target as any).accountKeyIndexes),
      accountKeyIndexesType: typeof (target as any).accountKeyIndexes,
      accountKeyIndexesLength:
        Array.isArray((target as any).accountKeyIndexes) ||
        typeof (target as any).accountKeyIndexes?.length === "number"
          ? (target as any).accountKeyIndexes.length
          : "N/A",
      targetKeys: Object.keys(target),
      programIdIndex: target.programIdIndex,
    });
    throw new Error(
      `Jupiter instruction found but missing or invalid account indexes. Instruction structure: ${JSON.stringify(
        Object.keys(target)
      )}`
    );
  }

  const accounts = targetAccountIndexes.map((index: number) => {
    const key = accountKeys[index];
    if (!key) {
      throw new Error(`Account key at index ${index} is undefined`);
    }
    const pubkeyStr = key.toBase58();
    if (!pubkeyStr || typeof pubkeyStr !== "string" || pubkeyStr.trim() === "") {
      throw new Error(`Account key at index ${index} has invalid base58 representation`);
    }
    return {
      pubkey: pubkeyStr.trim(),
      isWritable: isAccountWritable(index),
      isSigner: isAccountSigner(index),
    };
  });

  const ix = new TransactionInstruction({
    programId: JUPITER_PROGRAM_ID,
    keys: accounts.map((acct) => ({
      pubkey: new PublicKey(acct.pubkey),
      isWritable: acct.isWritable,
      isSigner: acct.isSigner,
    })),
    data: target.data ? Buffer.from(target.data) : Buffer.alloc(0),
  });

  return {
    data: ix.data.toString("base64"),
    accounts,
    jupiterProgramId: JUPITER_PROGRAM_ID.toBase58(),
    addressLookupTableAddresses: Array.from(new Set(lookupAddresses)),
    computeUnitLimit,
    computeUnitPrice,
  };
}
