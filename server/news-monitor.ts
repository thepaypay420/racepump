/**
 * News Monitor Manager
 * Starts and manages the Python news monitoring process
 */
import { spawn, ChildProcess } from 'child_process';

let newsMonitorProcess: ChildProcess | null = null;

/**
 * Start the news monitoring process
 */
export function startNewsMonitor(): void {
  const env = process.env;
  
  // Check if Telegram credentials are set
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    console.log('[news-monitor] Telegram credentials not set, skipping news monitor');
    return;
  }
  
  if (!env.ADMIN_TOKEN) {
    console.log('[news-monitor] ADMIN_TOKEN not set, skipping news monitor');
    return;
  }
  
  const pythonBin = env.PYTHON_BIN || '/home/runner/workspace/.pythonlibs/bin/python3';
  const scriptPath = '/home/runner/workspace/scripts/monitor_news_group.py';
  
  try {
    console.log('[news-monitor] Starting news monitor process...');
    
    // Spawn the Python monitor with bot token for channel monitoring
    newsMonitorProcess = spawn(pythonBin, [scriptPath], {
      env: {
        ...env,
        NEWS_GROUP_ID: env.NEWS_GROUP_ID || '3202839459',
        SERVER_URL: env.SERVER_URL || 'http://localhost:5000/api/admin/post-news',
        TELEGRAM_SESSION_NAME: 'news_monitor_session'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Log stdout
    newsMonitorProcess.stdout?.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        console.log(`[news-monitor] ${message}`);
      }
    });
    
    let lastStderr = '';
    
    // Capture stderr for error detection and logging
    newsMonitorProcess.stderr?.on('data', (data) => {
      const message = data.toString().trim();
      lastStderr = message;
      if (message) {
        console.error(`[news-monitor:err] ${message}`);
      }
    });
    
    // Handle process exit
    newsMonitorProcess.on('exit', (code) => {
      console.log(`[news-monitor] Process exited with code ${code}`);
      newsMonitorProcess = null;
      
      // Don't restart if it's a session file error (code 1 with session error message)
      if (code === 1 && (lastStderr.includes('Session file not found') || lastStderr.includes('Please run the authentication script'))) {
        console.log('[news-monitor] ⚠️ Session file not found or invalid. News monitoring disabled.');
        console.log('[news-monitor] ℹ️ Run: python3 scripts/authenticate_telegram.py to create a session');
        return;
      }
      
      // Auto-restart after 10 seconds if it crashed for other reasons
      if (code !== 0 && code !== null) {
        console.log('[news-monitor] Will restart in 10 seconds...');
        setTimeout(() => {
          startNewsMonitor();
        }, 10000);
      }
    });
    
    newsMonitorProcess.on('error', (err) => {
      console.error('[news-monitor] Failed to start:', err);
      newsMonitorProcess = null;
    });
    
    console.log('[news-monitor] ✅ News monitor started');
    
  } catch (error) {
    console.error('[news-monitor] Error starting news monitor:', error);
  }
}

/**
 * Stop the news monitoring process
 */
export function stopNewsMonitor(): void {
  if (newsMonitorProcess) {
    console.log('[news-monitor] Stopping news monitor...');
    newsMonitorProcess.kill();
    newsMonitorProcess = null;
  }
}

/**
 * Get news monitor status
 */
export function getNewsMonitorStatus(): { running: boolean; pid?: number } {
  return {
    running: newsMonitorProcess !== null && !newsMonitorProcess.killed,
    pid: newsMonitorProcess?.pid
  };
}
