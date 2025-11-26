import express, { type Request, Response, NextFunction } from "express";
// Delay importing db/clients until after optional path resolution
import { selectedDatabase, getDbDiagnostics as getDbDiag } from './db/index';
let usePgForReceipts: boolean = false;
import { createServer } from "http";
import cors from "cors";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { rateLimiter } from './rate-limiter';

// Initialize logger with better error handling for deployment
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  } : undefined
});

// Graceful degradation flags
let gracefulMode = false;
const healthStatus = {
  database: false,
  bigint: false,
  solana: false,
  server: false
};

// Test BigInt bindings during startup
try {
  const testBigInt = BigInt('1234567890123456789');
  const testResult = testBigInt.toString();
  if (testResult === '1234567890123456789') {
    healthStatus.bigint = true;
    console.log('✅ BigInt bindings working correctly');
  } else {
    throw new Error('BigInt conversion failed');
  }
} catch (error) {
  console.warn('⚠️ BigInt bindings failed, using fallback implementation');
  healthStatus.bigint = false;
  gracefulMode = true;
}

// Add global error handlers to catch deployment crashes
process.on('uncaughtException', (error) => {
  console.error('💥 UNCAUGHT EXCEPTION - DEPLOYMENT CRASH:');
  console.error('Error name:', error.name);
  console.error('Error message:', error.message);
  console.error('Error stack:', error.stack);
  console.error('Health status:', healthStatus);
  
  // Try graceful degradation instead of immediate exit
  if (!gracefulMode) {
    console.log('🔄 Attempting graceful degradation...');
    gracefulMode = true;
    setTimeout(() => {
      console.error('❌ Graceful degradation failed, exiting...');
      process.exit(1);
    }, 5000);
  } else {
    console.error('❌ Already in graceful mode, exiting...');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION - DEPLOYMENT CRASH:');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  console.error('Health status:', healthStatus);
  
  // Try graceful degradation instead of immediate exit
  if (!gracefulMode) {
    console.log('🔄 Attempting graceful degradation...');
    gracefulMode = true;
    setTimeout(() => {
      console.error('❌ Graceful degradation failed, exiting...');
      process.exit(1);
    }, 5000);
  } else {
    console.error('❌ Already in graceful mode, exiting...');
    process.exit(1);
  }
});

const app = express();

// CORS configuration with allowlist and production hardening
const allowedOrigins = new Set<string>([
  'https://racepump.fun',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests and same-origin
    if (!origin) return callback(null, true);
    // In development, allow all for DX
    if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
      return callback(null, true);
    }
    try {
      const url = new URL(origin);
      const normalized = `${url.protocol}//${url.host}`;
      if (allowedOrigins.has(normalized)) {
        return callback(null, true);
      }
    } catch {}
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Basic security headers
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// Smart IP-based rate limiting (production only)
app.use(rateLimiter.middleware());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      logger.info(logLine);
    }
  });

  next();
});

// Global error handler with deployment-safe logging
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  // Detect deployment environment
  const isDeployment = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;

  // Safe error logging for deployment
  try {
    logger.error({ err: { message: err.message, stack: err.stack }, status }, `Error: ${message}`);
  } catch (logError) {
    // Fallback to console if logger fails in deployment
    console.error('Error occurred:', message, 'Status:', status);
    if (!isDeployment) {
      console.error('Full error:', err);
    }
  }

  // Send safe error response
  res.status(status).json({ 
    error: isDeployment && status === 500 ? "Internal Server Error" : message 
  });
});

// Declare httpServer outside async IIFE so shutdown handler can access it
let httpServer: any = null;

