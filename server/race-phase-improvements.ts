import { Race, RaceStatus } from "@shared/schema";
import { getDb } from "./db";
import { RaceStateMachine } from "./race-state-machine";
import { RaceTimer } from "./race-timer";
import { raceEvents } from "./sse";
import { approxNowMs } from "./chain-time";

/**
 * Enhanced race phase management with improved stuck race handling
 */
export class RacePhaseManager {
  private static readonly STUCK_THRESHOLD_MS = 60000; // 1 minute past expected transition
  private static readonly MAX_RETRY_ATTEMPTS = 3;
  private static retryAttempts = new Map<string, number>();

  /**
   * Comprehensive race health check and recovery
   */
  static async performHealthCheck(): Promise<{ 
    fixed: number; 
    failed: number; 
    details: Array<{ raceId: string; issue: string; action: string }> 
  }> {
    const results = {
      fixed: 0,
      failed: 0,
      details: [] as Array<{ raceId: string; issue: string; action: string }>
    };

    const allRaces = await getDb().getRaces();
    const now = approxNowMs();

    for (const race of allRaces) {
      if (race.status === RaceStatus.SETTLED || race.status === RaceStatus.CANCELLED) {
        continue; // Skip terminal states
      }

      try {
        const issue = await this.diagnoseRaceIssue(race, now);
        if (issue) {
          const action = await this.attemptRecovery(race, issue);
          results.details.push({ raceId: race.id, issue, action });
          
          if (action.includes("Fixed") || action.includes("Transitioned")) {
            results.fixed++;
          } else {
            results.failed++;
          }
        }
      } catch (error) {
        console.error(`Health check failed for race ${race.id}:`, error);
        results.failed++;
        results.details.push({
          raceId: race.id,
          issue: "Health check error",
          action: `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
    }

    return results;
  }

  /**
   * Diagnose potential issues with a race
   */
  private static async diagnoseRaceIssue(race: Race, now: number): Promise<string | null> {
    const timing = await RaceStateMachine.getRaceTiming(race);
    const expectedStatus = await RaceStateMachine.getExpectedStatus(race);

    // Issue 1: Race stuck at "00:00" timer
    if (race.status === RaceStatus.OPEN && timing.timeUntilNextTransition <= 0) {
      // Check if another race is blocking
      const otherRaces = (await getDb().getRaces()).filter(r => r.id !== race.id);
      const hasBlocker = otherRaces.some(r => 
        r.status === RaceStatus.LOCKED || r.status === RaceStatus.IN_PROGRESS
      );
      
      if (hasBlocker) {
        return "Blocked by another active race";
      } else {
        const absoluteTarget = timing.targetTs ?? (race.startTs + (RaceStateMachine as any).OPEN_DURATION_MS);
        const overdue = now - absoluteTarget;
        if (overdue > this.STUCK_THRESHOLD_MS) {
          return "Stuck at OPEN with expired timer";
        }
      }
    }

    // Issue 2: Race should have transitioned
    {
      const absoluteTarget = timing.targetTs ?? (
        race.status === RaceStatus.OPEN ? (race.startTs + (RaceStateMachine as any).OPEN_DURATION_MS) :
        race.status === RaceStatus.LOCKED ? ((race.lockedTs || 0) + 2000) :
        race.status === RaceStatus.IN_PROGRESS ? ((race.lockedTs || 0) + (RaceStateMachine as any).PROGRESS_DURATION_MS) :
        undefined
      );
      const overdue = absoluteTarget !== undefined ? (now - absoluteTarget) : 0;
      if (expectedStatus !== race.status && overdue > this.STUCK_THRESHOLD_MS) {
        return `Should be ${expectedStatus} but stuck at ${race.status}`;
      }
    }

    // Issue 3: LOCKED race not progressing
    if (race.status === RaceStatus.LOCKED && race.lockedTs) {
      const lockedAge = now - race.lockedTs;
      if (lockedAge > 10000) { // More than 10 seconds in LOCKED
        return "Stuck in LOCKED state";
      }
    }

    // Issue 4: IN_PROGRESS race exceeded duration
    if (race.status === RaceStatus.IN_PROGRESS && race.lockedTs) {
      const progressDuration = Number(process.env.PROGRESS_WINDOW_MINUTES ?? "20") * 60 * 1000;
      const lockedAge = now - race.lockedTs;
      if (lockedAge > progressDuration + this.STUCK_THRESHOLD_MS) {
        return "Exceeded IN_PROGRESS duration";
      }
    }

    return null;
  }

  /**
   * Attempt to recover a race with issues
   */
  private static async attemptRecovery(race: Race, issue: string): Promise<string> {
    const attempts = this.retryAttempts.get(race.id) || 0;
    
    if (attempts >= this.MAX_RETRY_ATTEMPTS) {
      // Last resort: cancel the race
      try {
        await RaceStateMachine.transitionRace(race.id, RaceStatus.CANCELLED, "max_retries_exceeded");
        this.retryAttempts.delete(race.id);
        return "Cancelled after max retries";
      } catch (error) {
        return `Failed to cancel: ${error instanceof Error ? error.message : 'Unknown'}`;
      }
    }

    this.retryAttempts.set(race.id, attempts + 1);

    try {
      const expectedStatus = await RaceStateMachine.getExpectedStatus(race);
      
      if (issue.includes("Blocked by another active race") && race.status === RaceStatus.OPEN) {
        // Just wait, but reset timer to avoid stuck UI
        RaceTimer.setupRaceTimer(race);
        return "Reset timer, waiting for blocker to complete";
      }
      
      if (expectedStatus !== race.status) {
        // Force transition to expected state
        const updatedRace = await RaceStateMachine.transitionRace(
          race.id, 
          expectedStatus, 
          `recovery_${issue.toLowerCase().replace(/\s+/g, '_')}`
        );
        RaceTimer.setupRaceTimer(updatedRace);
        return `Transitioned to ${expectedStatus}`;
      }

      // If race is truly stuck, try a direct transition
      if (race.status === RaceStatus.LOCKED) {
        const updatedRace = await RaceStateMachine.transitionRace(
          race.id,
          RaceStatus.IN_PROGRESS,
          "recovery_stuck_locked"
        );
        RaceTimer.setupRaceTimer(updatedRace);
        return "Fixed stuck LOCKED → IN_PROGRESS";
      }

      return "No action taken";
    } catch (error) {
      return `Recovery failed: ${error instanceof Error ? error.message : 'Unknown'}`;
    }
  }

  /**
   * Force clear all stuck races (emergency use only)
   */
  static async emergencyClearStuckRaces(): Promise<number> {
    const races = await getDb().getRaces();
    let cleared = 0;

    for (const race of races) {
      if (race.status !== RaceStatus.SETTLED && race.status !== RaceStatus.CANCELLED) {
        try {
          await RaceStateMachine.transitionRace(race.id, RaceStatus.CANCELLED, "emergency_clear");
          RaceTimer.clearRaceTimer(race.id);
          cleared++;
        } catch (error) {
          console.error(`Failed to clear race ${race.id}:`, error);
        }
      }
    }

    this.retryAttempts.clear();
    return cleared;
  }

  /**
   * Optimize race scheduling to prevent stuck races
   */
  static async optimizeScheduling(): Promise<void> {
    const activeRaces = (await getDb().getRaces()).filter(r => 
      r.status === RaceStatus.OPEN || 
      r.status === RaceStatus.LOCKED || 
      r.status === RaceStatus.IN_PROGRESS
    );

    // Ensure proper timer setup for all active races
    for (const race of activeRaces) {
      RaceTimer.setupRaceTimer(race);
    }

    // Emit updated countdown for OPEN races to fix stuck UI
    const openRaces = activeRaces.filter(r => r.status === RaceStatus.OPEN);
    for (const race of openRaces) {
      const timing = await RaceStateMachine.getRaceTiming(race);
      raceEvents.emit("countdown_update", {
        raceId: race.id,
        status: race.status,
        timeRemaining: Math.max(0, timing.uiTimeUntilNextTransition || timing.timeUntilNextTransition),
        targetTs: timing.uiTargetTs || timing.targetTs,
        label: timing.uiLabel || "Betting closes in"
      });
    }
  }

  /**
   * Monitor and log race phase transitions
   */
  static enableDetailedLogging(): void {
    // Enhanced logging for debugging phase issues
    const originalTransition = RaceStateMachine.transitionRace;
    RaceStateMachine.transitionRace = async function(raceId: string, targetStatus: RaceStatus, reason: string) {
      console.log(`📊 Phase Transition Request: ${raceId}`);
      console.log(`   Current → Target: ? → ${targetStatus}`);
      console.log(`   Reason: ${reason}`);
      console.log(`   Timestamp: ${new Date().toISOString()}`);
      
      try {
        const result = await originalTransition.call(RaceStateMachine, raceId, targetStatus, reason);
        console.log(`✅ Transition successful for ${raceId}`);
        return result;
      } catch (error) {
        console.error(`❌ Transition failed for ${raceId}:`, error);
        throw error;
      }
    };
  }
}

// Export for use in server initialization
export async function improveRacePhaseSystem(): Promise<void> {
  console.log("🚀 Initializing improved race phase system...");
  
  // Enable detailed logging in development
  if (process.env.NODE_ENV !== 'production') {
    RacePhaseManager.enableDetailedLogging();
  }

  // Perform initial health check
  const healthCheck = await RacePhaseManager.performHealthCheck();
  if (healthCheck.fixed > 0 || healthCheck.failed > 0) {
    console.log(`🏥 Health check results: ${healthCheck.fixed} fixed, ${healthCheck.failed} failed`);
    healthCheck.details.forEach(d => 
      console.log(`   ${d.raceId}: ${d.issue} → ${d.action}`)
    );
  }

  // Optimize scheduling
  await RacePhaseManager.optimizeScheduling();

  // Set up periodic health checks
  setInterval(async () => {
    try {
      const results = await RacePhaseManager.performHealthCheck();
      if (results.fixed > 0 || results.failed > 0) {
        console.log(`🏥 Periodic health check: ${results.fixed} fixed, ${results.failed} failed`);
      }
    } catch (error) {
      console.error("Periodic health check failed:", error);
    }
  }, 30000); // Every 30 seconds

  console.log("✅ Improved race phase system initialized");
}