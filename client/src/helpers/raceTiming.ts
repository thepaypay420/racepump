// src/helpers/raceTiming.ts
export function getCountdownTargetAndLabel(race: any) {
  // Prefer server-provided UI timing if available to guarantee consistent card countdowns
  if (race?.timing) {
    // Use absolute timestamps first to avoid jitter. Choose the later target to
    // guarantee UI never counts to 0 while the scheduler still waits (e.g., blocked OPEN).
    const uiTargetTs = typeof race.timing.uiTargetTs === 'number' ? race.timing.uiTargetTs : undefined;
    const targetTs = typeof race.timing.targetTs === 'number' ? race.timing.targetTs : undefined;
    if (uiTargetTs || targetTs) {
      const label = race.timing.uiLabel || ({
        LOCKED: "Betting closes in",
        IN_PROGRESS: "Going live…",
        SETTLED: "Settles in"
      } as Record<string, string>)[race.timing.nextTransition] || "Time remaining";
      const chosen = Math.max(uiTargetTs || 0, targetTs || 0);
      const now = Date.now();
      const status = race.computedStatus ?? race.status;
      // If absolute targets are in the past (e.g., scheduler delay after redeploy),
      // prefer server-provided remaining time to avoid visible resets. Fallback only if
      // the server does not provide a positive remaining value.
      if (chosen <= now + 1000) {
        const relRemaining = Math.max(
          0,
          typeof race.timing.uiTimeUntilNextTransition === 'number' ? race.timing.uiTimeUntilNextTransition : 0,
          typeof race.timing.timeUntilNextTransition === 'number' ? race.timing.timeUntilNextTransition : 0
        );
        if (relRemaining > 0) {
          return { target: now + relRemaining, label };
        }
        if (status === 'OPEN') {
          return { target: now + 30 * 1000, label: "Betting closes in" };
        }
        if (status === 'LOCKED') {
          return { target: now + 2000, label: "Going live…" };
        }
        if (status === 'IN_PROGRESS') {
          const PROGRESS_MS = 20 * 60 * 1000; // mirror server default
          return { target: now + PROGRESS_MS, label: "Settles in" };
        }
      }
      return { target: chosen, label };
    }
    // Fallback to relative if absolute missing (should be rare)
    const hasUi = typeof race.timing.uiTimeUntilNextTransition === 'number';
    const hasTime = typeof race.timing.timeUntilNextTransition === 'number';
    if (hasUi || hasTime) {
      const remaining = Math.max(
        hasUi ? race.timing.uiTimeUntilNextTransition : 0,
        hasTime ? race.timing.timeUntilNextTransition : 0
      );
      
      // Handle edge case: non-positive remaining during OPEN.
      // Keep UX consistent by continuing to show the betting countdown label
      // with a short positive fallback target to avoid 00:00 flashes.
      if (remaining <= 0 && (race.status === "OPEN" || race.computedStatus === "OPEN")) {
        const now = Date.now();
        const fallbackTarget = now + 30 * 1000; // 30s minimal buffer
        return { target: fallbackTarget, label: "Betting closes in" };
      }
      
      const label = race.timing.uiLabel || ({
        LOCKED: "Betting closes in",
        IN_PROGRESS: "Going live…",
        SETTLED: "Settles in"
      } as Record<string, string>)[race.timing.nextTransition] || "Time remaining";
      const target = Date.now() + Math.max(0, remaining);
      return { target, label };
    }
  }

  // Fallback to absolute timestamp math to avoid rebase jitter when timing is absent
  // Mirror server timings: IN_PROGRESS window + 30s buffer for OPEN
  const PROGRESS_MS = 20 * 60 * 1000;
  const OPEN_MS = PROGRESS_MS + 30 * 1000;

  const status = race.computedStatus ?? race.status;

  if (status === "OPEN") {
    const startTs = Number(race.startTs || 0);
    if (startTs > 0) {
      return { target: startTs + OPEN_MS, label: "Betting closes in" };
    }
  }

  if (status === "LOCKED") {
    const lockedTs = Number(race.lockedTs || 0);
    if (lockedTs > 0) {
      return { target: lockedTs + 2000, label: "Going live…" };
    }
  }

  if (status === "IN_PROGRESS") {
    const lockedTs = Number(race.lockedTs || race.startTs || 0);
    if (lockedTs > 0) {
      return { target: lockedTs + PROGRESS_MS, label: "Settles in" };
    }
  }

  // If still nothing, no countdown info available

  return { target: 0, label: "" };
}

export function getRaceProgress(race: any): number {
  // Use progress data from server if available
  if (race.timing?.progress !== undefined) {
    return race.timing.progress;
  }
  
  // Fallback calculation
  const PROGRESS_MS = 20 * 60 * 1000;
  const OPEN_MS = PROGRESS_MS + 30 * 1000;
  const now = Date.now();
  
  if (race.status === "OPEN") {
    const elapsed = now - race.startTs;
    return Math.min(100, (elapsed / OPEN_MS) * 100);
  }
  
  if (race.status === "LOCKED") {
    const lockedElapsed = race.lockedTs ? now - race.lockedTs : 0;
    return Math.min(100, (lockedElapsed / 2000) * 100); // 2 second transition
  }
  
  if (race.status === "IN_PROGRESS") {
    const progressElapsed = race.lockedTs ? now - race.lockedTs : 0;
    return Math.min(100, (progressElapsed / PROGRESS_MS) * 100);
  }
  
  return 100; // Completed
}