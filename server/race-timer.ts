import { Race, RaceStatus } from "@shared/schema";
import { getDb } from "./db";
import { RaceStateMachine } from "./race-state-machine";
import { raceEvents } from "./sse";
import { chainTime } from "./chain-time";

// Race timer system with precise scheduling and error recovery
export class RaceTimer {
  private static readonly CHECK_INTERVAL_MS = 2000; // Check every 2 seconds
  private static readonly WATCHDOG_INTERVAL_MS = 10000; // Watchdog every 10 seconds
  private static readonly PRICE_UPDATE_INTERVAL_MS = 10000; // Backstop: 10s periodic update (reduced frequency)
  private static readonly FAST_MIN_INTERVAL_MS = Number((globalThis as any).process?.env?.FAST_PRICE_MIN_INTERVAL_MS ?? 5000);
  
  private static timers = new Map<string, ReturnType<typeof setTimeout>>();
  private static priceUpdateTimers = new Map<string, ReturnType<typeof setInterval>>();
  private static isRunning = false;
  private static lastFastUpdateAt = 0;
  private static slotSubId: number | null = null;
  private static fastUpdateInFlight = false;
  private static slotManagerTimer: ReturnType<typeof setInterval> | null = null;
  // Track races we've already attempted to pre-seed during OPEN phase
  private static attemptedOpenSeed = new Set<string>();

  /**
   * Start the race timer system
   */
  static start(): void {
    if (this.isRunning) {
      console.log("⏰ Race timer system already running");
      return;
    }

    console.log("🚀 Starting race timer system...");
    this.isRunning = true;

    // Start main checker
    this.startMainChecker();
    
    // Start watchdog
    this.startWatchdog();
    
    // Start price updater
    this.startPriceUpdater();

    // Start slot-change accelerator manager (env-gated)
    this.startSlotAccelerator();
    
    // Initialize existing races
    this.initializeExistingRaces();
    
    console.log("✅ Race timer system started");
  }

  /**
   * Stop the race timer system
   */
  static async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log("🛑 Stopping race timer system...");
    this.isRunning = false;

    // Clear all timers
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
    
    this.priceUpdateTimers.forEach(timer => clearInterval(timer));
    this.priceUpdateTimers.clear();
    // Stop slot manager interval
    if (this.slotManagerTimer) {
      clearInterval(this.slotManagerTimer);
      this.slotManagerTimer = null;
    }
    // Unsubscribe slot listener
    if (this.slotSubId !== null) {
      try {
        const { connection } = await import('./solana');
        await connection.removeSlotChangeListener(this.slotSubId);
      } catch {}
      this.slotSubId = null;
    }
    
