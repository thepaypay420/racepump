import Decimal from "decimal.js";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Market, MarketStatus, Prediction, Claim, Race, RaceStatus } from "@shared/schema";
import { getDb } from "./db";
import { sendSplTokens, serverKeypair, getMintDecimals, treasuryPubkey, sendLamports } from "./solana";
import { clearTokenCache } from "./runners";

export async function settleMarket(market: Market): Promise<void> {
  if (market.status !== MarketStatus.IN_PROGRESS || market.winnerIndex === undefined) {
    throw new Error("Market must be in progress with winner determined");
  }

  console.log(`Settling market ${market.id}, winner index: ${market.winnerIndex}`);

  // Get all bets for this market
  const bets = await getDb().getBetsForRace(market.id);
  
  if (bets.length === 0) {
    console.log("No bets to settle");
    // Update market status to settled
    await getDb().updateRace({ ...market, status: 'SETTLED' as const });
    return;
  }

  // Calculate settlement
  const settlement = await calculateSettlement(bets, market as any);
  
  // Update treasury with jackpot contribution (legacy path, use atomic adjust to avoid underflow)
  try {
    const delta = settlement.jackpotContribution.toString();
    await getDb().adjustJackpotBalances({ deltaRace: delta });
  } catch {
    const treasury = await getDb().getTreasury();
    const newJackpotBalance = new Decimal(treasury.jackpotBalance)
      .add(settlement.jackpotContribution);
    await getDb().updateTreasury({
      ...treasury,
      jackpotBalance: (newJackpotBalance.isNegative() ? new Decimal(0) : newJackpotBalance).toString()
    });
  }

  // Update market with settlement info
  await getDb().updateRace({
    ...market,
    status: 'SETTLED' as const,
    jackpotAdded: settlement.jackpotPayout.toNumber()
  });

  // Record per-user results and update stats for leaderboard
  try {
    const { computeEdgePoints } = await import('./edge-points');
    const totalPotStr = settlement.totalPot.toString();
    // Build quick lookup of payout per wallet
    const payoutByWallet = new Map<string, Decimal>();
    settlement.winnerPayouts.forEach((amt: Decimal, wallet: string) => payoutByWallet.set(wallet, amt));

    // Aggregate bets per wallet
    const betByWallet = new Map<string, Decimal>();
    bets.forEach(b => {
      const prev = betByWallet.get(b.wallet) || new Decimal(0);
      betByWallet.set(b.wallet, prev.add(new Decimal(b.amount)));
    });

    const wallets = new Set<string>(
      Array.from(betByWallet.keys()).concat(Array.from(payoutByWallet.keys()))
    );
    for (const wallet of wallets) {
      const betAmt = betByWallet.get(wallet) || new Decimal(0);
      const payoutAmt = payoutByWallet.get(wallet) || new Decimal(0);
      const win = payoutAmt.gt(0);
      const edge = computeEdgePoints({
        betAmount: betAmt.toString(),
        payoutAmount: payoutAmt.toString(),
        totalPot: totalPotStr,
        win
      });
      await getDb().upsertUserRaceResult({
        wallet,
        raceId: market.id,
        betAmount: betAmt.toString(),
        payoutAmount: payoutAmt.toString(),
        win,
        edgePoints: edge,
        ts: Date.now()
      });
      await getDb().recalcUserStats(wallet);
    }
  } catch (e) {
    console.error('Failed to record leaderboard results:', e);
  }

  // Clear token cache so new races get fresh tokens
  clearTokenCache();

  console.log(`Market ${market.id} settled:`, {
    totalPot: settlement.totalPot.toString(),
    prizePool: settlement.prizePool.toString(),
    treasuryRake: settlement.treasuryRake.toString(),
    jackpotContribution: settlement.jackpotContribution.toString(),
    jackpotPayout: settlement.jackpotPayout.toString(),
    winnerPayouts: settlement.winnerPayouts.size
  });
}

