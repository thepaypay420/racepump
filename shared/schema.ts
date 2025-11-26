import { z } from "zod";

// Market status enum for prediction markets
export const MarketStatus = {
  UPCOMING: "UPCOMING",    // Betting open, market hasn't started
  LIVE: "LIVE",           // Betting open, market active
  IN_PROGRESS: "IN_PROGRESS", // Betting closed, waiting for settlement
  SETTLED: "SETTLED",     // Market settled with winner
  CANCELLED: "CANCELLED"  // Market cancelled
} as const;

export type MarketStatus = typeof MarketStatus[keyof typeof MarketStatus];

// Token schema for prediction markets
export const tokenSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  name: z.string(),
  logoURI: z.string().optional(),
  initialPrice: z.number(),
  currentPrice: z.number().optional(),
  priceChange: z.number().optional(), // Percentage change
  // 1h percentage change from GeckoTerminal (for display only)
  priceChangeH1: z.number().optional(),
  volume24h: z.number().optional(),
  marketCap: z.number().optional(),
  createdAt: z.number(), // When pair was created
  geckoTerminalUrl: z.string().optional()
});

export type Token = z.infer<typeof tokenSchema>;

// Market schema for price prediction
export const marketSchema = z.object({
  id: z.string(),
  startTs: z.number(), // When betting opens
  lockTs: z.number(),  // When betting closes and price tracking starts
  endTs: z.number(),   // When market settles (lockTs + 30min)
  status: z.enum([MarketStatus.UPCOMING, MarketStatus.LIVE, MarketStatus.IN_PROGRESS, MarketStatus.SETTLED, MarketStatus.CANCELLED]),
  rakeBps: z.number().min(0).max(500),
  jackpotFlag: z.boolean(),
  jackpotAdded: z.number().default(0),
  winnerIndex: z.number().optional(),
  tokens: z.array(tokenSchema),
  duration: z.number().default(1800), // 30 minutes in seconds
  createdAt: z.number()
});

export type Market = z.infer<typeof marketSchema>;

// Race status enum for races
export const RaceStatus = {
  OPEN: "OPEN",
  LOCKED: "LOCKED",
  IN_PROGRESS: "IN_PROGRESS", 
  SETTLED: "SETTLED",
  CANCELLED: "CANCELLED"
} as const;

export type RaceStatus = typeof RaceStatus[keyof typeof RaceStatus];

// Runner schema for individual racing tokens
export const runnerSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  name: z.string(),
  logoURI: z.string().optional(),
  marketCap: z.number(),
  volume24h: z.number().optional(),
  initialPrice: z.number().optional(), // Legacy field for backward compatibility
  initialPriceUsd: z.number().optional(), // USD baseline price captured at LOCK time
  initialPriceTs: z.number().optional(), // Timestamp when baseline was captured
  currentPrice: z.number().optional(),
  priceChange: z.number().optional(),
  // 1h percentage change from GeckoTerminal (for display only)
  priceChangeH1: z.number().optional(),
  createdAt: z.number().optional(), // When token pair was created
  poolAddress: z.string().optional(), // GeckoTerminal pool address for API verification
  geckoTerminalUrl: z.string().optional() // GeckoTerminal pool URL
});

export type Runner = z.infer<typeof runnerSchema>;

// Race schema for meme coin races
export const raceSchema = z.object({
  id: z.string(),
  startTs: z.number(),
  startSlot: z.number().optional(),
  startBlockTimeMs: z.number().optional(),
  lockedTs: z.number().optional(), // When race transitioned to LOCKED and initial prices were captured
  lockedSlot: z.number().optional(),
  lockedBlockTimeMs: z.number().optional(),
  inProgressTs: z.number().optional(), // When race transitioned to IN_PROGRESS
  inProgressSlot: z.number().optional(),
  inProgressBlockTimeMs: z.number().optional(),
  status: z.enum([RaceStatus.OPEN, RaceStatus.LOCKED, RaceStatus.IN_PROGRESS, RaceStatus.SETTLED, RaceStatus.CANCELLED]),
  rakeBps: z.number(),
  jackpotFlag: z.boolean(),
  jackpotAdded: z.number(),
  winnerIndex: z.number().optional(),
  drandRound: z.number().optional(),
  drandRandomness: z.string().optional(),
  drandSignature: z.string().optional(),
  runners: z.array(runnerSchema),
  settledSlot: z.number().optional(),
  settledBlockTimeMs: z.number().optional(),
  createdAt: z.number(),
  // Meme Reward Race fields
  memeRewardEnabled: z.boolean().optional().default(false),
  memeRewardRecipient: z.string().optional(), // Wallet address that received the reward
  memeRewardTokenAmount: z.string().optional(), // Amount of winning coin tokens received
  memeRewardSolSpent: z.string().optional(), // SOL used for the swap
  memeRewardTxSig: z.string().optional() // Transaction signature for the token send
});

