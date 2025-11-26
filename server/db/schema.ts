import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, bigint, boolean, index as pgIndex, uniqueIndex as pgUniqueIndex, primaryKey } from "drizzle-orm/pg-core";

// SQLite Tables (for development)
export const sqliteRaces = sqliteTable("races", {
  id: text("id").primaryKey(),
  startTs: integer("startTs").notNull(),
  startSlot: integer("startSlot"),
  startBlockTimeMs: integer("startBlockTimeMs"),
  lockedTs: integer("lockedTs"),
  lockedSlot: integer("lockedSlot"),
  lockedBlockTimeMs: integer("lockedBlockTimeMs"),
  inProgressTs: integer("inProgressTs"),
  inProgressSlot: integer("inProgressSlot"),
  inProgressBlockTimeMs: integer("inProgressBlockTimeMs"),
  status: text("status").notNull(),
  rakeBps: integer("rakeBps").notNull(),
  jackpotFlag: integer("jackpotFlag").notNull(),
  jackpotAdded: integer("jackpotAdded").default(0),
  winnerIndex: integer("winnerIndex"),
  drandRound: integer("drandRound"),
  drandRandomness: text("drandRandomness"),
  drandSignature: text("drandSignature"),
  runners: text("runners").notNull(),
  settledSlot: integer("settledSlot"),
  settledBlockTimeMs: integer("settledBlockTimeMs"),
  createdAt: integer("createdAt").notNull(),
});

export const sqliteBets = sqliteTable("bets", {
  id: text("id").primaryKey(),
  raceId: text("raceId").notNull(),
  wallet: text("wallet").notNull(),
  runnerIdx: integer("runnerIdx").notNull(),
  amount: text("amount").notNull(),
  sig: text("sig").notNull(),
  ts: integer("ts").notNull(),
  blockTimeMs: integer("blockTimeMs"),
  slot: integer("slot"),
  clientId: text("clientId"),
  memo: text("memo"),
  currency: text("currency").notNull().default("RACE"),
}, (table) => ({
  uniqBetSig: uniqueIndex("uniq_bet_sig").on(table.sig),
}));

export const sqliteTreasury = sqliteTable("treasury", {
  state: text("state").primaryKey().default("main"),
  jackpotBalance: text("jackpotBalance").default("0"),
  jackpotBalanceSol: text("jackpotBalanceSol").default("0"),
  raceMint: text("raceMint"),
  maintenanceMode: integer("maintenanceMode").default(0),
  maintenanceMessage: text("maintenanceMessage"),
  maintenanceAnchorRaceId: text("maintenanceAnchorRaceId"),
});

export const sqliteUserStats = sqliteTable("user_stats", {
  wallet: text("wallet").primaryKey(),
  totalRaces: integer("totalRaces").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  totalWagered: text("totalWagered").notNull().default("0"),
  totalAwarded: text("totalAwarded").notNull().default("0"),
  edgePoints: text("edgePoints").notNull().default("0"),
  lastUpdated: integer("lastUpdated").notNull(),
});

export const sqliteUserRaceResults = sqliteTable("user_race_results", {
  wallet: text("wallet").notNull(),
  raceId: text("raceId").notNull(),
  betAmount: text("betAmount").notNull(),
  payoutAmount: text("payoutAmount").notNull(),
  win: integer("win").notNull(),
  edgePoints: text("edgePoints").notNull(),
  ts: integer("ts").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.wallet, table.raceId] }),
  walletIdx: index("idx_user_race_results_wallet").on(table.wallet),
  raceIdx: index("idx_user_race_results_race").on(table.raceId),
}));

export const sqliteRecentWinners = sqliteTable("recent_winners", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  raceId: text("raceId").notNull().unique(),
  raceData: text("raceData").notNull(),
  settledAt: integer("settledAt").notNull(),
}, (table) => ({
  settledIdx: index("idx_recent_winners_settled").on(table.settledAt),
}));