    console.log("✅ Race timer system stopped");
  }

  /**
   * Start main race checker
   */
  private static startMainChecker(): void {
    const checkRaces = async () => {
      if (!this.isRunning) return;
      
      try {
        await this.checkAndTransitionRaces();
      } catch (error) {
        console.error("❌ Error in main race checker:", error);
      }
      
      // Schedule next check
      setTimeout(checkRaces, this.CHECK_INTERVAL_MS);
    };
    
    checkRaces();
  }

  /**
   * Start watchdog for stuck races
   */
  private static startWatchdog(): void {
    const watchdog = async () => {
      if (!this.isRunning) return;
      
      try {
        await this.watchdogCheck();
      } catch (error) {
        console.error("❌ Error in watchdog:", error);
      }
      
      // Schedule next watchdog check
      setTimeout(watchdog, this.WATCHDOG_INTERVAL_MS);
    };
    
    watchdog();
  }

  /**
   * Start price updater
   */
  private static startPriceUpdater(): void {
    const updatePrices = async () => {
      if (!this.isRunning) return;
      
      try {
        await this.updateRacePrices();
      } catch (error) {
        console.error("❌ Error in price updater:", error);
      }
      
      // Schedule next price update
      setTimeout(updatePrices, this.PRICE_UPDATE_INTERVAL_MS);
    };
    
    updatePrices();
  }

  /**
   * Accelerate price updates by triggering on slot changes (QuickNode WS)
   */
  private static async startSlotAccelerator(): Promise<void> {
    // Env gate: disabled by default to save RPC credits
    const enabledRaw = String((globalThis as any).process?.env?.ENABLE_SLOT_ACCELERATOR || '').toLowerCase();
    const enabled = enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes' || enabledRaw === 'on';
    if (!enabled) {
      console.log('⛔ Slot accelerator disabled (set ENABLE_SLOT_ACCELERATOR=true to enable)');
      return;
    }

    const evalMs = Number((globalThis as any).process?.env?.SLOT_ACCELERATOR_EVAL_MS ?? 10000);

    const ensureSubscriptionState = async () => {
      if (!this.isRunning) return;
      try {
        // Only subscribe during live pricing windows to avoid constant slot notifications
        const liveNeeded = (await getDb().getRaces()).some(r => r.status === RaceStatus.LOCKED || r.status === RaceStatus.IN_PROGRESS);
        const { connection } = await import('./solana');

        if (liveNeeded && this.slotSubId === null) {
          try {
            this.slotSubId = await connection.onSlotChange(async () => {
              if (!this.isRunning) return;
              const now = Date.now();
              if (now - this.lastFastUpdateAt < this.FAST_MIN_INTERVAL_MS) return;
              if (this.fastUpdateInFlight) return;
              this.fastUpdateInFlight = true;
              try {
                await this.updateRacePrices(true);
                this.lastFastUpdateAt = Date.now();
              } catch {
              } finally {
                this.fastUpdateInFlight = false;
              }
            });
            console.log('⚡ Slot accelerator subscribed (active live race)');
          } catch (e) {
            console.warn('Slot accelerator subscribe failed; continuing without WS.', e);
          }
        } else if (!liveNeeded && this.slotSubId !== null) {
          try {
            await connection.removeSlotChangeListener(this.slotSubId);
            this.slotSubId = null;
            console.log('🛑 Slot accelerator unsubscribed (no live races)');
          } catch {}
        }
      } catch (e) {
        console.warn('Slot accelerator manager error:', e);
      }
    };

    // Run immediately and then periodically
    await ensureSubscriptionState();
    if (this.slotManagerTimer) clearInterval(this.slotManagerTimer);
    this.slotManagerTimer = setInterval(() => { ensureSubscriptionState().catch(() => {}); }, evalMs);
  }

  /**
   * Initialize existing races
   */
  private static async initializeExistingRaces(): Promise<void> {
    console.log("🔄 Initializing existing races...");
    
    const allRaces = await getDb().getRaces();
    let initializedCount = 0;
    
    for (const race of allRaces) {
      try {
        // Reconcile race status
        const reconciledRace = await RaceStateMachine.reconcileRace(race);
        if (reconciledRace && reconciledRace.status !== race.status) {
          initializedCount++;
        }
        // Ensure treasury pre-seed bets exist during OPEN so users see coverage
        try {
          const active = reconciledRace || race;
          if (active.status === RaceStatus.OPEN) {
            await this.ensureOpenPhaseHouseSeed(active);
          }
        } catch (e) {
          console.warn(`⚠️ Failed OPEN pre-seed for race ${race.id} during init`, e);
        }
        
        // Set up individual timers for active races
        if (this.isActiveRace(reconciledRace || race)) {
          this.setupRaceTimer(reconciledRace || race);
        }
      } catch (error) {
        console.error(`❌ Failed to initialize race ${race.id}:`, error);
      }
    }
    
    console.log(`✅ Initialized ${initializedCount} races`);
  }

  /**
   * Check and transition races
   */
  private static async checkAndTransitionRaces(): Promise<void> {
    const treasury = await getDb().getTreasury();
    const maintenance = (treasury as any).maintenanceMode;
    const anchorId = (treasury as any).maintenanceAnchorRaceId;
    const activeRaces = (await getDb().getRaces()).filter(race => this.isActiveRace(race));
    
    for (const race of activeRaces) {
      try {
        // Opportunistically ensure pre-seed exists while race is OPEN
        if (race.status === RaceStatus.OPEN) {
          try { await this.ensureOpenPhaseHouseSeed(race); } catch {}
        }
        const timing = await RaceStateMachine.getRaceTiming(race);
        
        // Check if transition is needed
        if (timing.timeUntilNextTransition <= 0) {
          const expectedStatus = await RaceStateMachine.getExpectedStatus(race);
          
          // During maintenance, only the anchored OPEN race is allowed to progress
          if (maintenance && race.status === RaceStatus.OPEN) {
            try {
              if (anchorId) {
                if (race.id !== anchorId) continue;
              } else {
                const open = await getDb().getRaces(RaceStatus.OPEN as any);
                const earliestOpen = open[0];
                if (!earliestOpen || earliestOpen.id !== race.id) continue;
              }
            } catch {
              continue;
            }
          }

          if (expectedStatus !== race.status) {
            console.log(`⏰ Time-based transition for race ${race.id}: ${race.status} → ${expectedStatus}`);
            
            try {
              await RaceStateMachine.transitionRace(race.id, expectedStatus, "timer");
              
              // Set up timer for next transition
              this.setupRaceTimer(await getDb().getRace(race.id)!);
            } catch (error) {
              console.error(`❌ Failed to transition race ${race.id}:`, error);
              // As a safety during maintenance, if an OPEN race should lock but failed due to
              // transient snapshot issues, attempt a direct lock once.
              try {
                if (maintenance && race.status === RaceStatus.OPEN && expectedStatus === RaceStatus.LOCKED) {
                  await RaceStateMachine.transitionRace(race.id, RaceStatus.LOCKED, "timer_fallback");
                  this.setupRaceTimer(await getDb().getRace(race.id)!);
                }
              } catch (e) {
                console.error(`❌ Fallback lock failed for race ${race.id}:`, e);
              }
            }
          }
        }
      } catch (error) {
        console.error(`❌ Error checking race ${race.id}:`, error);
      }
    }
  }

  /**
   * Watchdog check for stuck races
   */
  private static async watchdogCheck(): Promise<void> {
    const allRaces = await getDb().getRaces();
    const now = Date.now();
    
    for (const race of allRaces) {
      try {
        const timing = await RaceStateMachine.getRaceTiming(race);
        const expectedStatus = await RaceStateMachine.getExpectedStatus(race);
        
        // Check for stuck races (grace period exceeded) using absolute targets for accuracy
        const gracePeriod = 30000; // 30 seconds grace period
        // Be resilient to missing lockedTs by falling back to inProgressTs/startTs
        const effectiveLockedTs = race.lockedTs || (race as any).inProgressTs || race.startTs;
        const absoluteTarget = timing.targetTs ?? (race.status === RaceStatus.OPEN
          ? (race.startTs + (RaceStateMachine as any).OPEN_DURATION_MS)
          : race.status === RaceStatus.LOCKED
            ? ((effectiveLockedTs || 0) + 2000)
            : race.status === RaceStatus.IN_PROGRESS
              ? ((effectiveLockedTs || 0) + (RaceStateMachine as any).PROGRESS_DURATION_MS)
              : undefined);
        const overdueMs = (absoluteTarget !== undefined) ? (now - absoluteTarget) : 0;
        const isStuck = overdueMs > gracePeriod && expectedStatus !== race.status;
        
        if (isStuck) {
          console.log(`🚨 Watchdog: Race ${race.id} is stuck (${race.status}, expected ${expectedStatus})`);
          
          try {
            await RaceStateMachine.transitionRace(race.id, expectedStatus, "watchdog");
            this.setupRaceTimer(await getDb().getRace(race.id)!);
          } catch (error) {
            console.error(`❌ Watchdog failed to fix race ${race.id}:`, error);
          }
        }
      } catch (error) {
        console.error(`❌ Watchdog error for race ${race.id}:`, error);
      }
    }
  }

  /**
   * Update race prices
   */
  private static async updateRacePrices(fast: boolean = false): Promise<void> {
    const treasury = await getDb().getTreasury();
    const maintenance = (treasury as any).maintenanceMode;
    const activeRaces = (await getDb().getRaces()).filter(race => 
      race.status === RaceStatus.OPEN || 
      race.status === RaceStatus.LOCKED || 
      race.status === RaceStatus.IN_PROGRESS
    );
    
    if (activeRaces.length === 0) return;
    // Allow price updates for LOCKED/IN_PROGRESS; during maintenance skip OPEN to reduce churn
    const racesToUpdate = maintenance ? activeRaces.filter(r => r.status !== RaceStatus.OPEN) : activeRaces;
    if (racesToUpdate.length === 0) return;
    
    try {
      const { getLivePrices } = await import("./runners");
      
      for (const race of racesToUpdate) {
        try {
          const raceRunners = race.runners.map((runner: any) => ({
            mint: runner.mint,
            poolAddress: runner.poolAddress
          }));
          
          const currentPrices = await getLivePrices(raceRunners, { priority: fast ? 'high' : 'low', force: fast || race.status !== RaceStatus.OPEN });
          
          // Update runner prices
          const updatedRunners = race.runners.map((runner: any) => {
            const priceData = currentPrices.find(p => p.mint === runner.mint);
            if (!priceData) return runner;
            
            const newPrice = priceData.price;
            const baselinePrice = runner.initialPriceUsd || runner.initialPrice || newPrice;
            const priceChange = baselinePrice > 0 ? ((newPrice - baselinePrice) / baselinePrice) * 100 : 0;
            
            return {
              ...runner,
              currentPrice: newPrice,
              priceChange
            };
          });
          
          // Update race in database
          const updatedRace = { ...race, runners: updatedRunners };
          await getDb().updateRace(updatedRace);
          
          // Broadcast update (fast path uses same channel)
          raceEvents.emit("race_updated", {
            raceId: race.id,
            runners: updatedRunners,
            timestamp: Date.now()
          });
          
        } catch (error) {
          console.error(`❌ Failed to update prices for race ${race.id}:`, error);
        }
      }
    } catch (error) {
      console.error("❌ Price update failed:", error);
    }
  }

  /**
   * Set up individual timer for a race
   */
  static async setupRaceTimer(race: Race): Promise<void> {
    // Clear existing timer
    const existingTimer = this.timers.get(race.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const timing = await RaceStateMachine.getRaceTiming(race);
    
    if (timing.timeUntilNextTransition > 0) {
      const timer = setTimeout(async () => {
        try {
          const expectedStatus = await RaceStateMachine.getExpectedStatus(race);
          if (expectedStatus !== race.status) {
            await RaceStateMachine.transitionRace(race.id, expectedStatus, "scheduled");
            this.setupRaceTimer(await getDb().getRace(race.id)!);
          }
        } catch (error) {
          console.error(`❌ Scheduled transition failed for race ${race.id}:`, error);
        }
      }, timing.timeUntilNextTransition);
      
      this.timers.set(race.id, timer);
      console.log(`⏰ Set timer for race ${race.id}: ${timing.nextTransition} in ${timing.timeUntilNextTransition}ms`);
    }
  }

  /**
   * Idempotently seed treasury bets during OPEN phase so the UI shows
   * existing bettors early. Safe to call repeatedly; it checks DB first.
   */
  private static async ensureOpenPhaseHouseSeed(race: Race): Promise<void> {
    if (this.attemptedOpenSeed.has(race.id)) return;
    try {
      const existing = await getDb().getBetsForRace(race.id) || [];
      const houseSol = existing.filter(b => ((b as any).clientId === 'HOUSE_SEED' || (b as any).memo === 'HOUSE_SEED') && ((b as any).currency || 'RACE') === 'SOL');
      const ENABLE_RACE = String(process.env.ENABLE_RACE_BETS || '').toLowerCase();
      const allowRace = ENABLE_RACE === '1' || ENABLE_RACE === 'true';
      const houseRace = allowRace ? existing.filter(b => ((b as any).clientId === 'HOUSE_SEED' || (b as any).memo === 'HOUSE_SEED') && ((b as any).currency || 'RACE') !== 'SOL') : [];
      // If both currencies are already fully seeded for all runners, skip
      if (houseSol.length >= race.runners.length && houseRace.length >= race.runners.length) {
        this.attemptedOpenSeed.add(race.id);
        return;
      }
      const { seedHouseBetsForRace } = await import('./house-seed');
      const seededSol = await seedHouseBetsForRace(race, undefined, 'SOL');
      const seededRace = allowRace ? await seedHouseBetsForRace(race, undefined, 'RACE') : { created: 0 } as any;
      console.log(`🏦 [HOUSE_SEED][open] Created SOL ${seededSol.created}/${race.runners.length}${allowRace ? `, RACE ${seededRace.created}/${race.runners.length}` : ''} seed bets for ${race.id}`);
    } catch (e) {
      console.warn(`⚠️ [HOUSE_SEED][open] Pre-seed attempt failed for ${race.id}`, e);
    } finally {
      // Mark as attempted; duplicates are prevented inside seeding logic
      this.attemptedOpenSeed.add(race.id);
    }
  }

  /**
   * Check if race is active (not terminal)
   */
  private static isActiveRace(race: Race): boolean {
    return race.status === RaceStatus.OPEN || 
           race.status === RaceStatus.LOCKED || 
           race.status === RaceStatus.IN_PROGRESS;
  }

  /**
   * Get timer statistics
   */
  static async getStats(): Promise<{
    isRunning: boolean;
    activeTimers: number;
    activeRaces: number;
    races: Array<{
      id: string;
      status: RaceStatus;
      timing: ReturnType<typeof RaceStateMachine.getRaceTiming>;
    }>;
  }> {
    const allRaces = await getDb().getRaces();
    const activeRaces = allRaces.filter(race => this.isActiveRace(race));
    
    return {
      isRunning: this.isRunning,
      activeTimers: this.timers.size,
      activeRaces: activeRaces.length,
      races: await Promise.all(allRaces.map(async race => ({
        id: race.id,
        status: race.status,
        timing: await RaceStateMachine.getRaceTiming(race)
      })))
    };
  }

  /**
   * Force transition for a specific race
   */
  static async forceTransition(raceId: string, targetStatus: RaceStatus): Promise<Race> {
    console.log(`🔧 Force transitioning race ${raceId} to ${targetStatus}`);
    
    const race = await RaceStateMachine.transitionRace(raceId, targetStatus, "manual");
    
    // Set up new timer
    this.setupRaceTimer(race);
    
    return race;
  }

  /**
   * Clear timer for a race
   */
  static clearRaceTimer(raceId: string): void {
    const timer = this.timers.get(raceId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(raceId);
      console.log(`🗑️ Cleared timer for race ${raceId}`);
    }
  }
}