(async () => {
  try {
    console.log('🚀 Starting PumpBets server with deployment fixes...');

    // Decide DB mode up-front
    const dbMode = selectedDatabase();

    // In production/forced Postgres, verify connectivity and avoid touching SQLite files
    if (dbMode === 'postgres') {
      try {
        // Import db.ts and wait for hydration to complete
        console.log('🔄 Initializing database and hydration...');
        const { hydrationPromise } = await import('./db');
        await hydrationPromise;
        console.log('✅ Hydration completed, verifying diagnostics...');
        // Will exit(1) on failure per enforcement
        await getDbDiag();
        console.log('✅ Database diagnostics passed');
      } catch (e) {
        console.error('❌ Failed Postgres diagnostics at startup:', e);
        process.exit(1);
      }
      console.log('✅ Postgres mode initialization complete');
    } else {
      // Development: ensure persistent SQLite path before any DB import
      try {
        const { resolvePersistentSqlitePath } = await import('./db/persistent-path');
        resolvePersistentSqlitePath({ silent: false });
        const isEphemeralHost = Boolean(
          process.env.REPLIT_DEPLOYMENT ||
          process.env.VERCEL ||
          process.env.FLY_APP_NAME ||
          process.env.RENDER ||
          process.env.RAILWAY_STATIC_URL ||
          process.env.GITHUB_ACTIONS
        );
        if (isEphemeralHost && !process.env.DB_PATH) {
          // Skip legacy path migrations in dev-lite mode
        }
      } catch {}
    }
    console.log('✅ Database mode selection complete');

    // Respect provided NODE_ENV; do not force development in production deploys
    console.log('🔄 Setting up NODE_ENV...');
    if (!process.env.NODE_ENV) {
      // Default to 'production' when running under a deployment platform
      const isDeployment = Boolean(process.env.REPLIT_DEPLOYMENT || process.env.VERCEL || process.env.FLY_APP_NAME || process.env.RENDER || process.env.RAILWAY_STATIC_URL || process.env.GITHUB_ACTIONS);
      process.env.NODE_ENV = isDeployment ? 'production' : 'development';
      console.log(`🔧 NODE_ENV not set, defaulting to ${process.env.NODE_ENV}`);
    }
    console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
    
    // Database initialization will run asynchronously after the server starts listening
    
    console.log('🔄 Setting default environment variables...');
    // Set default values for environment variables
      if (!process.env.RPC_URL) {
        process.env.RPC_URL = 'https://spring-cold-tree.solana-mainnet.quiknode.pro/24011188359c3607a1ed91ac2ecbfe22b8e39681/';
        logger.info('Using default Solana mainnet RPC (QuickNode)');
      }
      if (!process.env.RPC_URL_MAINNET) {
        process.env.RPC_URL_MAINNET = process.env.RPC_URL;
      }
    console.log('✅ Environment variables configured');
    
    // ADMIN_TOKEN must be provided via environment/secrets; no in-code default
    
    // ESCROW_PRIVATE_KEY will be generated if not set (handled in solana.ts)
    // API keys are no longer required - using sample data

    console.log('🔄 Configuring winner selection mode...');
    // Validate RNG mode
    // RNG removed - winners determined by price performance only
    logger.info('Winner selection: Based on highest price gain during race period');
    console.log('✅ Winner selection configured');

    // Heavy initialization moved to post-listen async block

    console.log('🔄 Preparing to start HTTP server...');
    // Start server immediately, then continue heavy init asynchronously
    const port = parseInt(process.env.PORT || process.env.REPLIT_PORT || '5000', 10);
    console.log(`🔍 Port configuration: PORT=${process.env.PORT}, REPLIT_PORT=${process.env.REPLIT_PORT}, using port=${port}`);

    console.log('🔄 Creating HTTP server...');
    httpServer = createServer(app);
    console.log('✅ HTTP server created, starting listen...');
    httpServer.listen(port, '0.0.0.0', async () => {
      healthStatus.server = true;
      logger.info(`🏁 Pump Racers server running on port ${port}`);
      logger.info('✅ Server ready to accept connections');
      logger.info(`Final health status: ${JSON.stringify(healthStatus)}`);

      // Continue initialization without blocking port-open
      setImmediate(async () => {
        try {
          console.log('🔄 Step 1: Importing db clients...');
          // Import db clients AFTER path resolution
          try {
            const clients = await import('./db/clients');
            usePgForReceipts = clients.usePgForReceipts;
            if (usePgForReceipts) {
              console.log('Using Postgres for receipts/leaderboard');
            }
            console.log('✅ Step 1 complete: db clients imported');
          } catch (e) {
            console.error('❌ Step 1 failed:', e);
          }
          
          console.log('🔄 Step 2: Importing routes module...');
          // Register routes (no server creation here)
          const { registerRoutes, initializeApp } = await import('./routes');
          console.log('✅ Step 2 complete: routes module imported');
          
          console.log('🔄 Step 3: Registering routes...');
          await registerRoutes(app);
          console.log('✅ Step 3 complete: routes registered');
          // Re-apply maintenance mode from sentinel file if DB was reset
          try {
            const candidates = [
              '/data/pump-racers-maintenance.json',
              '/mnt/data/pump-racers-maintenance.json',
              path.join(process.cwd(), 'data', 'pump-racers-maintenance.json')
            ];
            let sentinel: any = null;
            for (const file of candidates) {
              try {
                if (fs.existsSync(file)) {
                  const raw = fs.readFileSync(file, 'utf-8');
                  sentinel = JSON.parse(raw);
                  break;
                }
              } catch {}
            }
            if (sentinel && typeof sentinel.mode === 'boolean') {
              try {
                const { getDb } = await import('./db');
                const current = await getDb()?.getTreasury();
                if (sentinel.mode && !current.maintenanceMode) {
                  await getDb()?.updateTreasury({
                    jackpotBalance: current.jackpotBalance,
                    raceMint: current.raceMint,
                    maintenanceMode: true,
                    maintenanceMessage: sentinel.message ?? current.maintenanceMessage,
                    maintenanceAnchorRaceId: sentinel.maintenanceAnchorRaceId ?? current.maintenanceAnchorRaceId
                  } as any);
                  console.log('🧰 Re-applied maintenance mode from sentinel on startup');
                } else if (!sentinel.mode && current.maintenanceMode) {
                  getDb()?.updateTreasury({
                    jackpotBalance: current.jackpotBalance,
                    raceMint: current.raceMint,
                    maintenanceMode: false,
                    maintenanceMessage: sentinel.message ?? current.maintenanceMessage,
                    maintenanceAnchorRaceId: undefined
                  } as any);
                  console.log('🧰 Cleared maintenance mode from sentinel on startup');
                } else if (sentinel.message && sentinel.message !== current.maintenanceMessage) {
                  getDb()?.updateTreasury({ maintenanceMessage: sentinel.message } as any);
                }
                // Best-effort: enforce env gates only when maintenance is enabled
                if (sentinel.mode) {
                  process.env.BLOCK_NEW_RACES = '1';
                  process.env.BLOCK_NEW_BETS = '1';
                  process.env.BLOCK_SETTLEMENTS = '1';
                }
              } catch (e) {
                console.warn('⚠️ Failed to re-apply maintenance sentinel:', e);
              }
            }
          } catch {}
            console.log('🔄 Step 4: Initializing Telegram integration...');
            // Initialize Telegram integration listener (non-blocking)
            try {
              const { initializeTelegramIntegration } = await import('./telegram');
              initializeTelegramIntegration();
              console.log('✅ Step 4 complete: Telegram initialized');
            } catch (e) {
              logger.warn('[telegram] initialization skipped:', e);
              console.log('⚠️ Step 4 skipped: Telegram');
            }
          
          console.log('🔄 Step 4.5: Starting Telegram scheduler (referrals, explainers, news)...');
            // Initialize Telegram scheduler for periodic posts
            try {
              console.log('[telegram-scheduler] Importing module...');
              const mod = await import('./telegram-scheduler');
              console.log('[telegram-scheduler] Module imported, keys:', Object.keys(mod));
              const { initializeTelegramScheduler } = mod;
              console.log('[telegram-scheduler] Calling initializer...');
              initializeTelegramScheduler();
              console.log('✅ Step 4.5 complete: Telegram scheduler started');
            } catch (e) {
              console.error('[telegram-scheduler] Detailed error:', {
                message: (e as any)?.message,
                stack: (e as any)?.stack,
                error: e
              });
              logger.warn('[telegram-scheduler] initialization skipped:', e);
              console.log('⚠️ Step 4.5 skipped: Telegram scheduler');
            }
            
            // Start news monitor
            console.log('🔄 Step 4.6: Starting news monitor...');
            try {
              const { startNewsMonitor } = await import('./news-monitor');
              startNewsMonitor();
              console.log('✅ Step 4.6 complete: News monitor started');
            } catch (e) {
              logger.warn('[news-monitor] initialization skipped:', e);
              console.log('⚠️ Step 4.6 skipped: News monitor');
            }
          
          console.log('🔄 Step 5: Initializing app (races, timers, etc)...');
          // NON-BLOCKING: Let app initialization run in background
          // This prevents database connection issues from blocking server startup
          initializeApp()
            .then(() => {
              healthStatus.database = true;
              console.log('✅ Step 5 complete: App initialized');
            })
            .catch((e) => {
              console.warn('⚠️ initializeApp failed:', e);
              console.error('❌ Step 5 failed:', e);
              healthStatus.database = false;
              gracefulMode = true;
            });

          console.log('🔄 Step 6: Starting referral payout scheduler...');
          // Start referral payout scheduler (daily)
          try {
            const { startReferralPayouts } = await import('./referrals');
            // 24h default; allow override via REF_PAYOUT_INTERVAL_MS
            const interval = Number(process.env.REF_PAYOUT_INTERVAL_MS || (24*60*60*1000));
            startReferralPayouts(interval);
            logger.info('🔁 Referral payout scheduler started');
            console.log('✅ Step 6 complete: Referrals started');
          } catch (e) {
            logger.warn('⚠️ Referral scheduler init skipped:', (e as any)?.message || e);
            console.log('⚠️ Step 6 skipped: Referrals');
          }

          // Setup frontend serving
          const isProduction = process.env.NODE_ENV === 'production';
          console.log(`🔄 Step 7: Setting up frontend serving (mode: ${isProduction ? 'Production' : 'Development'})...`);
          console.log(`🌍 Frontend mode: ${isProduction ? 'Production (static)' : 'Development (Vite)'}`);
          try {
            if (isProduction) {
              const { serveStatic } = await import('./vite');
              serveStatic(app);
              console.log('✅ Static file serving initialized successfully');
              console.log('✅ Step 7 complete: Frontend serving (static)');
            } else {
              const { setupVite } = await import('./vite');
              await setupVite(app, httpServer);
              console.log('✅ Vite development server initialized successfully');
              console.log('✅ Step 7 complete: Frontend serving (Vite)');
            }
          } catch (error) {
            console.error('🚨 Frontend setup failed:', error);
            console.error('❌ Step 7 failed:', error);
            app.get('*', (req, res) => {
              if (req.path.startsWith('/api/')) { return; }
              res.status(200).send(`
                <!DOCTYPE html>
                <html>
                  <head><title>PumpBets - Loading...</title></head>
                  <body>
                    <h1>PumpBets Server Running</h1>
                    <p>Frontend temporarily unavailable - API is working</p>
                    <a href="/health">Check Health Status</a>
                  </body>
                </html>
              `);
            });
            gracefulMode = true;
          }

          // Optional: log chosen mint after init
          try {
            const { raceMintAddress } = await import('./solana');
            const { getDb } = await import('./db');
            const treasury = await getDb()?.getTreasury();
            const chosenMint = raceMintAddress || treasury.raceMint || '(unset)';
            logger.info(`RACE_MINT env: ${raceMintAddress || '(not set)'}`);
            logger.info(`DB treasury.raceMint: ${treasury.raceMint || '(not set)'}`);
            logger.info(`Chosen RACE mint: ${chosenMint}`);
          } catch {}

          // Background maintenance tasks
          try {
            const { getDb } = await import('./db');
            const statsSummary = getDb()?.getUserStatsSummary();
            const resultsSummary = getDb()?.getUserRaceResultsSummary();
            const needsRebuild =
              statsSummary.walletCount === 0 ||
              (resultsSummary.walletCount > statsSummary.walletCount) ||
              (resultsSummary.lastUpdated > statsSummary.lastUpdated);
            if (needsRebuild) {
              logger.info(`🏗️ Rebuilding user_stats from user_race_results... (stats wallets=${statsSummary.walletCount}, results wallets=${resultsSummary.walletCount})`);
              try {
                const { backfillUserResultsFromHistory } = await import('./backfill');
                logger.info('🔄 Backfilling user_race_results from historical races/bets (idempotent)...');
                await backfillUserResultsFromHistory({ logger: (m: string) => logger.info(m) });
              } catch (e) {
                logger.warn('⚠️ Backfill skipped:', e);
              }
              getDb().rebuildUserStatsFromResults();
              const rebuiltCount = getDb().getUserStatsRowCount();
              const newSummary = getDb().getUserStatsSummary();
              logger.info(`✅ Rebuilt user_stats (${rebuiltCount} wallets). Summary: wallets=${newSummary.walletCount}, lastUpdated=${newSummary.lastUpdated}`);
            } else {
              logger.info(`✅ user_stats up-to-date (wallets=${statsSummary.walletCount})`);
            }
          } catch (error) {
            logger.warn('⚠️ Leaderboard rebuild skipped:', error);
          }

          try {
            const { getDb } = await import('./db');
            const { RaceStatus } = await import('@shared/schema');
            const existingWinners = getDb().getRecentWinners();
            if (existingWinners.length === 0) {
              const settledRaces = getDb().getRaces(RaceStatus.SETTLED)
                .filter((race: any) => race.winnerIndex !== undefined)
                .sort((a: any, b: any) => (b.startTs || 0) - (a.startTs || 0))
                .slice(0, 6);
              for (const race of settledRaces) { getDb()?.addRecentWinner(race); }
              logger.info(`✅ Migrated ${settledRaces.length} recent winners (table was empty)`);
            } else {
              logger.info(`✅ Recent winners table already populated with ${existingWinners.length} entries`);
            }
          } catch (error) {
            logger.warn('⚠️ Recent winners migration skipped:', error);
          }

          if (gracefulMode) {
            logger.warn('⚠️ Server started in graceful degradation mode - some features may be limited');
          } else {
            logger.info('🎉 All components healthy - server fully operational');
          }
        } catch (e) {
          logger.error({ err: e as any }, '❌ Async initialization crashed');
        }
      });
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, `Failed to start server: ${errorMessage}`);
    
    // Try graceful fallback instead of immediate exit
    if (!gracefulMode) {
      console.log('🔄 Attempting graceful startup fallback...');
      gracefulMode = true;
      
      // Try simplified server setup
      try {
        const fallbackPort = 5000;
        const fallbackServer = await registerRoutes(app);
        fallbackServer.listen(fallbackPort, '0.0.0.0', () => {
          logger.warn(`🚨 Server started in emergency fallback mode on port ${fallbackPort}`);
          healthStatus.server = true;
        });
      } catch (fallbackError) {
        logger.error('❌ Emergency fallback failed, exiting...');
        process.exit(1);
      }
    } else {
      logger.error('❌ Already in graceful mode, cannot recover, exiting...');
      process.exit(1);
    }
  }
})();

// Graceful shutdown handling for redeployments
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log(`⏭️ Already shutting down, ignoring ${signal}`);
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);
  
  // Set a timeout to force exit if graceful shutdown takes too long
  const forceExitTimeout = setTimeout(() => {
    console.error('❌ Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000); // 10 second timeout
  
  try {
    // Stop accepting new connections
    if (httpServer) {
      console.log('📴 Closing HTTP server...');
      httpServer.close(() => {
        console.log('✅ HTTP server closed');
      });
    }
    
    // Clean up timers and intervals
    try {
      const { cleanup } = await import('./sse');
      if (cleanup) {
        console.log('🧹 Cleaning up SSE connections and timers...');
        await cleanup();
      }
    } catch (e) {
      console.log('⚠️ SSE cleanup not available or failed');
    }
    
    // Stop news monitor
    try {
      const { stopNewsMonitor } = await import('./news-monitor');
      stopNewsMonitor();
    } catch (e) {
      console.log('⚠️ News monitor cleanup not available or failed');
    }
    
    // Close database connections
    try {
      const { pgPool } = await import('./db/clients');
      if (pgPool) {
        console.log('🔌 Closing database connections...');
        await pgPool.end();
        console.log('✅ Database connections closed');
      }
    } catch (e) {
      console.log('⚠️ Database cleanup not available or failed');
    }
    
    console.log('✅ Graceful shutdown complete');
    clearTimeout(forceExitTimeout);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});
