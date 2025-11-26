import Decimal from "decimal.js";
import { getDb } from "./db";
import type { Race } from "@shared/schema";

function getHouseSeedAmount(currency: 'SOL' | 'RACE'): string {
  // Per-currency overrides; default RACE=1000, SOL=0.01
  const envKey = currency === 'SOL' ? 'HOUSE_SEED_AMOUNT_SOL' : 'HOUSE_SEED_AMOUNT_RACE';
  const fallback = currency === 'SOL' ? '0.01' : '1000';
  const rawSpecific = (process.env[envKey] || '').trim();
  const rawLegacy = (process.env.HOUSE_SEED_AMOUNT || '').trim();
  const raw = rawSpecific || rawLegacy || fallback;
  try {
    const d = new Decimal(raw);
    return d.gt(0) ? d.toString() : fallback;
  } catch { return fallback; }
}

export async function seedHouseBetsForRace(
  race: Race,
  amountPerRunner?: string,
  currency: 'SOL' | 'RACE' = 'SOL'
): Promise<{ created: number; funded: boolean }>{
  const createdAt = Date.now();
  const amount = new Decimal(amountPerRunner ?? getHouseSeedAmount(currency));
  if (amount.lte(0)) return { created: 0, funded: false };

  // Use ESCROW (server) wallet for house seeding so winnings accrue to escrow
  // Treasury continues to only receive rake during settlement.
  const { serverKeypair } = await import("./solana");
  const houseWallet = serverKeypair.publicKey.toString();

  // Avoid duplicate seeding per-currency so SOL seeds don't block RACE seeds (and vice versa)
  const existing = await getDb().getBetsForRace(race.id) || [];
  const alreadySeeded = existing.filter(
    (b) => (b.clientId === 'HOUSE_SEED' || b.memo === 'HOUSE_SEED') && ((b as any).currency || 'RACE') === currency
  );
  if (alreadySeeded.length >= race.runners.length) {
    return { created: 0, funded: false };
  }

  // Create seed bets (visible in UI like normal bets)
  let created = 0;
  for (let i = 0; i < race.runners.length; i++) {
    try {
      // Ensure unique signature per currency to avoid SOL/RACE collisions
      const sig = `seed_${currency}_${race.id}_${i}`;
      const bet = {
        id: `bet_${sig}`,
        raceId: race.id,
        wallet: houseWallet,
        runnerIdx: i,
        amount: amount.toString(),
        sig,
        ts: createdAt + i, // stable order
        blockTimeMs: createdAt,
        slot: undefined,
        clientId: 'HOUSE_SEED',
        memo: 'HOUSE_SEED',
        currency
      } as any;
      await getDb().createBet(bet);
      await getDb().recordTransaction(sig);
      created++;
      try {
        const { raceEvents } = await import('./sse');
        raceEvents.emit('bet_placed', { raceId: race.id, bet });
      } catch {}
    } catch (e) {
      // Ignore duplicates or transient failures on a per-bet basis
    }
  }

  // Funding: for SOL, optionally top up escrow from treasury if env flag set.
  // - SOL path: cannot mint; if HOUSE_SEED_SOL_FUND is set to a positive number (in SOL),
  //             move that amount from TREASURY_PRIVATE_KEY to ESCROW to cover exposure.
  // - RACE path (dev/local only): if HOUSE_SEED_FUNDING=mint, mint tokens to ESCROW for testing.
  let funded = false;
  const fundingMode = (process.env.HOUSE_SEED_FUNDING || '').toLowerCase();
  if (currency === 'SOL') {
    try {
      const solTopUp = String(process.env.HOUSE_SEED_SOL_FUND || '').trim();
      if (solTopUp) {
        const amt = new Decimal(solTopUp);
        if (amt.gt(0)) {
          const { transferSolFromTreasuryToEscrow } = await import('./solana');
          const lamports = BigInt(amt.mul(new Decimal(10).pow(9)).toString());
          await transferSolFromTreasuryToEscrow(lamports);
          funded = true;
          console.log(`[HOUSE_SEED] Funded escrow from treasury: ${solTopUp} SOL`);
        }
      }
    } catch (e) {
      console.warn('[HOUSE_SEED] Optional SOL funding from treasury failed:', e);
    }
  } else if (fundingMode === 'mint') {
    try {
      const { getRaceMint, mintTokensToAddress, serverKeypair } = await import('./solana');
      const mint = await getRaceMint();
      const decimals = 9;
      const total = amount.mul(race.runners.length);
      const mintAmount = BigInt(total.mul(new Decimal(10).pow(decimals)).toString());
      const txSig = await mintTokensToAddress(mint, serverKeypair.publicKey, mintAmount);
      if (txSig) funded = true;
    } catch (e) {
      console.warn(`[HOUSE_SEED] Escrow minting failed; ensure escrow is pre-funded for dev.`, e);
    }
  } else {
    console.log(`[HOUSE_SEED] Skipping on-chain funding (mode=${fundingMode || 'skip'}). For SOL on mainnet, ensure escrow has SOL to cover seed exposure.`);
  }

  return { created, funded };
}

