import { randomUUID } from "crypto";
import { Race, Prediction, Claim, Treasury, RaceStatus } from "@shared/schema";

export interface IStorage {
  // Race operations
  createRace(race: Omit<Race, "id" | "createdAt">): Promise<Race>;
  getRace(id: string): Promise<Race | undefined>;
  getRaces(status?: RaceStatus): Promise<Race[]>;
  updateRace(id: string, updates: Partial<Race>): Promise<Race | undefined>;
  
  // Bet operations
  createBet(bet: Omit<Prediction, "id" | "ts">): Promise<Prediction>;
  getBetsForRace(raceId: string): Promise<Prediction[]>;
  getBetsForWallet(wallet: string, raceId?: string): Promise<Prediction[]>;
  
  // Claim operations
  createClaim(claim: Omit<Claim, "id" | "ts">): Promise<Claim>;
  getClaimsForRace(raceId: string): Promise<Claim[]>;
  getClaimsForWallet(wallet: string): Promise<Claim[]>;
  
  // Treasury operations
  getTreasury(): Promise<Treasury>;
  updateTreasury(updates: Partial<Treasury>): Promise<Treasury>;
}

export class MemStorage implements IStorage {
  private races: Map<string, Race> = new Map();
  private bets: Map<string, Prediction> = new Map();
  private claims: Map<string, Claim> = new Map();
  private treasury: Treasury = { jackpotBalance: "0" };

  async createRace(raceData: Omit<Race, "id" | "createdAt">): Promise<Race> {
    const id = randomUUID();
    const race: Race = {
      ...raceData,
      id,
      createdAt: Date.now()
    };
    this.races.set(id, race);
    return race;
  }

  async getRace(id: string): Promise<Race | undefined> {
    return this.races.get(id);
  }

  async getRaces(status?: RaceStatus): Promise<Race[]> {
    const races = Array.from(this.races.values());
    if (status) {
      return races.filter(race => race.status === status);
    }
    return races.sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateRace(id: string, updates: Partial<Race>): Promise<Race | undefined> {
    const race = this.races.get(id);
    if (!race) return undefined;
    
    const updatedRace = { ...race, ...updates };
    this.races.set(id, updatedRace);
    return updatedRace;
  }

  async createBet(betData: Omit<Prediction, "id" | "ts">): Promise<Prediction> {
    const id = randomUUID();
    const bet: Prediction = {
      ...betData,
      id,
      ts: Date.now()
    };
    this.bets.set(id, bet);
    return bet;
  }

  async getBetsForRace(raceId: string): Promise<Prediction[]> {
    return Array.from(this.bets.values())
      .filter(bet => bet.marketId === raceId)
      .sort((a, b) => a.ts - b.ts);
  }

  async getBetsForWallet(wallet: string, raceId?: string): Promise<Prediction[]> {
    const bets = Array.from(this.bets.values())
      .filter(bet => bet.wallet === wallet);
    
    if (raceId) {
      return bets.filter(bet => bet.marketId === raceId);
    }
    
    return bets.sort((a, b) => b.ts - a.ts);
  }

  async createClaim(claimData: Omit<Claim, "id" | "ts">): Promise<Claim> {
    const id = randomUUID();
    const claim: Claim = {
      ...claimData,
      id,
      ts: Date.now()
    };
    this.claims.set(id, claim);
    return claim;
  }

  async getClaimsForRace(raceId: string): Promise<Claim[]> {
    return Array.from(this.claims.values())
      .filter(claim => claim.marketId === raceId);
  }

  async getClaimsForWallet(wallet: string): Promise<Claim[]> {
    return Array.from(this.claims.values())
      .filter(claim => claim.wallet === wallet)
      .sort((a, b) => b.ts - a.ts);
  }

  async getTreasury(): Promise<Treasury> {
    return { ...this.treasury };
  }

  async updateTreasury(updates: Partial<Treasury>): Promise<Treasury> {
    this.treasury = { ...this.treasury, ...updates };
    return { ...this.treasury };
  }
}

export const storage = new MemStorage();
