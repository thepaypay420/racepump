import { Race, RaceStatus } from "@shared/schema";
import { getDb } from "./db";
import { chainTime, approxNowMs } from "./chain-time";
import { raceEvents } from "./sse";
import Decimal from 'decimal.js';

// Race state machine with strict validation and transitions
export class RaceStateMachine {
  private static readonly VALID_TRANSITIONS: Record<RaceStatus, RaceStatus[]> = {
    [RaceStatus.OPEN]: [RaceStatus.LOCKED, RaceStatus.CANCELLED],
    [RaceStatus.LOCKED]: [RaceStatus.IN_PROGRESS, RaceStatus.CANCELLED],
    [RaceStatus.IN_PROGRESS]: [RaceStatus.SETTLED, RaceStatus.CANCELLED],
    [RaceStatus.SETTLED]: [], // Terminal state
    [RaceStatus.CANCELLED]: [] // Terminal state
  };

  // Configuration constants
  // Ensure OPEN window is always PROGRESS + 30 seconds to avoid phase overlap
  // Default progress window increased to 20 minutes to match product spec
  private static readonly PROGRESS_DURATION_MS = Number(process.env.PROGRESS_WINDOW_MINUTES ?? "20") * 60 * 1000;
  private static readonly OPEN_EXTRA_BUFFER_MS = 30 * 1000; // 30s longer than locked/in-progress window
  // Ensure OPEN window is ALWAYS at least PROGRESS + buffer even if env is misconfigured
  private static readonly OPEN_DURATION_MS = (() => {
    const envOpen = Number(process.env.OPEN_WINDOW_MINUTES ?? "0") * 60 * 1000;
    const minOpen = RaceStateMachine.PROGRESS_DURATION_MS + RaceStateMachine.OPEN_EXTRA_BUFFER_MS;
    return Math.max(envOpen > 0 ? envOpen : 0, minOpen);
  })();
  private static readonly TRANSITION_GRACE_MS = Number(process.env.TRANSITION_GRACE_MS ?? "5000");
  // Global in-process + DB-backed guard to ensure only one race enters
  // the LOCKED/price-snapshot phase at a time. This prevents rare cases
  // where concurrent timers/watchdogs/admin calls attempt to lock two
  // races simultaneously.
  private static readonly GLOBAL_PHASE_LOCK_KEY = 'GLOBAL_LOCKED_PHASE_GUARD';
  private static inMemoryPhaseLockInUse: boolean = false;
  
  // Track which races have already emitted their settled event to prevent duplicates
  private static settledEventsEmitted = new Set<string>();
  
  // Mutex lock for atomic settlement emission (prevents race condition duplicates)
  private static emissionLock = new Set<string>();

  /**
   * Validate if a transition is allowed
   */
  static canTransition(from: RaceStatus, to: RaceStatus): boolean {
    return this.VALID_TRANSITIONS[from].includes(to);
  }

  /**
   * Get the expected status based on timestamps
   */
  static async getExpectedStatus(race: Race): Promise<RaceStatus> {
    const now = approxNowMs();
    const raceAge = now - race.startTs;
    // Fall back to inProgressTs (or startTs) if lockedTs is missing to prevent stuck races
    const baselineTsForLockedPhase = race.lockedTs || race.inProgressTs || race.startTs;
    const lockedAge = baselineTsForLockedPhase ? now - baselineTsForLockedPhase : 0;

    // Global maintenance: only the anchored OPEN race may progress
    try {
      const treasury = await getDb().getTreasury();
      if ((treasury as any).maintenanceMode && race.status === RaceStatus.OPEN) {
        const anchorId = (treasury as any).maintenanceAnchorRaceId;
        if (anchorId) {
          if (race.id !== anchorId) {
            return race.status;
          }
        } else {
          // Fallback to earliest OPEN as anchor if not set
          const openRaces = await getDb().getRaces(RaceStatus.OPEN as any);
          const earliestOpen = openRaces[0];
          if (!earliestOpen || earliestOpen.id !== race.id) {
            return race.status;
          }
        }
      }
    } catch {}

    // Terminal states
    if (race.status === RaceStatus.SETTLED || race.status === RaceStatus.CANCELLED) {
      return race.status;
    }

    // Check if race should be LOCKED
    if (race.status === RaceStatus.OPEN && raceAge >= this.OPEN_DURATION_MS) {
      // Enforce: at most one race can be LOCKED/IN_PROGRESS at a time
      const others = (await getDb().getRaces()).filter(r => r.id !== race.id);
      const hasActiveOther = others.some(r => r.status === RaceStatus.LOCKED || r.status === RaceStatus.IN_PROGRESS);
      if (hasActiveOther) {
        // Defer locking until other active race completes
        return race.status;
      }
      return RaceStatus.LOCKED;
    }

    // Check if race should be IN_PROGRESS
    if (race.status === RaceStatus.LOCKED && lockedAge >= 2000) { // 2 second delay after lock
      return RaceStatus.IN_PROGRESS;
    }

    // Check if race should be SETTLED
    if (race.status === RaceStatus.IN_PROGRESS && lockedAge >= this.PROGRESS_DURATION_MS) {
      return RaceStatus.SETTLED;
    }

    return race.status;
  }

  /**
   * Transition race to new status with validation
   */
  static async transitionRace(raceId: string, targetStatus: RaceStatus, reason: string): Promise<Race> {
    const race = await getDb().getRace(raceId);
    if (!race) {
      throw new Error(`Race ${raceId} not found`);
    }

    const currentStatus = race.status;
    
    // Validate transition
    if (!this.canTransition(currentStatus, targetStatus)) {
      throw new Error(`Invalid transition from ${currentStatus} to ${targetStatus}`);
    }

    console.log(`🔄 Transitioning race ${raceId}: ${currentStatus} → ${targetStatus} (${reason})`);

    // Perform the transition
    const updatedRace = await this.performTransition(race, targetStatus);
    
    // Update database
    await getDb().updateRace(updatedRace);
    
    // If race was settled with a winner, add to recent winners
    if (targetStatus === RaceStatus.SETTLED && updatedRace.winnerIndex !== undefined) {
      await getDb()?.addRecentWinner(updatedRace);
    }
    
    // Emit event
    this.emitTransitionEvent(updatedRace, currentStatus, targetStatus);
    
    return updatedRace;
  }

  /**
   * Perform the actual transition logic
   */
  private static async performTransition(race: Race, targetStatus: RaceStatus): Promise<Race> {
    const now = await chainTime.nowMs();
    
    switch (targetStatus) {
      case RaceStatus.LOCKED:
        return await this.transitionToLocked(race, now);
      
      case RaceStatus.IN_PROGRESS:
        return await this.transitionToInProgress(race, now);
      
      case RaceStatus.SETTLED:
        return await this.transitionToSettled(race, now);
      
      case RaceStatus.CANCELLED:
        return await this.transitionToCancelled(race, now);
      
      default:
        throw new Error(`Unsupported transition to ${targetStatus}`);
    }
  }