// PostgreSQL Tables (for production)
export const pgRaces = pgTable("races", {
  id: pgText("id").primaryKey(),
  startTs: bigint("start_ts", { mode: "number" }).notNull(),
  startSlot: bigint("start_slot", { mode: "number" }),
  startBlockTimeMs: bigint("start_block_time_ms", { mode: "number" }),
  lockedTs: bigint("locked_ts", { mode: "number" }),
  lockedSlot: bigint("locked_slot", { mode: "number" }),
  lockedBlockTimeMs: bigint("locked_block_time_ms", { mode: "number" }),
  inProgressTs: bigint("in_progress_ts", { mode: "number" }),
  inProgressSlot: bigint("in_progress_slot", { mode: "number" }),
  inProgressBlockTimeMs: bigint("in_progress_block_time_ms", { mode: "number" }),
  status: pgText("status").notNull(),
  rakeBps: pgInteger("rake_bps").notNull(),
  jackpotFlag: boolean("jackpot_flag").notNull(),
  jackpotAdded: pgInteger("jackpot_added").default(0),
  winnerIndex: pgInteger("winner_index"),
  drandRound: bigint("drand_round", { mode: "number" }),
  drandRandomness: pgText("drand_randomness"),
  drandSignature: pgText("drand_signature"),
  runners: pgText("runners").notNull(),
  settledSlot: bigint("settled_slot", { mode: "number" }),
  settledBlockTimeMs: bigint("settled_block_time_ms", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const pgBets = pgTable("bets", {
  id: pgText("id").primaryKey(),
  raceId: pgText("race_id").notNull(),
  wallet: pgText("wallet").notNull(),
  runnerIdx: pgInteger("runner_idx").notNull(),
  amount: pgText("amount").notNull(),
  sig: pgText("sig").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  blockTimeMs: bigint("block_time_ms", { mode: "number" }),
  slot: bigint("slot", { mode: "number" }),
  clientId: pgText("client_id"),
  memo: pgText("memo"),
  currency: pgText("currency").notNull().default("RACE"),
}, (table) => ({
  uniqBetSig: pgUniqueIndex("bets_sig_key").on(table.sig),
}));

export const pgTreasury = pgTable("treasury", {
  state: pgText("state").primaryKey().default("main"),
  jackpotBalance: pgText("jackpot_balance").default("0"),
  jackpotBalanceSol: pgText("jackpot_balance_sol").default("0"),
  raceMint: pgText("race_mint"),
  maintenanceMode: boolean("maintenance_mode").default(false),
  maintenanceMessage: pgText("maintenance_message"),
  maintenanceAnchorRaceId: pgText("maintenance_anchor_race_id"),
});

export const pgUserStats = pgTable("user_stats", {
  wallet: pgText("wallet").primaryKey(),
  totalRaces: pgInteger("total_races").notNull().default(0),
  wins: pgInteger("wins").notNull().default(0),
  losses: pgInteger("losses").notNull().default(0),
  totalWagered: pgText("total_wagered").notNull().default("0"),
  totalAwarded: pgText("total_awarded").notNull().default("0"),
  edgePoints: pgText("edge_points").notNull().default("0"),
  lastUpdated: bigint("last_updated", { mode: "number" }).notNull(),
});

export const pgUserRaceResults = pgTable("user_race_results", {
  wallet: pgText("wallet").notNull(),
  raceId: pgText("race_id").notNull(),
  betAmount: pgText("bet_amount").notNull(),
  payoutAmount: pgText("payout_amount").notNull(),
  win: boolean("win").notNull(),
  edgePoints: pgText("edge_points").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.wallet, table.raceId] }),
  walletIdx: pgIndex("idx_user_race_results_wallet").on(table.wallet),
  raceIdx: pgIndex("idx_user_race_results_race").on(table.raceId),
}));

export const pgRecentWinners = pgTable("recent_winners", {
  id: pgInteger("id").primaryKey().generatedAlwaysAsIdentity(),
  raceId: pgText("race_id").notNull().unique(),
  raceData: pgText("race_data").notNull(),
  settledAt: bigint("settled_at", { mode: "number" }).notNull(),
  totalPot: pgText("total_pot"),
  betCount: pgInteger("bet_count"),
}, (table) => ({
  settledIdx: pgIndex("idx_recent_winners_settled").on(table.settledAt),
}));