export type Race = z.infer<typeof raceSchema>;

// Prediction schema
export const predictionSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  wallet: z.string(),
  tokenIdx: z.number(),
  amount: z.string(), // Decimal string for precision
  sig: z.string(),
  ts: z.number(),
  blockTimeMs: z.number().optional(),
  slot: z.number().optional()
});

export type Prediction = z.infer<typeof predictionSchema>;

// Claim schema (remains the same)
export const claimSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  wallet: z.string(),
  amount: z.string(), // Decimal string for precision
  sig: z.string(),
  ts: z.number()
});

export type Claim = z.infer<typeof claimSchema>;

// Treasury state schema
export const treasurySchema = z.object({
  jackpotBalance: z.string().default("0"),
  // SOL jackpot tracked separately for native SOL bets
  jackpotBalanceSol: z.string().optional().default("0"),
  raceMint: z.string().optional(),
  // Global maintenance controls
  maintenanceMode: z.boolean().optional().default(false),
  maintenanceMessage: z.string().optional(),
  maintenanceAnchorRaceId: z.string().optional()
});

export type Treasury = z.infer<typeof treasurySchema>;

// API request schemas
export const placePredictionSchema = z.object({
  raceId: z.string(),
  runnerIdx: z.number().min(0),
  amount: z.string(),
  fromPubkey: z.string(),
  txSig: z.string(),
  clientId: z.string().optional(),
  memo: z.string().optional(),
  // Betting currency: native SOL or RACE SPL token
  currency: z.enum(['SOL', 'RACE']).optional().default('SOL')
});

export const claimWinningsSchema = z.object({
  marketId: z.string(),
  wallet: z.string()
});

export const createMarketSchema = z.object({
  startTs: z.number(),
  duration: z.number().default(1800), // 30 minutes
  rakeBps: z.number().min(0).max(500).default(300),
  jackpotFlag: z.boolean().default(false),
  limit: z.number().min(4).max(12).default(8)
});

export const createRaceSchema = z.object({
  startMinutesFromNow: z.number().min(0.01).max(60).default(30), // Default to 30 minutes for safer production defaults
  rakeBps: z.number().min(0).max(500).optional().default(300),
  jackpotFlag: z.boolean().optional().default(true),
  limit: z.number().min(4).max(10).optional().default(6)
});

export const lockRaceSchema = z.object({
  raceId: z.string()
});

export const cancelRaceSchema = z.object({
  raceId: z.string()
});

export const faucetSchema = z.object({
  toPubkey: z.string(),
  amount: z.string()
});

export const lockMarketSchema = z.object({
  marketId: z.string()
});

export const cancelMarketSchema = z.object({
  marketId: z.string()
});

export type PlacePredictionRequest = z.infer<typeof placePredictionSchema>;
export type ClaimWinningsRequest = z.infer<typeof claimWinningsSchema>;
export type CreateMarketRequest = z.infer<typeof createMarketSchema>;
export type FaucetRequest = z.infer<typeof faucetSchema>;
export type LockMarketRequest = z.infer<typeof lockMarketSchema>;
export type CancelMarketRequest = z.infer<typeof cancelMarketSchema>;

// Additional schemas for price prediction
export const priceUpdateSchema = z.object({
  marketId: z.string(),
  tokenPrices: z.array(z.object({
    mint: z.string(),
    price: z.number(),
    priceChange: z.number()
  }))
});

export type PriceUpdateRequest = z.infer<typeof priceUpdateSchema>;

// Transaction deduplication schema
export const seenTxSchema = z.object({
  sig: z.string(),
  seenAt: z.number()
});

export type SeenTx = z.infer<typeof seenTxSchema>;

// Settlement transfer schema for recording on-chain payouts
export const settlementTransferSchema = z.object({
  id: z.string(),
  raceId: z.string(),
  transferType: z.enum(['RAKE', 'JACKPOT', 'PAYOUT']),
  toWallet: z.string(),
  amount: z.string(),
  txSig: z.string(),
  ts: z.number(),
  // Enhanced fields for failure tracking and batching
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED']).optional().default('SUCCESS'), // Backward compatible: existing records are successful
  attempts: z.number().optional().default(1), // Number of retry attempts
  lastError: z.string().optional(), // Error message if failed
  batchId: z.string().optional(), // Groups transfers sent in same transaction
  currency: z.enum(['SOL', 'RACE']).optional() // Which token was transferred
});

export type SettlementTransfer = z.infer<typeof settlementTransferSchema>;