  /**
   * Transition to LOCKED state - capture baseline prices
   */
  private static async transitionToLocked(race: Race, timestamp: number): Promise<Race> {
    console.log(`🔒 Locking race ${race.id} - fetching fresh tokens and capturing baseline prices...`);
    // Global reservation to prevent concurrent locks across timers/admin/watchdog
    // Acquire in-memory guard first (always released in finally)
    if (this.inMemoryPhaseLockInUse) {
      throw new Error('Lock blocked: another lock operation is in-flight');
    }
    this.inMemoryPhaseLockInUse = true;

    // Best-effort persistent guard to avoid concurrent timers in rare edge cases
    const reserved = await getDb().reserveTransaction(this.GLOBAL_PHASE_LOCK_KEY);
    if (!reserved) {
      console.warn('⚠️ Global phase DB lock already held; proceeding with in-memory guard only');
    }
    try {
      // Re-read latest race state under the reservation to avoid stale-state races
      const latest = await getDb().getRace(race.id);
      if (!latest) {
        throw new Error(`Race ${race.id} not found during lock`);
      }
      if (latest.status !== RaceStatus.OPEN) {
        // Someone already progressed this race; return the freshest state
        return latest;
      }

      // Hard guard: ensure only one race can be LOCKED/IN_PROGRESS at any time
      try {
        const others = (await getDb().getRaces()).filter(r => r.id !== race.id);
        const hasActiveOther = others.some(r => r.status === RaceStatus.LOCKED || r.status === RaceStatus.IN_PROGRESS);
        if (hasActiveOther) {
          throw new Error('Lock blocked: another race is already LOCKED/IN_PROGRESS');
        }
      } catch {}
    
    // CRITICAL: Fetch fresh tokens NOW when race goes live (not at creation time)
    // This ensures we get the latest trending tokens, preventing batches of similar tokens
    let freshRunners = latest.runners;
    const hasPlaceholders = latest.runners.some((r: any) => r.mint.startsWith('placeholder_'));
    if (hasPlaceholders) {
      console.log(`🎯 Fetching fresh trending tokens for race ${race.id} at lock time...`);
      try {
        const { getNewPumpfunTokens } = await import('./runners');
        const tokens = await getNewPumpfunTokens(latest.runners.length);
        if (tokens.length >= 4) {
          freshRunners = tokens.slice(0, latest.runners.length);
          console.log(`✅ Selected ${freshRunners.length} fresh tokens: ${freshRunners.map((r: any) => r.symbol).join(', ')}`);
        } else {
          console.warn(`⚠️ Insufficient tokens (${tokens.length}), keeping placeholders`);
        }
      } catch (error) {
        console.error(`❌ Failed to fetch fresh tokens, keeping placeholders:`, error);
      }
    }
    
    // Capture current prices as baseline with resilient fallbacks to avoid stuck OPEN races
    let currentPrices: Array<{ mint: string; price: number }> = [];
    try {
      const { getGeckoTerminalPrices } = await import("./runners");
      const raceRunners = freshRunners.map(runner => ({
        mint: runner.mint,
        poolAddress: runner.poolAddress
      }));
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          currentPrices = await getGeckoTerminalPrices(raceRunners, { force: true, priority: 'high' });
          const haveAll = raceRunners.every(rr => currentPrices.some(p => p.mint === rr.mint));
          if (haveAll) break;
        } catch (innerErr) {
          if (attempt === maxAttempts) throw innerErr;
        }
        const delay = 200 * attempt + 150; // Fixed delay instead of random
        console.log(`⏳ [LOCK] Retry price snapshot in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (e) {
      console.warn(`⚠️ [LOCK] Price snapshot failed for race ${race.id}. Proceeding with fallback baselines.`);
      currentPrices = [];
    }

    // Update runners with baseline prices (fallback to currentPrice/initialPrice if snapshot missing)
    const updatedRunners = freshRunners.map(runner => {
      const priceData = currentPrices.find(p => p.mint === runner.mint);
      const baselinePrice = priceData?.price || runner.currentPrice || runner.initialPrice || 0;
      if (!priceData) {
        console.warn(`⚠️ [LOCK] Using fallback baseline for ${runner.symbol} (${runner.mint})`);
      }
      return {
        ...runner,
        initialPrice: baselinePrice,
        initialPriceUsd: baselinePrice,
        initialPriceTs: timestamp,
        currentPrice: baselinePrice,
        priceChange: 0
      };
    });

      const snapshot = chainTime.getSnapshot();
      let lockedRace: Race = {
      ...latest,
      status: RaceStatus.LOCKED,
      lockedTs: timestamp,
      lockedSlot: snapshot.lastObservedSlot || undefined,
      lockedBlockTimeMs: snapshot.lastObservedBlockTimeMs || undefined,
      runners: updatedRunners
      };

    console.log(`✅ Race ${race.id} locked with ${currentPrices.length} snapshot(s) and fallbacks where needed`);
    
    // House micro-seed: add both SOL and RACE seeds for UI coverage.
    // Note: Seeding is attributed to the escrow wallet so that if the house wins,
    // funds remain in escrow. Treasury continues to receive only the rake.
    try {
      const { seedHouseBetsForRace } = await import('./house-seed');
      const seededSol = await seedHouseBetsForRace(lockedRace, undefined, 'SOL');
      const ENABLE_RACE = String(process.env.ENABLE_RACE_BETS || '').toLowerCase();
      const allowRace = ENABLE_RACE === '1' || ENABLE_RACE === 'true';
      const seededRace = allowRace ? await seedHouseBetsForRace(lockedRace, undefined, 'RACE') : { created: 0, funded: false } as any;
      console.log(`🏦 [HOUSE_SEED] Created SOL ${seededSol.created}/${lockedRace.runners.length}${allowRace ? `, RACE ${seededRace.created}/${lockedRace.runners.length}` : ''} seed bets (funded=${seededSol.funded || (seededRace as any).funded})`);
    } catch (e) {
      console.warn(`⚠️ [HOUSE_SEED] Failed to seed house bets for race ${race.id}`, e);
    }

      return lockedRace;
    } finally {
      // Always release the global phase lock so other races can proceed later
      try { await getDb().releaseTransaction(this.GLOBAL_PHASE_LOCK_KEY); } catch {}
      this.inMemoryPhaseLockInUse = false;
    }
  }

  /**
   * Transition to IN_PROGRESS state - start live tracking
   */
  private static async transitionToInProgress(race: Race, timestamp: number): Promise<Race> {
    console.log(`🚀 Race ${race.id} going live - starting price tracking...`);
    
    const snapshot = chainTime.getSnapshot();
    const inProgressRace: Race = {
      ...race,
      status: RaceStatus.IN_PROGRESS,
      inProgressTs: timestamp,
      inProgressSlot: snapshot.lastObservedSlot || undefined,
      inProgressBlockTimeMs: snapshot.lastObservedBlockTimeMs || undefined,
      // Safety: if lockedTs was not recorded (e.g., due to crash), synthesize a reasonable baseline
      lockedTs: race.lockedTs || (timestamp - 2000),
      lockedBlockTimeMs: race.lockedBlockTimeMs || snapshot.lastObservedBlockTimeMs || undefined
    };

    console.log(`✅ Race ${race.id} now in progress - tracking price changes`);
    
    return inProgressRace;
  }

  /**
   * Transition to SETTLED state - determine winner and settle
   */
  private static async transitionToSettled(race: Race, timestamp: number): Promise<Race> {
    console.log(`⏰ Settling race ${race.id} - determining winner...`);
    
    try {
      // Compute price changes from GeckoTerminal OHLCV candles to match verification logic exactly
      const { getTokenOHLCV, calculateOHLCVPriceChange } = await import('./geckoterminal');
      const snapshot = chainTime.getSnapshot();
      const startMs = race.lockedBlockTimeMs || race.lockedTs || race.startTs;
      const endMs = snapshot.lastObservedBlockTimeMs || timestamp;
      const durationMs = Math.max(10 * 1000, endMs - startMs);
      const durationMinutes = Math.max(1, Math.ceil(durationMs / 60000));

      let results;
      let fallbackUsed = false;
      
      try {
        results = await Promise.all(
          race.runners.map(async (runner, index) => {
            try {
              const candles = await getTokenOHLCV(runner.mint, startMs, durationMinutes, runner.poolAddress);
              const analysis = calculateOHLCVPriceChange(candles, startMs, durationMinutes);
              return {
                index,
                symbol: runner.symbol,
                baselinePrice: analysis.startPrice,
                finalPrice: analysis.endPrice,
                priceChange: analysis.priceChange
              };
            } catch (e) {
              console.warn(`[SETTLE] OHLCV analysis failed for ${runner.symbol}`, e);
              const baseline = runner.initialPriceUsd || runner.initialPrice || 0;
              return {
                index,
                symbol: runner.symbol,
                baselinePrice: baseline,
                finalPrice: baseline,
                priceChange: 0
              };
            }
          })
        );
      } catch (e) {
        console.error(`[SETTLE] Failed to get any price data, using fallback winner selection`, e);
        fallbackUsed = true;
        // Fallback: Use current prices if available, or zero change
        results = race.runners.map((runner, index) => {
          const priceChange = runner.priceChange || 0; // Default to 0% change
          return {
            index,
            symbol: runner.symbol,
            baselinePrice: runner.initialPrice || 0,
            finalPrice: runner.currentPrice || runner.initialPrice || 0,
            priceChange
          };
        });
      }

      const priceChanges = results;

      // Find winner (highest price change)
      const winnerIndex = priceChanges.reduce((best, current, index) => 
        current.priceChange > priceChanges[best].priceChange ? index : best, 0
      );

      const winner = priceChanges[winnerIndex];
      
      console.log(`📊 Final price changes: ${priceChanges.map(p => `${p.symbol}: ${p.priceChange.toFixed(2)}%`).join(', ')}`);
      console.log(`🏆 Winner: ${winner.symbol} with ${winner.priceChange.toFixed(2)}% gain`);
      if (fallbackUsed) {
        console.log(`⚠️  Fallback winner selection was used due to API issues`);
      }

      // Update runners array with calculated price changes for Telegram notifications
      const updatedRunners = race.runners.map((runner, index) => ({
        ...runner,
        priceChange: priceChanges[index].priceChange
      }));

      const settledRace: Race = {
        ...race,
        runners: updatedRunners,
        status: RaceStatus.SETTLED,
        winnerIndex,
        drandRound: Math.floor(timestamp / 1000), // Settlement timestamp
        drandRandomness: JSON.stringify(priceChanges), // Price change data for verification
        drandSignature: `price_based_${winnerIndex}_${winner.priceChange.toFixed(4)}${fallbackUsed ? '_fallback' : ''}`, // Winner verification signature
        settledSlot: snapshot.lastObservedSlot || undefined,
        settledBlockTimeMs: snapshot.lastObservedBlockTimeMs || undefined
      };

      // Execute settlement
      await this.executeSettlement(settledRace);
      
      console.log(`✅ Race ${race.id} settled successfully with winner index ${winnerIndex}`);
      
    // After a race is settled, ensure the system is topped back up to 3 OPEN races
    try {
      const { createNewRaceIfNeeded } = await import('./sse');
      await createNewRaceIfNeeded();
    } catch {}

    return settledRace;
      
    } catch (error) {
      console.error(`❌ Failed to settle race ${race.id}:`, error);
      throw new Error(`Failed to settle race: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Transition to CANCELLED state - refund bets
   */
  private static async transitionToCancelled(race: Race, timestamp: number): Promise<Race> {
    console.log(`❌ Cancelling race ${race.id} - processing refunds...`);
    
    try {
      // Refund all bets
      const { refundRace } = await import("./settlement");
      await refundRace(race);
      
      const cancelledRace: Race = {
        ...race,
        status: RaceStatus.CANCELLED
      };

      console.log(`✅ Race ${race.id} cancelled and refunds processed`);
      
      return cancelledRace;
      
    } catch (error) {
      // Degrade gracefully: if refunds cannot be executed (e.g. mint/ATA missing
      // during maintenance or degraded startup), still mark the race as CANCELLED
      // so the system can recover and new races can proceed.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️ Refunds skipped during cancel for ${race.id}: ${message}`);
      const cancelledRace: Race = { ...race, status: RaceStatus.CANCELLED };
      return cancelledRace;
    }
  }

  /**
   * Execute settlement logic
   */
  private static async executeSettlement(race: Race): Promise<void> {
    // Top-level idempotency guard to prevent duplicate settlement
    const settlementKey = `settlement_${race.id}`;
    const reserved = await getDb().reserveTransaction(settlementKey);
    if (!reserved) {
      console.log(`⏭️  Skipping duplicate settlement for race ${race.id}`);
      return;
    }
    
    const allBets = await getDb().getBetsForRace(race.id) as any[];
    if ((allBets || []).length === 0) {
      console.log(`No bets to settle for race ${race.id}`);
      // Still mark as processed to prevent retry loops
      await getDb().recordTransaction(settlementKey);
      return;
    }

    const { calculateSettlement } = await import("./settlement");
    const DecimalLib = await import('decimal.js');
    const Decimal = DecimalLib.default;
    // Treasury/house wallet used for protocol seeding
    const { serverKeypair, treasuryPubkey } = await import("./solana");
    // Treat both escrow and treasury as house for statistics; escrow now places seeds.
    const escrowWallet = serverKeypair.publicKey.toString();
    const treasuryWallet = (treasuryPubkey || serverKeypair.publicKey).toString();
    const houseWallets = new Set<string>([escrowWallet, treasuryWallet]);

    // Split by currency (explicitly check for RACE currency, ignore NULL)
    const raceBets = allBets.filter(b => b?.currency === 'RACE');
    const solBets = allBets.filter(b => b?.currency === 'SOL' || !b?.currency);

    // 1) Settle RACE bets (keeps jackpot accounting and leaderboard semantics)
    if (raceBets.length > 0) {
      const settlement = await calculateSettlement(raceBets as any, race);
      const noWinners = (settlement as any)?.winningBets?.length === 0;

      // Optional: mirror jackpot flows on-chain for transparency
      const JACKPOT_MIRROR = String(process.env.JACKPOT_MIRROR_ONCHAIN || '').toLowerCase() === 'true';
      const existingTransfersAll = await getDb().getSettlementTransfers(race.id) || [];
      const idBaseJackpot = `jackpot_${Date.now()}_${race.id.slice(-8)}`;

      // Record per-user results and stats (RACE only)
      try {
        const { computeEdgePoints } = await import('./edge-points');
        const totalPotStr = settlement.totalPot.toString();
        const payoutByWallet = new Map<string, any>();
        settlement.winnerPayouts.forEach((amt: any, wallet: string) => payoutByWallet.set(wallet, amt));
        const betByWallet = new Map<string, any>();
        // Include HOUSE_SEED bets only for the treasury/house wallet so its stats reflect participation
        const consideredBets = (raceBets as any[]).filter(b => {
          const isSeed = (b?.clientId === 'HOUSE_SEED' || b?.memo === 'HOUSE_SEED');
          if (!isSeed) return true;
          return houseWallets.has(String(b?.wallet));
        });
        consideredBets.forEach(b => {
          const prev = (betByWallet as any).get(b.wallet) || new Decimal(0);
          (betByWallet as any).set(b.wallet, prev.add(new Decimal(b.amount)));
        });
        if (noWinners) {
          (betByWallet as any).forEach((betAmt: any, wallet: string) => payoutByWallet.set(wallet, betAmt));
        }
        const wallets = new Set<string>(
          Array.from(betByWallet.keys()).concat(Array.from(payoutByWallet.keys()))
        );
        for (const wallet of wallets) {
          const betAmt = (betByWallet as any).get(wallet) || new Decimal(0);
          const payoutAmt = payoutByWallet.get(wallet) || new Decimal(0);
          const win = !noWinners && payoutAmt.gt(0);
          // Treasury wallet should not accrue Edge Points
          const edge = houseWallets.has(wallet) ? '0' : computeEdgePoints({
            betAmount: betAmt.toString(),
            payoutAmount: payoutAmt.toString(),
            totalPot: totalPotStr,
            win
          });
          await getDb().upsertUserRaceResult({
            wallet,
            raceId: race.id,
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

      // Update jackpot accounting (RACE only) atomically and clamp to zero, with idempotency guard
      try {
        const adjustKey = `jackpot_adjust_RACE_${race.id}`;
        const reserved = await getDb().reserveTransaction(adjustKey);
        if (!reserved) {
          console.log(`⏭️  Skipping duplicate RACE jackpot adjustment for ${race.id}`);
        } else {
          const delta = settlement.jackpotContribution.sub(settlement.jackpotPayout).toString();
          const result = await getDb().adjustJackpotBalances({ deltaRace: delta });
          // Mark as processed
          await getDb().recordTransaction(adjustKey);
          console.log(`🎰 Jackpot (RACE) updated -> ${result.jackpotBalance} (Δ=${delta})`);
        }
        // Preserve raceMint but avoid racing on other treasury fields
        const treasury = await getDb().getTreasury();
        if (treasury?.raceMint) {
          await getDb().updateTreasury({ raceMint: treasury.raceMint } as any);
        }
      } catch (e) {
        const treasury = await getDb().getTreasury();
        const prevJackpot = new Decimal(treasury.jackpotBalance || '0');
        const newJackpot = prevJackpot.add(settlement.jackpotContribution).sub(settlement.jackpotPayout);
        const clamped = newJackpot.isNegative() ? new Decimal(0) : newJackpot;
        await getDb().updateTreasury({ jackpotBalance: clamped.toString(), raceMint: treasury.raceMint } as any);
      }
      // Mark race with jackpot payout for UI
      await getDb().updateRace({
        ...race,
        jackpotAdded: settlement.jackpotPayout.toNumber()
      } as any);

      // If mirroring jackpot on-chain and there is a jackpot payout, pull from jackpot → escrow before payouts
      if (JACKPOT_MIRROR && settlement.jackpotPayout?.gt?.(0)) {
        try {
          const alreadyPulled = existingTransfersAll.some((t: any) => t.transferType === 'JACKPOT' && t.toWallet === 'escrow' && (t?.currency || 'RACE') === 'RACE');
          if (!alreadyPulled) {
            const { getRaceMint, getMintDecimals, transferJackpotToEscrow } = await import('./solana');
            const { Decimal } = await import('decimal.js');
            const raceMint = await getRaceMint();
            const decimals = await getMintDecimals(raceMint);
            const amt = BigInt(new Decimal(settlement.jackpotPayout.toString()).mul(new Decimal(10).pow(decimals)).toString());
            const txSig = await transferJackpotToEscrow({ mint: raceMint, amount: amt });
            if (txSig && txSig !== 'noop') {
              await getDb().recordSettlementTransfer({
                id: `${idBaseJackpot}_pull_RACE`,
                raceId: race.id,
                transferType: 'JACKPOT',
                toWallet: 'escrow',
                amount: settlement.jackpotPayout.toString(),
                txSig,
                currency: 'RACE',
                ts: Date.now()
              });
            }
          }
        } catch (e) {
          console.warn('⚠️ Jackpot pull (RACE) skipped:', e instanceof Error ? e.message : e);
        }
      }

      // Execute payouts/refunds for RACE
      if ((settlement as any)?.winningBets?.length === 0) {
        const betByWallet = new Map<string, any>();
        (raceBets as any[]).forEach(b => {
          const prev = (betByWallet as any).get(b.wallet) || new Decimal(0);
          (betByWallet as any).set(b.wallet, prev.add(new Decimal(b.amount)));
        });
        await this.executeRefunds(race, betByWallet);
      } else {
        await this.executePayouts(race, settlement);
      }

      // Compute referral rewards from protocol rake (RACE)
      try {
        const { computeReferralRewards, getAttributionForWallet, resolveLineageFromCode, queueReferralRewards } = await import('./referrals');
        const rakeTotal = settlement.treasuryRake as any as Decimal; // total protocol rake used for pool basis
        const pending: Array<any> = [];
        const seen = new Set<string>();
        // For each betting wallet, if attributed, enqueue rewards; idempotent by (race, from->to, level)
        const wallets = Array.from(new Set((raceBets as any[]).map(b => b.wallet)));
        for (const w of wallets) {
          const code = await getAttributionForWallet(w);
          if (!code) continue;
          const lineage = await resolveLineageFromCode(code);
          if (!lineage || lineage.length === 0) continue;
          const rewards = await computeReferralRewards({ totalRake: rakeTotal, currency: 'RACE', raceId: race.id, betterWallet: w, lineage });
          if (rewards && Array.isArray(rewards)) {
            for (const r of rewards) {
              const key = `${r.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              pending.push(r);
            }
          }
        }
        if (pending.length > 0) await queueReferralRewards(pending);
      } catch (e) {
        console.warn('⚠️ Referral rewards computation (RACE) failed:', (e as any)?.message || e);
      }

      // After payouts, if mirroring jackpot on-chain and there is a contribution, push escrow → jackpot
      if (JACKPOT_MIRROR && settlement.jackpotContribution?.gt?.(0)) {
        const jackpotResKey = `jackpot_RACE_${race.id}`;
        const reserved = await getDb().reserveTransaction(jackpotResKey);
        if (!reserved) {
          console.log(`⏭️  Skipping duplicate RACE jackpot transfer for ${race.id}`);
        } else {
          try {
            const { getRaceMint, getMintDecimals, transferJackpot } = await import('./solana');
            const { Decimal } = await import('decimal.js');
            const raceMint = await getRaceMint();
            const decimals = await getMintDecimals(raceMint);
            const amt = BigInt(new Decimal(settlement.jackpotContribution.toString()).mul(new Decimal(10).pow(decimals)).toString());
            const txSig = await transferJackpot({ mint: raceMint, amount: amt });
            await getDb().recordSettlementTransfer({
              id: `${idBaseJackpot}_push_RACE`,
              raceId: race.id,
              transferType: 'JACKPOT',
              toWallet: 'jackpot',
              amount: settlement.jackpotContribution.toString(),
              txSig,
              currency: 'RACE',
              ts: Date.now()
            });
            try { await getDb().recordTransaction(jackpotResKey); } catch {}
            console.log(`🎰 Jackpot transferred: ${settlement.jackpotContribution.toString()} RACE`);
          } catch (e) {
            console.warn('⚠️ Jackpot push (RACE) failed:', e instanceof Error ? e.message : e);
          }
        }
      }

      // Emit user_loss events (RACE only)
      try {
        const betByWallet = new Map<string, any>();
        (raceBets as any[]).forEach(b => {
          const prev = (betByWallet as any).get(b.wallet) || new Decimal(0);
          (betByWallet as any).set(b.wallet, prev.add(new Decimal(b.amount)));
        });
        Array.from(betByWallet.keys()).filter(wallet => {
          const betAmt = (betByWallet as any).get(wallet);
          const payout = settlement.winnerPayouts.get(wallet);
          return betAmt?.gt?.(0) && (!payout || !payout?.gt?.(0));
        }).forEach(wallet => {
          try {
            const betAmt = (betByWallet as any).get(wallet);
            raceEvents.emit('user_loss', { raceId: race.id, wallet, lostAmount: betAmt?.toString?.() ?? '0' });
          } catch {}
        });
      } catch {}
    }

    // 2) Settle SOL bets (with separate SOL jackpot; 5% rake)
    if (solBets.length > 0) {
      const raceForSol = { ...race, rakeBps: 500, jackpotFlag: race.jackpotFlag } as Race;
      // For SOL: 5% rake with 3% treasury and 2% jackpot -> 60%/40% split of total rake
      const settlementSol = await calculateSettlement(solBets as any, raceForSol, { treasuryRatio: 0.6, jackpotRatio: 0.4 });

      const JACKPOT_MIRROR = String(process.env.JACKPOT_MIRROR_ONCHAIN || '').toLowerCase() === 'true';
      const existingTransfersAll = await getDb().getSettlementTransfers(race.id) || [];
      const idBaseJackpotSol = `jackpot_${Date.now()}_${race.id.slice(-8)}_SOL`;

      // Update SOL jackpot accounting in treasury atomically and clamp to zero
      try {
        const adjustKeySol = `jackpot_adjust_SOL_${race.id}`;
        const reservedSol = await getDb().reserveTransaction(adjustKeySol);
        if (!reservedSol) {
          console.log(`⏭️  Skipping duplicate SOL jackpot adjustment for ${race.id}`);
        } else {
          const deltaSol = settlementSol.jackpotContribution.sub(settlementSol.jackpotPayout).toString();
          const result = await getDb().adjustJackpotBalances({ deltaSol });
          await getDb().recordTransaction(adjustKeySol);
          console.log(`🎰 Jackpot (SOL) updated -> ${result.jackpotBalanceSol} (Δ=${deltaSol})`);
        }
      } catch {}

      // If mirroring jackpot on-chain for SOL and payout required, pull from jackpot → escrow first
      if (JACKPOT_MIRROR && settlementSol.jackpotPayout?.gt?.(0)) {
        try {
          const alreadyPulled = existingTransfersAll.some((t: any) => t.transferType === 'JACKPOT' && t.toWallet === 'escrow' && (t?.currency || 'RACE') === 'SOL');
          if (!alreadyPulled) {
            const { Decimal } = await import('decimal.js');
            const lamports = BigInt(new Decimal(settlementSol.jackpotPayout.toString()).mul(new Decimal(10).pow(9)).toString());
            const { transferSolFromJackpot } = await import('./solana');
            const txSig = await transferSolFromJackpot(lamports);
            if (txSig && txSig !== 'noop') {
              await getDb().recordSettlementTransfer({
                id: `${idBaseJackpotSol}_pull_SOL`,
                raceId: race.id,
                transferType: 'JACKPOT',
                toWallet: 'escrow',
                amount: settlementSol.jackpotPayout.toString(),
                txSig,
                currency: 'SOL',
                ts: Date.now()
              });
            }
          }
        } catch (e) {
          console.warn('⚠️ Jackpot pull (SOL) skipped:', e instanceof Error ? e.message : e);
        }
      }

      // Record per-user results and stats (SOL as well)
      try {
        const { computeEdgePoints } = await import('./edge-points');
        const DecimalLib = await import('decimal.js');
        const Decimal = DecimalLib.default;
        const payoutByWallet = new Map<string, any>();
        settlementSol.winnerPayouts.forEach((amt: any, wallet: string) => payoutByWallet.set(wallet, amt));
        const betByWallet = new Map<string, any>();
        // Include HOUSE_SEED bets only for the treasury/house wallet so its stats reflect participation
        (solBets as any[]).filter(b => {
          const isSeed = (b?.clientId === 'HOUSE_SEED' || b?.memo === 'HOUSE_SEED');
          if (!isSeed) return true;
          return houseWallets.has(String(b?.wallet));
        }).forEach(b => {
          const prev = (betByWallet as any).get(b.wallet) || new Decimal(0);
          (betByWallet as any).set(b.wallet, prev.add(new Decimal(b.amount)));
        });
        const noWinnersSol = (settlementSol as any)?.winningBets?.length === 0;
        if (noWinnersSol) {
          // Treat as refund: payout equals bet amount
          (betByWallet as any).forEach((betAmt: any, wallet: string) => payoutByWallet.set(wallet, betAmt));
        }
        const totalPotStrSol = settlementSol.totalPot.toString();
        const walletsSol = new Set<string>(
          Array.from(betByWallet.keys()).concat(Array.from(payoutByWallet.keys()))
        );
        for (const wallet of walletsSol) {
          const betAmt = (betByWallet as any).get(wallet) || new Decimal(0);
          const payoutAmt = payoutByWallet.get(wallet) || new Decimal(0);
          const win = !noWinnersSol && payoutAmt.gt(0);
          // Treasury wallet should not accrue Edge Points
          const edge = houseWallets.has(wallet) ? '0' : computeEdgePoints({
            betAmount: betAmt.toString(),
            payoutAmount: payoutAmt.toString(),
            totalPot: totalPotStrSol,
            win
          });
          await getDb().upsertUserRaceResult({
            wallet,
            raceId: race.id,
            betAmount: betAmt.toString(),
            payoutAmount: payoutAmt.toString(),
            win,
            edgePoints: edge,
            ts: Date.now()
          });
          await getDb().recalcUserStats(wallet);
        }
      } catch (e) {
        console.error('Failed to record SOL leaderboard results:', e);
      }

      // Execute payouts/refunds for SOL using native SOL transfers
      if ((settlementSol as any)?.winningBets?.length === 0) {
        const betByWallet = new Map<string, any>();
        // Exclude house seeds from refunds logic as well
        (solBets as any[]).filter(b => (b?.clientId !== 'HOUSE_SEED' && b?.memo !== 'HOUSE_SEED')).forEach(b => {
          const prev = (betByWallet as any).get(b.wallet) || new Decimal(0);
          (betByWallet as any).set(b.wallet, prev.add(new Decimal(b.amount)));
        });
        await this.executeRefunds(raceForSol, betByWallet, 'SOL');
      } else {
        await this.executePayouts(raceForSol, settlementSol, undefined, 'SOL');
      }

      // Compute referral rewards from protocol rake (SOL)
      try {
        const { computeReferralRewards, getAttributionForWallet, resolveLineageFromCode, queueReferralRewards } = await import('./referrals');
        const rakeTotal = settlementSol.treasuryRake as any as Decimal;
        const pending: Array<any> = [];
        const seen = new Set<string>();
        const wallets = Array.from(new Set((solBets as any[]).map(b => b.wallet)));
        for (const w of wallets) {
          const code = await getAttributionForWallet(w);
          if (!code) continue;
          const lineage = await resolveLineageFromCode(code);
          if (!lineage || lineage.length === 0) continue;
          const rewards = await computeReferralRewards({ totalRake: rakeTotal, currency: 'SOL', raceId: race.id, betterWallet: w, lineage });
          if (rewards && Array.isArray(rewards)) {
            for (const r of rewards) { const key = `${r.id}`; if (seen.has(key)) continue; seen.add(key); pending.push(r); }
          }
        }
        if (pending.length > 0) await queueReferralRewards(pending);
      } catch (e) {
        console.warn('⚠️ Referral rewards computation (SOL) failed:', (e as any)?.message || e);
      }

      // After payouts, push SOL jackpot contribution to jackpot wallet if mirroring is enabled
      if (JACKPOT_MIRROR && settlementSol.jackpotContribution?.gt?.(0)) {
        const jackpotResKey = `jackpot_SOL_${race.id}`;
        const reserved = await getDb().reserveTransaction(jackpotResKey);
        if (!reserved) {
          console.log(`⏭️  Skipping duplicate SOL jackpot transfer for ${race.id}`);
        } else {
          try {
            const { Decimal } = await import('decimal.js');
            const lamports = BigInt(new Decimal(settlementSol.jackpotContribution.toString()).mul(new Decimal(10).pow(9)).toString());
            const { transferSolJackpot } = await import('./solana');
            const txSig = await transferSolJackpot(lamports);
            await getDb().recordSettlementTransfer({
              id: `${idBaseJackpotSol}_push_SOL`,
              raceId: race.id,
              transferType: 'JACKPOT',
              toWallet: 'jackpot',
              amount: settlementSol.jackpotContribution.toString(),
              txSig,
              currency: 'SOL',
              ts: Date.now()
            });
            try { await getDb().recordTransaction(jackpotResKey); } catch {}
            console.log(`🎰 Jackpot transferred: ${settlementSol.jackpotContribution.toString()} SOL`);
          } catch (e) {
            console.warn('⚠️ Jackpot push (SOL) failed:', e instanceof Error ? e.message : e);
          }
        }
      }

      // Emit user_loss events for SOL as well (non-winners only)
      try {
        const betByWallet = new Map<string, any>();
        (solBets as any[]).forEach(b => {
          const prev = (betByWallet as any).get(b.wallet) || new Decimal(0);
          (betByWallet as any).set(b.wallet, prev.add(new Decimal(b.amount)));
        });
        Array.from(betByWallet.keys()).filter(wallet => {
          const betAmt = (betByWallet as any).get(wallet);
          const payout = settlementSol.winnerPayouts.get(wallet);
          return betAmt?.gt?.(0) && (!payout || !payout?.gt?.(0));
        }).forEach(wallet => {
          try {
            const betAmt = (betByWallet as any).get(wallet);
            raceEvents.emit('user_loss', { raceId: race.id, wallet, lostAmount: betAmt?.toString?.() ?? '0', currency: 'SOL' });
          } catch {}
        });
      } catch {}
    }

    // Execute meme reward (buy winning coin and send to random bettor)
    console.log(`🎯 Settlement: Checking meme reward (ENABLE_MEME_REWARD=${process.env.ENABLE_MEME_REWARD})`);
    try {
      const { executeMemeReward } = await import('./meme-rewards');
      console.log(`🎯 Settlement: About to call executeMemeReward for race ${race.id}, ${allBets.length} bets`);
      const memeRewardResult = await executeMemeReward(race, allBets);
      
      if (memeRewardResult) {
        console.log(`🪙 Meme reward executed: ${memeRewardResult.tokenAmount} ${memeRewardResult.coinSymbol} sent to ${memeRewardResult.recipient}`);
        
        // Update race with meme reward details
        await getDb().updateRace({
          ...race,
          memeRewardEnabled: true,
          memeRewardRecipient: memeRewardResult.recipient,
          memeRewardTokenAmount: memeRewardResult.tokenAmount,
          memeRewardSolSpent: memeRewardResult.solSpent,
          memeRewardTxSig: memeRewardResult.txSig
        } as any);
        console.log(`🎯 Settlement: Meme reward database updated for race ${race.id}`);
      } else {
        console.log(`🎯 Settlement: executeMemeReward returned undefined (check [meme-reward] logs for reason)`);
      }
    } catch (error) {
      console.error('❌ Meme reward execution error:', error);
      console.warn('⚠️ Meme reward execution failed (settlement continues):', error instanceof Error ? error.message : error);
      // Don't throw - meme reward failure should not break settlement
    }

    // Mark settlement as complete to prevent duplicate execution
    await getDb().recordTransaction(settlementKey);
    console.log(`💰 Settlement complete for race ${race.id}`);
  }

  /**
   * Execute actual payouts
   */
  private static async executePayouts(race: Race, settlement: any, betByWallet?: Map<string, any>, currency: 'RACE' | 'SOL' = 'RACE'): Promise<void> {
    try {
      // Feature flag: allow blocking of settlements at execution time (graceful pause)
      const blockSettle = ((process.env.BLOCK_SETTLEMENTS || '').toLowerCase() === '1' || (process.env.BLOCK_SETTLEMENTS || '').toLowerCase() === 'true');
      if (blockSettle) {
        console.warn(`⏸️ BLOCK_SETTLEMENTS active: skipping payouts for race ${race.id}`);
        return;
      }
      const { transferFromEscrow, transferRakeToTreasury, getRaceMint, getMintDecimals, transferSolFromEscrow, transferSolRakeToTreasury, serverKeypair, treasuryPubkey } = await import("./solana");
      const { PublicKey } = await import("@solana/web3.js");
      const { Decimal } = await import("decimal.js");
      const existingTransfers = await getDb().getSettlementTransfers(race.id) || [];
      let raceMint: any = null;
      let decimals = 9;
      if (currency === 'RACE') {
        raceMint = await getRaceMint();
        decimals = await getMintDecimals(raceMint);
      }
      const idBase = `transfer_${Date.now()}_${race.id.slice(-8)}`; // Use race ID suffix instead of random

      // Transfer rake to treasury (SPL path; SOL path handled separately per-bet currency not tracked here)
      const rakeAlreadySent = existingTransfers.some((t: any) => t.transferType === 'RAKE' && ((t?.currency || 'RACE') === currency));
      if (settlement.treasuryRake?.gt(0) && !rakeAlreadySent) {
        // Concurrency/idempotency guard to prevent double rake on concurrent settlements
        const rakeResKey = `rake_${currency}_${race.id}`;
        const reserved = await getDb().reserveTransaction(rakeResKey);
        if (!reserved) {
          // Another worker already processed rake
        } else {
        try {
          let txSig: string;
          if (currency === 'SOL') {
            const lamports = BigInt(settlement.treasuryRake.mul(new Decimal(10).pow(9)).toString());
            txSig = await transferSolRakeToTreasury(lamports);
          } else {
            const amount = BigInt(settlement.treasuryRake.mul(new Decimal(10).pow(decimals)).toString());
            txSig = await transferRakeToTreasury({ mint: raceMint, amount });
          }
          
          await getDb().recordSettlementTransfer({
            id: `${idBase}_rake`,
            raceId: race.id,
            transferType: "RAKE",
            toWallet: "treasury",
            amount: settlement.treasuryRake.toString(),
            txSig,
            currency,
            ts: Date.now()
          });
          try { await getDb().recordTransaction(rakeResKey); } catch {}
          
          console.log(`💰 Rake transferred: ${settlement.treasuryRake.toString()} ${currency}`);
        } catch (error) {
          console.error("❌ Rake transfer failed:", error);
        }
        }
      }

      // Do NOT transfer jackpot contribution on-chain; it's accounted in DB and remains in escrow.
      // Log units based on currency for clarity.
      if (settlement.jackpotContribution?.gt(0)) {
        console.log(`🎰 Jackpot contribution accounted: ${settlement.jackpotContribution.toString()} ${currency}`);
      }

      // Transfer winnings to winners (from pot + jackpot payout if any) from escrow
      // NEW: Use batched payout system for better scalability
      const escrowWalletStr = serverKeypair.publicKey.toString();
      // Treat both escrow and treasury as house wallets; keep their winnings in escrow
      const houseWallets = new Set<string>([
        escrowWalletStr,
        (treasuryPubkey || serverKeypair.publicKey).toString()
      ]);

      // Collect all eligible payouts (filtering house wallets and already-paid)
      const payoutRecipients: Array<{ wallet: string; amount: Decimal }> = [];
      for (const [wallet, payout] of settlement.winnerPayouts.entries()) {
        if (!payout?.gt?.(0)) continue;
        
        // Do not send payouts to house wallets (escrow or treasury); keep their winnings in escrow
        if (houseWallets.has(wallet)) {
          console.log(`🏦 Skipping payout to house wallet (${currency}) for ${payout.toString()} (retained in escrow): ${wallet}`);
          continue;
        }
        
        // Idempotency: skip if we already recorded a payout to this wallet for this race
        const alreadyPaid = existingTransfers.some((t: any) => 
          t.transferType === 'PAYOUT' && 
          t.toWallet === wallet && 
          ((t?.currency || 'RACE') === currency) &&
          (t?.status === 'SUCCESS' || !t?.status) // Consider successful if no status (old records)
        );
        if (alreadyPaid) {
          console.log(`⏭️ Skipping already-paid wallet: ${wallet}`);
          continue;
        }
        
        // Additional guard: reserve a synthetic key to prevent concurrent double-sends
        const reservationKey = `payout_${currency}_${race.id}_${wallet}`;
        const reserved = await getDb().reserveTransaction(reservationKey);
        if (!reserved) {
          console.log(`⏭️ Skipping reserved wallet: ${wallet}`);
          continue;
        }
        
        payoutRecipients.push({
          wallet,
          amount: payout
        });
      }

      // Send payouts in batches of 5 for efficiency
      if (payoutRecipients.length > 0) {
        console.log(`📦 Sending ${payoutRecipients.length} payouts in batches...`);
        
        try {
          const { sendBatchedPayouts } = await import('./batched-settlement');
          const mint = currency === 'SOL' 
            ? new PublicKey('So11111111111111111111111111111111111111112')
            : raceMint;
          
          const batchResult = await sendBatchedPayouts(
            race.id,
            currency,
            mint,
            payoutRecipients,
            'PAYOUT'
          );

          console.log(`✅ Batched payouts complete: ${batchResult.totalSent}/${payoutRecipients.length} successful`);

          // Emit SSE events for successful payouts
          for (const wallet of batchResult.successfulRecipients) {
            const payoutAmount = payoutRecipients.find(r => r.wallet === wallet)?.amount;
            if (payoutAmount) {
              try {
                raceEvents.emit('payout_executed', {
                  raceId: race.id,
                  wallet,
                  payoutAmount: payoutAmount.toString(),
                  currency
                });
              } catch {}
            }
          }

          // Log any failures
          if (batchResult.failedRecipients.length > 0) {
            console.error(`❌ ${batchResult.failedRecipients.length} payouts failed after retries`);
            for (const failed of batchResult.failedRecipients) {
              try {
                await getDb().recordSettlementError({
                  id: `err_${currency}_${race.id}_${failed.wallet}_${Date.now()}`,
                  raceId: race.id,
                  toWallet: failed.wallet,
                  amount: payoutRecipients.find(r => r.wallet === failed.wallet)?.amount.toString(),
                  currency,
                  error: failed.error
                } as any);
              } catch {}
            }
          }

        } catch (error) {
          console.error(`❌ Batched payout system failed, falling back to sequential:`, error);
          
          // FALLBACK: Use original sequential method if batching fails
          let payoutCount = 0;
          for (const {wallet, amount: payout} of payoutRecipients) {
            try {
              const memo = `payout:${race.id}:${wallet}`;
              let txSig: string;
              if (currency === 'SOL') {
                const lamports = BigInt(payout.mul(new Decimal(10).pow(9)).toString());
                txSig = await transferSolFromEscrow({ to: new PublicKey(wallet), lamports, memo });
              } else {
                const amount = BigInt(payout.mul(new Decimal(10).pow(decimals)).toString());
                txSig = await transferFromEscrow({ mint: raceMint, to: new PublicKey(wallet), amount, memo });
              }
              
              await getDb().recordSettlementTransfer({
                id: `${idBase}_payout_${payoutCount++}`,
                raceId: race.id,
                transferType: "PAYOUT",
                toWallet: wallet,
                amount: payout.toString(),
                txSig,
                currency,
                ts: Date.now(),
                status: 'SUCCESS'
              });
              
              console.log(`💰 Winner payout: ${payout.toString()} ${currency} to ${wallet}`);
              try {
                raceEvents.emit('payout_executed', {
                  raceId: race.id,
                  wallet,
                  payoutAmount: payout.toString(),
                  txSig,
                  currency
                });
              } catch {}
            } catch (error2) {
              console.error(`❌ Payout to ${wallet} failed:`, error2);
              try {
                const errMsg = error2 instanceof Error ? error2.message : String(error2);
                await getDb().recordSettlementError({
                  id: `err_${currency}_${race.id}_${wallet}_${Date.now()}`,
                  raceId: race.id,
                  toWallet: wallet,
                  amount: payout?.toString?.() ?? undefined,
                  currency,
                  error: errMsg
                } as any);
              } catch {}
            }
            await new Promise(r => setTimeout(r, 150));
          }
        }
      } else {
        console.log(`✅ No payouts needed (${settlement.winnerPayouts.size} total, all filtered/already-paid)`);
      }
      
    } catch (error) {
      console.error("❌ Failed to execute payouts:", error);
      throw error;
    }
  }

  /**
   * Execute refunds when there are no winning bets
   */
  private static async executeRefunds(race: Race, betByWallet: Map<string, any>, currency: 'RACE' | 'SOL' = 'RACE'): Promise<void> {
    try {
      // Feature flag: allow blocking of settlements at execution time (graceful pause)
      const blockSettle = ((process.env.BLOCK_SETTLEMENTS || '').toLowerCase() === '1' || (process.env.BLOCK_SETTLEMENTS || '').toLowerCase() === 'true');
      if (blockSettle) {
        console.warn(`⏸️ BLOCK_SETTLEMENTS active: skipping refunds for race ${race.id}`);
        return;
      }
      const { transferFromEscrow, getRaceMint, getMintDecimals, transferSolFromEscrow } = await import("./solana");
      const { PublicKey } = await import("@solana/web3.js");
      const { Decimal } = await import("decimal.js");
      const existingTransfers = await getDb().getSettlementTransfers(race.id) || [];
      let raceMint: any = null;
      let decimals = 9;
      if (currency === 'RACE') {
        raceMint = await getRaceMint();
        decimals = await getMintDecimals(raceMint);
      }
      const idBase = `refund_${Date.now()}_${race.id.slice(-8)}`;

      let refundCount = 0;
      for (const [wallet, betAmt] of betByWallet.entries()) {
        if (!betAmt?.gt?.(0)) continue;
        // Idempotency: skip if refund already recorded to this wallet for this race
        const alreadyRefunded = existingTransfers.some((t: any) => t.transferType === 'PAYOUT' && t.toWallet === wallet);
        if (alreadyRefunded) continue;
        try {
          const memo = `refund:${race.id}:${wallet}`;
          let txSig: string;
          if (currency === 'SOL') {
            const lamports = BigInt(betAmt.mul(new Decimal(10).pow(9)).toString());
            txSig = await transferSolFromEscrow({ to: new PublicKey(wallet), lamports, memo });
          } else {
            const amount = BigInt(betAmt.mul(new Decimal(10).pow(decimals)).toString());
            txSig = await transferFromEscrow({ mint: raceMint, to: new PublicKey(wallet), amount, memo });
          }

          await getDb().recordSettlementTransfer({
            id: `${idBase}_refund_${refundCount++}`,
            raceId: race.id,
            transferType: "PAYOUT", // Use PAYOUT type for refunds to fit schema
            toWallet: wallet,
            amount: betAmt.toString(),
            txSig,
            currency,
            ts: Date.now()
          });

          console.log(`↩️  Refunded ${betAmt.toString()} ${currency} to ${wallet}`);
          try {
            raceEvents.emit('payout_executed', {
              raceId: race.id,
              wallet,
              payoutAmount: betAmt.toString(),
              txSig,
              refund: true,
              currency
            });
          } catch {}
        } catch (error) {
          console.error(`❌ Refund to ${wallet} failed:`, error);
          try {
            const errMsg = error instanceof Error ? error.message : String(error);
            await getDb().recordSettlementError({
              id: `err_refund_${currency}_${race.id}_${wallet}_${Date.now()}`,
              raceId: race.id,
              toWallet: wallet,
              amount: betAmt?.toString?.() ?? undefined,
              currency,
              error: errMsg
            } as any);
          } catch {}
        }
        await new Promise(r => setTimeout(r, 150));
      }
    } catch (error) {
      console.error("❌ Failed to execute refunds:", error);
      throw error;
    }
  }

  /**
   * Emit transition events
   */
  private static emitTransitionEvent(race: Race, fromStatus: RaceStatus, toStatus: RaceStatus): void {
    const eventMap = {
      [RaceStatus.LOCKED]: 'race_locked',
      [RaceStatus.IN_PROGRESS]: 'race_live',
      [RaceStatus.SETTLED]: 'race_settled',
      [RaceStatus.CANCELLED]: 'race_cancelled'
    };

    const eventName = eventMap[toStatus];
    if (eventName) {
      // Special handling for settled events to prevent duplicates
      // Use mutex lock to prevent race conditions between concurrent settlement attempts
      if (toStatus === RaceStatus.SETTLED) {
        // Atomic check-and-lock pattern to prevent duplicates
        if (this.emissionLock.has(race.id)) {
          console.log(`🔒 Race ${race.id} settlement emission already in progress, skipping duplicate`);
          return;
        }
        if (this.settledEventsEmitted.has(race.id)) {
          console.log(`⏭️  Skipping duplicate race_settled event for race ${race.id}`);
          return;
        }
        
        // Acquire lock immediately to block concurrent attempts
        this.emissionLock.add(race.id);
        
        // Double-check after acquiring lock (in case of race condition)
        if (this.settledEventsEmitted.has(race.id)) {
          console.log(`⏭️  Race ${race.id} was settled by concurrent process, releasing lock`);
          this.emissionLock.delete(race.id);
          return;
        }
        
        // Mark as emitted
        this.settledEventsEmitted.add(race.id);
        console.log(`📡 Emitting race_settled event for race ${race.id}`);
      }
      
      raceEvents.emit(eventName, race);
      
      // Release lock after emission
      if (toStatus === RaceStatus.SETTLED) {
        this.emissionLock.delete(race.id);
      }
      
      // Log for non-settled events
      if (toStatus !== RaceStatus.SETTLED) {
        console.log(`📡 Emitted ${eventName} event for race ${race.id}`);
      }
    }
  }

  /**
   * Reconcile race status based on timestamps
   */
  static async reconcileRace(race: Race): Promise<Race | null> {
    const expectedStatus = await this.getExpectedStatus(race);
    
    if (expectedStatus !== race.status) {
      console.log(`🔧 Reconciling race ${race.id}: ${race.status} → ${expectedStatus}`);
      
      try {
        return await this.transitionRace(race.id, expectedStatus, "reconciliation");
      } catch (error) {
        console.error(`❌ Failed to reconcile race ${race.id}:`, error);
        return null;
      }
    }
    
    return race;
  }

  /**
   * Get race timing information
   */
  static async getRaceTiming(race: Race): Promise<{
    status: RaceStatus;
    timeUntilNextTransition: number;
    nextTransition: string;
    progress: number;
    uiTimeUntilNextTransition?: number; // client-facing countdown that ignores blockers
    uiLabel?: string;
    // Absolute timestamps to eliminate client-side jitter
    targetTs?: number; // scheduler-aware absolute target when transition is expected
    uiTargetTs?: number; // UI-facing absolute target (ignores blockers)
  }> {
    const now = approxNowMs();
    const raceAge = now - race.startTs;
    const lockedAge = race.lockedTs ? now - race.lockedTs : 0;
    
    let timeUntilNextTransition = 0;
    let nextTransition = "";
    let progress = 0;
    let targetTs: number | undefined;
    let uiTargetTs: number | undefined;
    let isBlockedByOtherActiveRace = false;

    switch (race.status) {
      case RaceStatus.OPEN:
        {
          const baseWait = Math.max(0, this.OPEN_DURATION_MS - raceAge);
          // If another race is already LOCKED/IN_PROGRESS, extend wait to after it settles
          const others = (await getDb().getRaces()).filter(r => r.id !== race.id);
          const blocker = others.find(r => r.status === RaceStatus.LOCKED || r.status === RaceStatus.IN_PROGRESS);
          if (blocker) {
            isBlockedByOtherActiveRace = true;
            let extraWait = 0;
            if (blocker.status === RaceStatus.IN_PROGRESS && blocker.lockedTs) {
              const blockerLockedAge = now - blocker.lockedTs;
              extraWait = Math.max(0, this.PROGRESS_DURATION_MS - blockerLockedAge);
            } else {
              // LOCKED: small delay to go live + full progress window
              extraWait = 2000 + this.PROGRESS_DURATION_MS;
            }
            timeUntilNextTransition = baseWait > 0 ? baseWait + extraWait : extraWait;
          } else {
            timeUntilNextTransition = baseWait;
          }
        }
        nextTransition = "LOCKED";
        progress = Math.min(100, (raceAge / this.OPEN_DURATION_MS) * 100);
        // UI target should NEVER be earlier than the scheduler target.
        // If this race is blocked by an active LOCKED/IN_PROGRESS race, the scheduler
        // extends timeUntilNextTransition. Use the later of the two for UI so we
        // never display 00:00 while still waiting for the blocker to finish.
        const uiBaseRemaining = Math.max(0, this.OPEN_DURATION_MS - raceAge);
        const uiBaseTargetTs = race.startTs + this.OPEN_DURATION_MS;
        // Absolute targets
        targetTs = now + timeUntilNextTransition; // includes blocker wait when present
        uiTargetTs = Math.max(uiBaseTargetTs, targetTs);
        const uiRemaining = Math.max(uiBaseRemaining, timeUntilNextTransition);
        const divergence = Math.abs((targetTs - uiBaseTargetTs));
        if (divergence > 2 * 60 * 1000) {
          console.log(`⚠️ Timing divergence for ${race.id} (OPEN): scheduler=${Math.round(timeUntilNextTransition/1000)}s uiBase=${Math.round(uiBaseRemaining/1000)}s (blocked)`);
        }
        return {
          status: race.status,
          timeUntilNextTransition,
          nextTransition,
          progress,
          uiTimeUntilNextTransition: uiRemaining,
          // Always show betting countdown label even if scheduler is blocked by another race
          // We already extend uiTargetTs/uiTimeUntilNextTransition when blocked, so users
          // still see a correct non-zero countdown without confusing messaging.
          uiLabel: "Betting closes in",
          targetTs,
          uiTargetTs
        };
        
        
      case RaceStatus.LOCKED:
        timeUntilNextTransition = Math.max(0, 2000 - lockedAge);
        nextTransition = "IN_PROGRESS";
        progress = Math.min(100, (lockedAge / 2000) * 100);
        targetTs = (race.lockedTs || now) + 2000;
        break;
        
      case RaceStatus.IN_PROGRESS:
        timeUntilNextTransition = Math.max(0, this.PROGRESS_DURATION_MS - lockedAge);
        nextTransition = "SETTLED";
        progress = Math.min(100, (lockedAge / this.PROGRESS_DURATION_MS) * 100);
        targetTs = (race.lockedTs || now) + this.PROGRESS_DURATION_MS;
        break;
        
      default:
        progress = 100;
        break;
    }

    return {
      status: race.status,
      timeUntilNextTransition,
      nextTransition,
      progress,
      targetTs,
      uiTargetTs: uiTargetTs,
      uiLabel: race.status === RaceStatus.LOCKED
        ? "Going live…"
        : race.status === RaceStatus.IN_PROGRESS
          ? "Settles in"
          : undefined
    };
  }
}