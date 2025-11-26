import { connection } from "./solana";

/**
 * On-chain time provider with drift-corrected local clock and RPC rate limiting.
 *
 * - Periodically samples Solana mainnet block time and computes drift vs Date.now().
 * - Exposes nowMs() which returns Date.now() + drift to avoid frequent RPC calls.
 * - Falls back gracefully to local time if RPC fails.
 */
class ChainTimeProvider {
  private lastSampledAtMs: number = 0;
  private driftMs: number = 0;
  private lastObservedSlot: number = 0;
  private lastObservedBlockTimeMs: number = 0;

  // Configurable via env
  private readonly refreshIntervalMs: number = Number(process.env.ONCHAIN_TIME_REFRESH_MS ?? "30000");
  private readonly minIntervalMs: number = Number(process.env.SOLANA_RPC_MIN_INTERVAL_MS ?? "1500");

  private pendingSample: Promise<void> | null = null;

  async ensureSampleFresh(): Promise<void> {
    const now = Date.now();
    const timeSinceLast = now - this.lastSampledAtMs;

    if (timeSinceLast < Math.max(this.minIntervalMs, this.refreshIntervalMs)) {
      return;
    }

    if (this.pendingSample) {
      return this.pendingSample;
    }

    this.pendingSample = (async () => {
      try {
        // Get latest slot and its block time
        const slot = await connection.getSlot("confirmed");
        const blockTimeSec = await connection.getBlockTime(slot);

        if (blockTimeSec && blockTimeSec > 0) {
          const blockTimeMs = blockTimeSec * 1000;
          const localNow = Date.now();
          this.driftMs = blockTimeMs - localNow;
          this.lastObservedSlot = slot;
          this.lastObservedBlockTimeMs = blockTimeMs;
          this.lastSampledAtMs = localNow;
        } else {
          // No block time available; keep previous drift
          this.lastSampledAtMs = now;
        }
      } catch {
        // Swallow errors to keep system resilient; keep last drift
        this.lastSampledAtMs = now;
      } finally {
        this.pendingSample = null;
      }
    })();

    return this.pendingSample;
  }

  async nowMs(): Promise<number> {
    await this.ensureSampleFresh();
    return Date.now() + this.driftMs;
  }

  getSnapshot() {
    return {
      lastObservedSlot: this.lastObservedSlot,
      lastObservedBlockTimeMs: this.lastObservedBlockTimeMs,
      driftMs: this.driftMs,
      lastSampledAtMs: this.lastSampledAtMs,
      refreshIntervalMs: this.refreshIntervalMs
    };
  }
}

export const chainTime = new ChainTimeProvider();

export async function nowMs(): Promise<number> {
  return chainTime.nowMs();
}

// Non-blocking, no-RPC approximation using last known drift
export function approxNowMs(): number {
  return Date.now() + (chainTime as any).driftMs;
}

