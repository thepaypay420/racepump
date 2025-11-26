/**
 * Telegram State Management
 * 
 * Manages persistent state for Telegram posting:
 * - Post cooldowns and spacing
 * - Daily post counters
 * - News deduplication
 */

// Configuration from the spec
const CONFIG = {
  MIN_SPACING_MINUTES: 30,
  DAILY_NONRESULT_CAP: 12,
  REFERRAL_COOLDOWN_HOURS: 6,
  EXPLAINER_COOLDOWN_HOURS: 8,
  NEWS_DEDUPE_TTL_DAYS: 14,
  TIMEZONE: 'America/Los_Angeles'
};

/**
 * Get current date in PT timezone as YYYY-MM-DD
 */
function getCurrentDatePT(): string {
  const now = new Date();
  const ptDate = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }));
  return ptDate.toISOString().split('T')[0];
}

interface TelegramState {
  lastPostTimes: {
    referral?: number;
    explainer?: number;
    news?: number;
  };
  lastNonResultPost?: number;
  dailyNonResultCount: number;
  dailyResetDate: string; // YYYY-MM-DD in PT timezone
  deduplicatedNews: Set<string>;
}

// In-memory state (could be persisted to DB if needed)
let state: TelegramState = {
  lastPostTimes: {},
  lastNonResultPost: undefined,
  dailyNonResultCount: 0,
  dailyResetDate: getCurrentDatePT(),
  deduplicatedNews: new Set()
}

/**
 * Reset daily counter if it's a new day
 */
function checkAndResetDaily(): void {
  const today = getCurrentDatePT();
  if (state.dailyResetDate !== today) {
    console.log(`[telegram-state] New day detected (${state.dailyResetDate} → ${today}), resetting daily counter`);
    state.dailyNonResultCount = 0;
    state.dailyResetDate = today;
  }
}

/**
 * Clean old news dedupe keys (older than TTL days)
 */
function cleanOldNewsKeys(): void {
  const now = Date.now();
  const ttlMs = CONFIG.NEWS_DEDUPE_TTL_DAYS * 24 * 60 * 60 * 1000;
  
  const keysToDelete: string[] = [];
  state.deduplicatedNews.forEach(key => {
    // Keys are in format: timestamp_headline
    const timestampStr = key.split('_')[0];
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp) || (now - timestamp) > ttlMs) {
      keysToDelete.push(key);
    }
  });
  
  keysToDelete.forEach(key => state.deduplicatedNews.delete(key));
  if (keysToDelete.length > 0) {
    console.log(`[telegram-state] Cleaned ${keysToDelete.length} old news dedupe keys`);
  }
}

/**
 * Check if a news item has been posted (within TTL window)
 */
export function hasNewsBeenPosted(headline: string): boolean {
  cleanOldNewsKeys();
  
  // Check if this headline exists in any recent dedupe key
  const headlineNorm = headline.toLowerCase().trim();
  const keys = Array.from(state.deduplicatedNews);
  for (const key of keys) {
    if (key.includes(headlineNorm)) {
      return true;
    }
  }
  return false;
}

/**
 * Mark a news item as posted
 */
export function markNewsPosted(headline: string): void {
  const now = Date.now();
  const headlineNorm = headline.toLowerCase().trim();
  const key = `${now}_${headlineNorm}`;
  state.deduplicatedNews.add(key);
  console.log(`[telegram-state] Marked news as posted: ${headline.slice(0, 50)}...`);
}

/**
 * Get last post time for a specific kind
 */
export function getLastPostTime(kind: 'referral' | 'explainer' | 'news'): number | undefined {
  return state.lastPostTimes[kind];
}

/**
 * Set last post time for a specific kind
 */
export function setLastPostTime(kind: 'referral' | 'explainer' | 'news', timestamp: number): void {
  state.lastPostTimes[kind] = timestamp;
  console.log(`[telegram-state] Updated last post time for ${kind}: ${new Date(timestamp).toISOString()}`);
}

/**
 * Get last non-result post time (for spacing check)
 */
export function getLastNonResultPostTime(): number | undefined {
  return state.lastNonResultPost;
}

/**
 * Set last non-result post time and increment counter
 */
export function recordNonResultPost(timestamp: number): void {
  checkAndResetDaily();
  state.lastNonResultPost = timestamp;
  state.dailyNonResultCount++;
  console.log(`[telegram-state] Non-result post recorded. Daily count: ${state.dailyNonResultCount}/${CONFIG.DAILY_NONRESULT_CAP}`);
}

/**
 * Get current daily non-result count
 */
export function getDailyNonResultCount(): number {
  checkAndResetDaily();
  return state.dailyNonResultCount;
}

/**
 * Check if posting is allowed based on all rules
 * 
 * @param kind - Type of post
 * @param isScheduled - Whether this is a scheduled post (affects cooldown check)
 * @returns Object with allowed flag and reason if blocked
 */
export function canPost(
  kind: 'referral' | 'explainer' | 'news',
  isScheduled: boolean = false
): { allowed: boolean; reason?: string } {
  const now = Date.now();
  
  // News posts are always allowed (unlimited, no spacing/caps)
  if (kind === 'news') {
    return { allowed: true };
  }
  
  // Check daily cap for non-result posts
  checkAndResetDaily();
  if (state.dailyNonResultCount >= CONFIG.DAILY_NONRESULT_CAP) {
    return { allowed: false, reason: `daily_cap_reached (${state.dailyNonResultCount}/${CONFIG.DAILY_NONRESULT_CAP})` };
  }
  
  // Check cooldown (only for unscheduled posts - scheduled posts bypass cooldown)
  if (!isScheduled) {
    const lastTime = state.lastPostTimes[kind];
    if (lastTime) {
      const cooldownHours = kind === 'referral' ? CONFIG.REFERRAL_COOLDOWN_HOURS : CONFIG.EXPLAINER_COOLDOWN_HOURS;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      const timeSince = now - lastTime;
      if (timeSince < cooldownMs) {
        const remainingMinutes = Math.ceil((cooldownMs - timeSince) / 60000);
        return { allowed: false, reason: `cooldown_active (${remainingMinutes}m remaining)` };
      }
    }
  }
  
  // Check minimum spacing from last non-result post
  if (state.lastNonResultPost) {
    const spacingMs = CONFIG.MIN_SPACING_MINUTES * 60 * 1000;
    const timeSince = now - state.lastNonResultPost;
    if (timeSince < spacingMs) {
      const remainingMinutes = Math.ceil((spacingMs - timeSince) / 60000);
      return { allowed: false, reason: `spacing_too_soon (${remainingMinutes}m until spacing clear)` };
    }
  }
  
  return { allowed: true };
}

/**
 * Get current state snapshot (for debugging)
 */
export function getStateSnapshot() {
  checkAndResetDaily();
  return {
    lastPostTimes: { ...state.lastPostTimes },
    lastNonResultPost: state.lastNonResultPost,
    dailyNonResultCount: state.dailyNonResultCount,
    dailyResetDate: state.dailyResetDate,
    deduplicatedNewsCount: state.deduplicatedNews.size,
    config: CONFIG
  };
}

// Initialize periodic cleanup
setInterval(() => {
  cleanOldNewsKeys();
  checkAndResetDaily();
}, 60 * 60 * 1000); // Every hour