export async function calculateSettlement(
  bets: Prediction[],
  race: Race,
  opts?: { treasuryRatio?: number; jackpotRatio?: number }
) {
  const winnerIndex = race.winnerIndex!;

  // Include ALL bets (including HOUSE_SEED) in settlement economics so seed
  // coverage meaningfully affects odds and payouts. This also allows the house
  // (treasury) to win when it seeded the winning runner.
  const allBets = bets as any[];

  // Total pot: sum of all bets
  const totalPot = allBets.reduce(
    (sum, bet) => sum.add(new Decimal(bet.amount)),
    new Decimal(0)
  );

  // Calculate rake (max 500 bps = 5%)
  const rakeBps = Math.min(race.rakeBps, 500);
  const rakeDecimal = new Decimal(rakeBps).div(10000);
  const totalRake = totalPot.mul(rakeDecimal);

  // Split rake: default 2/3 treasury, 1/3 jackpot (for 3% RACE rake -> 2%/1%)
  // Allow override (e.g., SOL 5% rake -> 3%/2% split uses 60%/40% of rake)
  let treasuryRatio: Decimal;
  let jackpotRatio: Decimal;
  if (opts && typeof opts.treasuryRatio === 'number' && typeof opts.jackpotRatio === 'number') {
    treasuryRatio = new Decimal(opts.treasuryRatio);
    jackpotRatio = new Decimal(opts.jackpotRatio);
  } else {
    treasuryRatio = new Decimal(2).div(3);
    jackpotRatio = new Decimal(1).div(3);
  }
  
  let treasuryRake = totalRake.mul(treasuryRatio);
  let jackpotContribution = totalRake.mul(jackpotRatio);

  // If escrow (server) wallet is the only bettor for this currency,
  // do not take any rake (avoid draining escrow for self-seeded races)
  let onlyEscrowBettor = false;
  try {
    const escrowWallet = serverKeypair.publicKey.toString();
    const uniqueWallets = new Set<string>();
    (allBets as any[]).forEach(b => uniqueWallets.add(String(b.wallet)));
    onlyEscrowBettor = uniqueWallets.size > 0 && uniqueWallets.size === 1 && uniqueWallets.has(escrowWallet);
    if (onlyEscrowBettor) {
      treasuryRake = new Decimal(0);
      jackpotContribution = new Decimal(0);
    }
  } catch {}

  // Get current jackpot balance; choose per-currency bucket
  const treasury = await getDb().getTreasury();
  let currentJackpot: Decimal;
  try {
    const currency = (allBets[0] as any)?.currency === 'SOL' ? 'SOL' : 'RACE';
    currentJackpot = new Decimal(
      currency === 'SOL' ? (treasury.jackpotBalanceSol || '0') : (treasury.jackpotBalance || '0')
    );
  } catch {
    currentJackpot = new Decimal((treasury as any).jackpotBalance || '0');
  }
  
  // Determine jackpot payout (if this is a jackpot race)
  // If escrow is the only bettor, do not pay out jackpot - let it continue to grow
  const jackpotPayout = (race.jackpotFlag && !onlyEscrowBettor) ? currentJackpot : new Decimal(0);

  // Calculate prize pool after rake + jackpot
  const prizePool = totalPot.sub(treasuryRake.add(jackpotContribution)).add(jackpotPayout);

  // Find winning bets (exclude house seeds from winner share)
  const winningBets = allBets.filter(bet => bet.runnerIdx === winnerIndex);
  const totalWinningAmount = winningBets.reduce(
    (sum, bet) => sum.add(new Decimal(bet.amount)),
    new Decimal(0)
  );

  // Calculate payouts for winners (parimutuel style)
  const winnerPayouts = new Map<string, Decimal>();
  
  if (totalWinningAmount.gt(0)) {
    // Group winning bets by wallet
    const winnerBetsByWallet = new Map<string, Decimal>();
    
    winningBets.forEach(bet => {
      const current = winnerBetsByWallet.get(bet.wallet) || new Decimal(0);
      winnerBetsByWallet.set(bet.wallet, current.add(new Decimal(bet.amount)));
    });

    // Calculate each winner's share of prize pool
    winnerBetsByWallet.forEach((betAmount, wallet) => {
      const share = betAmount.div(totalWinningAmount);
      const payout = prizePool.mul(share);
      // Round down to 9 decimals (SPL token precision)
      const roundedPayout = payout.toDecimalPlaces(9, Decimal.ROUND_DOWN);
      winnerPayouts.set(wallet, roundedPayout);
    });
  }

  // If no bets were placed on the winning outcome, enforce refund policy:
  // - No rake taken
  // - No jackpot contribution or payout
  // - Winner payouts map remains empty (refunds handled by executor)
  const noWinningBets = totalWinningAmount.eq(0);

  return {
    totalPot,
    prizePool: noWinningBets ? new Decimal(0) : prizePool,
    treasuryRake: noWinningBets ? new Decimal(0) : treasuryRake,
    jackpotContribution: noWinningBets ? new Decimal(0) : jackpotContribution,
    jackpotPayout: noWinningBets ? new Decimal(0) : jackpotPayout,
    winnerPayouts,
    winningBets
  };
}

