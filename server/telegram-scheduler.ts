/**
 * Telegram Scheduler
 * 
 * Manages scheduled and event-driven Telegram posts:
 * - Referral posts: 3×/day at 08:30, 14:30, 20:30 PT
 * - Explainer posts: 2×/day at 11:15, 18:15 PT
 * - News posts: Immediate when new headlines arrive
 * - Race results: Immediate on race settlement (handled by telegram.ts)
 */

import {
  canPost,
  getLastPostTime,
  setLastPostTime,
  recordNonResultPost,
  hasNewsBeenPosted,
  markNewsPosted,
  getStateSnapshot
} from './telegram-state';

interface SchedulerConfig {
  targetGroupId: string;
  assetsDir: string;
  pythonBin: string;
  scriptPath: string;
}

let config: SchedulerConfig | null = null;
let cronTimers: NodeJS.Timeout[] = [];

/**
 * Initialize the Telegram scheduler
 */
export function initializeTelegramScheduler(): void {
  console.log('[telegram-scheduler] Initializing scheduler...');
  
  const env = (globalThis as any).process?.env || {};
  
  // Validate required environment variables
  if (!env.TELEGRAM_TARGET_GROUP) {
    console.warn('[telegram-scheduler] TELEGRAM_TARGET_GROUP not set; scheduler disabled');
    return;
  }
  
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH || !env.TELEGRAM_BOT_TOKEN) {
    console.warn('[telegram-scheduler] Telegram API credentials not set; scheduler disabled');
    return;
  }
  
  // Setup configuration
  config = {
    targetGroupId: env.TELEGRAM_TARGET_GROUP,
    assetsDir: '/home/runner/workspace/attached_assets',
    pythonBin: env.PYTHON_BIN || '/home/runner/workspace/.pythonlibs/bin/python3',
    scriptPath: '/home/runner/workspace/scripts/send_telegram_post.py'
  };
  
  // Verify Python and script exist
  (async () => {
    try {
      const fs = await safeImport('fs');
      
      if (!fs?.existsSync(config!.scriptPath)) {
        console.warn(`[telegram-scheduler] Script not found: ${config!.scriptPath}; scheduler disabled`);
        config = null;
        return;
      }
      
      if (!fs?.existsSync(config!.pythonBin)) {
        console.warn(`[telegram-scheduler] Python not found: ${config!.pythonBin}; scheduler disabled`);
        config = null;
        return;
      }
      
      console.log('[telegram-scheduler] Configuration validated');
      
      // Start cron jobs
      startCronJobs();
      
      // Log initial state
      console.log('[telegram-scheduler] Initial state:', getStateSnapshot());
      
    } catch (e) {
      console.error('[telegram-scheduler] Initialization error:', e);
      config = null;
    }
  })();
}

/**
 * Start all cron jobs
 */
function startCronJobs(): void {
  if (!config) return;
  
  console.log('[telegram-scheduler] Starting cron jobs...');
  
  // Referral posts: 08:30, 14:30, 20:30 PT daily
  // CRON: 30 8,14,20 * * * in PT = convert to UTC
  scheduleAtPTTimes([8, 14, 20], 30, () => postReferral(true));
  
  // Explainer posts: 11:15, 18:15 PT daily
  // CRON: 15 11,18 * * * in PT = convert to UTC
  scheduleAtPTTimes([11, 18], 15, () => postExplainer(true));
  
  console.log('[telegram-scheduler] Cron jobs started');
  console.log('[telegram-scheduler] - Referral: 08:30, 14:30, 20:30 PT daily');
  console.log('[telegram-scheduler] - Explainer: 11:15, 18:15 PT daily');
}

/**
 * Schedule tasks at specific PT times daily
 */
function scheduleAtPTTimes(hours: number[], minute: number, callback: () => void): void {
  // Check every minute if we should run
  const timer = setInterval(() => {
    const now = new Date();
    const ptDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const ptHour = ptDate.getHours();
    const ptMinute = ptDate.getMinutes();
    
    // Run if current PT time matches one of the scheduled times
    if (hours.includes(ptHour) && ptMinute === minute) {
      // Only run once per minute (use seconds check to prevent duplicate runs)
      const ptSecond = ptDate.getSeconds();
      if (ptSecond === 0) {
        callback();
      }
    }
  }, 1000); // Check every second
  
  cronTimers.push(timer);
}

/**
 * Post referral message
 */
export async function postReferral(isScheduled: boolean = false): Promise<void> {
  console.log('[telegram-scheduler] Attempting referral post...');
  
  if (!config) {
    console.warn('[telegram-scheduler] Config not initialized, skipping referral post');
    return;
  }
  
  // Check if posting is allowed
  const check = canPost('referral', isScheduled);
  if (!check.allowed) {
    console.log(`[telegram-scheduler] Referral post blocked: ${check.reason}`);
    return;
  }
  
  const caption = `🏁 RACEPUMP REFERRALS

Invite friends → you both get a 5% fee rebate.
Earn a 60% commission on their trading fees, including their referrals.

Current levels:
• L1: 30% • L2: 6% • L3: 2% of referral pool (50% of rake)
• Rebate: 5% of rake

Join here:
https://racepump.fun/referrals`;
  
  const imagePath = `${config.assetsDir}/racenotify1.png`;
  
  try {
    await sendTelegramPost({
      caption,
      imagePath,
      kind: 'referral'
    });
    
    console.log('[telegram-scheduler] ✅ Referral post sent successfully');
  } catch (e) {
    console.error('[telegram-scheduler] ❌ Failed to send referral post:', e);
  }
}

/**
 * Post explainer message
 */
export async function postExplainer(isScheduled: boolean = false): Promise<void> {
  console.log('[telegram-scheduler] Attempting explainer post...');
  
  if (!config) {
    console.warn('[telegram-scheduler] Config not initialized, skipping explainer post');
    return;
  }
  
  // Check if posting is allowed
  const check = canPost('explainer', isScheduled);
  if (!check.allowed) {
    console.log(`[telegram-scheduler] Explainer post blocked: ${check.reason}`);
    return;
  }
  
  const caption = `🏎️ WELCOME TO PUMP RACERS

A live prediction market for newly launched Pump.fun meme coins.
Bet on which coins will gain the most over a 20-minute window.
Winners split the prize pool based on real market performance.

Play now:
https://racepump.fun/

Follow updates:
https://x.com/racepumpfun`;
  
  const videoPath = `${config.assetsDir}/racenotify1.mp4`;
  
  try {
    await sendTelegramPost({
      caption,
      videoPath,
      kind: 'explainer'
    });
    
    console.log('[telegram-scheduler] ✅ Explainer post sent successfully');
  } catch (e) {
    console.error('[telegram-scheduler] ❌ Failed to send explainer post:', e);
  }
}

/**
 * Post news item (called externally when news arrives)
 */
export async function postNews(headline: string, url?: string): Promise<boolean> {
  console.log('[telegram-scheduler] Attempting news post...');
  
  if (!config) {
    console.warn('[telegram-scheduler] Config not initialized, skipping news post');
    return false;
  }
  
  // Check if already posted
  if (hasNewsBeenPosted(headline)) {
    console.log('[telegram-scheduler] News already posted (dedupe), skipping');
    return false;
  }
  
  // News posts bypass spacing/caps checks
  const check = canPost('news', false);
  if (!check.allowed) {
    console.log(`[telegram-scheduler] News post blocked: ${check.reason}`);
    return false;
  }
  
  // Build caption with headline
  const fs = await safeImport('fs');
  const caption = url && !headline.includes(url) ? `${headline}\n\n${url}` : headline;
  const imagePath = `${config.assetsDir}/racenewsalert.png`;
  
  // Check if image exists
  const hasImage = fs?.existsSync && fs.existsSync(imagePath);
  
  try {
    await sendTelegramPost({
      caption,
      imagePath: hasImage ? imagePath : undefined,
      kind: 'news'
    });
    
    // Mark as posted
    markNewsPosted(headline);
    
    console.log('[telegram-scheduler] ✅ News post sent successfully');
    return true;
  } catch (e) {
    console.error('[telegram-scheduler] ❌ Failed to send news post:', e);
    return false;
  }
}

/**
 * Send a Telegram post via Python script
 */
async function sendTelegramPost(options: {
  caption: string;
  imagePath?: string;
  videoPath?: string;
  kind: 'referral' | 'explainer' | 'news';
}): Promise<void> {
  if (!config) throw new Error('Config not initialized');
  
  const { caption, imagePath, videoPath, kind } = options;
  
  // Verify asset exists if provided
  const fs = await safeImport('fs');
  const assetPath = imagePath || videoPath;
  
  if (assetPath && fs?.existsSync && !fs.existsSync(assetPath)) {
    throw new Error(`Asset not found: ${assetPath}`);
  }
  
  const cp = await safeImport('child_process');
  if (!cp?.spawn) {
    throw new Error('child_process not available');
  }
  
  // Build command arguments
  const args = [
    config.scriptPath,
    '--group', config.targetGroupId,
    '--caption', caption
  ];
  
  if (imagePath) {
    args.push('--image', imagePath);
  } else if (videoPath) {
    args.push('--video', videoPath);
  }
  
  // For news, escape HTML
  if (kind === 'news') {
    args.push('--escape-html');
  }
  
  console.log(`[telegram-scheduler] Executing: ${config.pythonBin} ${args.join(' ')}`);
  
  // Execute Python script
  return new Promise((resolve, reject) => {
    const env = (globalThis as any).process?.env || {};
    const child = cp.spawn(config!.pythonBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (d: any) => {
      stdout += String(d);
      console.log(`[telegram-scheduler:stdout] ${String(d)}`);
    });
    
    child.stderr.on('data', (d: any) => {
      stderr += String(d);
      console.error(`[telegram-scheduler:stderr] ${String(d)}`);
    });
    
    child.on('error', (err: any) => {
      console.error(`[telegram-scheduler] Spawn error: ${err?.message || String(err)}`);
      reject(err);
    });
    
    child.on('close', (code: number | null) => {
      if (code === 0) {
        // Update state on successful post
        const now = Date.now();
        setLastPostTime(kind, now);
        
        // Only update spacing/counter for non-news posts
        if (kind !== 'news') {
          recordNonResultPost(now);
        }
        
        resolve();
      } else {
        reject(new Error(`Script exited with code ${code}\nStderr: ${stderr}`));
      }
    });
  });
}

/**
 * Stop all cron timers
 */
export function stopScheduler(): void {
  cronTimers.forEach(timer => clearInterval(timer));
  cronTimers = [];
  console.log('[telegram-scheduler] Stopped all cron jobs');
}

/**
 * Get scheduler status (for debugging)
 */
export function getSchedulerStatus() {
  return {
    enabled: config !== null,
    config: config ? {
      targetGroupId: config.targetGroupId,
      assetsDir: config.assetsDir,
      pythonBin: config.pythonBin,
      scriptPath: config.scriptPath
    } : null,
    activeCronJobs: cronTimers.length,
    state: getStateSnapshot()
  };
}

async function safeImport(moduleName: string): Promise<any> {
  try {
    const dyn = new Function("m", "return import(m)");
    return await (dyn as any)(moduleName);
  } catch {
    try {
      const req = (0, eval)("require");
      return req ? req(moduleName) : null;
    } catch {
      return null;
    }
  }
}