export async function handleClaimWinnings(raceId: string, wallet: string): Promise<{ 
  success: boolean; 
  txSigs?: string[]; 
  amount?: string; 
  error?: string; 
}> {
  try {
    const race = await getDb().getRace(raceId);
    if (!race) {
      return { success: false, error: "Race not found" };
    }

    if (race.status !== RaceStatus.SETTLED) {
      return { success: false, error: "Race not yet settled" };
    }

    // Check if already claimed
    const existingClaims = await getDb().getClaimsForWallet(wallet)
      .filter(claim => claim.raceId === raceId);
    
    if (existingClaims.length > 0) {
      return { success: false, error: "Winnings already claimed" };
    }

    // Calculate what this wallet should receive
    const bets = await getDb().getBetsForRace(raceId);
    const settlement = await calculateSettlement(bets, race);
    const payout = settlement.winnerPayouts.get(wallet);

    if (!payout || payout.lte(0)) {
      return { success: false, error: "No winnings to claim" };
    }

    // Block claims for house wallets; house winnings remain in escrow
    try {
      const escrowWallet = serverKeypair.publicKey.toString();
      const treasuryWallet = (treasuryPubkey || serverKeypair.publicKey).toString();
      if (wallet === escrowWallet || wallet === treasuryWallet) {
        return { success: false, error: "House wallet winnings are retained in escrow" };
      }
    } catch {}

    // Detect currency from bets (SOL or RACE)
    const currency = (bets as any)[0]?.currency || 'SOL';
    const recipientPubkey = new PublicKey(wallet);
    let txSig: string;

    if (currency === 'SOL') {
      // Send native SOL
      const lamports = payout.mul(LAMPORTS_PER_SOL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
      txSig = await sendLamports(
        serverKeypair,
        recipientPubkey,
        BigInt(lamports.toString())
      );
      console.log(`Claimed ${payout.toString()} SOL for ${wallet} from race ${raceId}`);
    } else {
      // Send RACE tokens
      const treasury = await getDb().getTreasury();
      if (!treasury.raceMint) {
        return { success: false, error: "RACE mint not initialized" };
      }

      const raceMint = new PublicKey(treasury.raceMint);
      const decimals = await getMintDecimals(raceMint);
      const payoutTokens = BigInt(payout.mul(new Decimal(10).pow(decimals)).toString());
      
      txSig = await sendSplTokens(
        raceMint,
        serverKeypair,
        recipientPubkey,
        payoutTokens
      );
      console.log(`Claimed ${payout.toString()} $RACE for ${wallet} from race ${raceId}`);
    }

    // Record claim
    const claim: Claim = {
      id: `claim_${Date.now()}_${wallet.slice(-6)}`,
      marketId: raceId,
      wallet,
      amount: payout.toString(),
      sig: txSig,
      ts: Date.now()
    };

    await getDb().createClaim(claim);

    return {
      success: true,
      txSigs: [txSig],
      amount: payout.toString()
    };

  } catch (error) {
    console.error("Claim winnings error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

// Refund bets for cancelled race
export async function refundRace(race: Race): Promise<void> {
  if (race.status !== RaceStatus.OPEN) {
    throw new Error("Can only refund open races");
  }

  console.log(`Refunding race ${race.id}`);

  const bets = await getDb().getBetsForRace(race.id);
  
  if (bets.length === 0) {
    console.log("No bets to refund");
    await getDb().updateRace({ ...race, status: RaceStatus.CANCELLED });
    return;
  }

  // Detect currency from bets
  const currency = (bets as any)[0]?.currency || 'SOL';

  // Group bets by wallet to minimize transactions
  const refundsByWallet = new Map<string, Decimal>();
  
  bets.forEach(bet => {
    const current = refundsByWallet.get(bet.wallet) || new Decimal(0);
    refundsByWallet.set(bet.wallet, current.add(new Decimal(bet.amount)));
  });

  // Process refunds
  const refundTxSigs: string[] = [];
  
  for (const [wallet, totalRefund] of Array.from(refundsByWallet)) {
    try {
      const recipientPubkey = new PublicKey(wallet);
      
      if (currency === 'SOL') {
        // Refund native SOL
        const lamports = totalRefund.mul(LAMPORTS_PER_SOL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
        const txSig = await sendLamports(
          serverKeypair,
          recipientPubkey,
          BigInt(lamports.toString())
        );
        refundTxSigs.push(txSig);
        console.log(`Refunded ${totalRefund.toString()} SOL to ${wallet}`);
      } else {
        // Refund RACE tokens
        const treasury = await getDb().getTreasury();
        if (!treasury.raceMint) {
          throw new Error("RACE mint not initialized");
        }
        
        const raceMint = new PublicKey(treasury.raceMint);
        const decimals = await getMintDecimals(raceMint);
        const refundTokens = BigInt(totalRefund.mul(new Decimal(10).pow(decimals)).toString());
        
        const txSig = await sendSplTokens(
          raceMint,
          serverKeypair,
          recipientPubkey,
          refundTokens
        );
        refundTxSigs.push(txSig);
        console.log(`Refunded ${totalRefund.toString()} $RACE to ${wallet}`);
      }
    } catch (error) {
      console.error(`Failed to refund ${wallet}:`, error);
    }
  }

  // Update race status
  await getDb().updateRace({ ...race, status: RaceStatus.CANCELLED });

  console.log(`Race ${race.id} cancelled, ${refundTxSigs.length} refunds processed`);
}
