# PumpBets - Meme Coin Price Prediction Market

## Overview

PumpBets is a revolutionary price prediction market built on Solana where users bet SOL on which newly launched Pump.fun meme coins will have the highest percentage price gains during race periods. The application features real-time price feeds, provably fair settlement mechanics, and actual blockchain SOL transfers for all betting and payout operations. **RACE token betting is currently disabled** - the platform operates in SOL-only mode.

The system implements a complete prediction market platform with live price data integration from Jupiter API, custodial escrow betting mechanics, and automated settlement based on real price movements. All user interactions involve real SPL token transfers on Solana devnet, making this a production-ready decentralized prediction market.

## User Preferences

Preferred communication style: Simple, everyday language.

## Raceswap V2 Integration

**ADDED November 24, 2025**: Raceswap V2 has been successfully integrated into the racepump.fun application with a complete architectural rebuild to eliminate the 0x1789 signer privilege escalation error.

### V2 Architecture (Non-Custodial)
- **Program ID**: `Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk` (Mainnet)
- **User owns all tokens** throughout the swap process (no custodial vault)
- **User signs for Jupiter** directly (no PDA signing conflicts)
- **Simple SOL treasury fee** (0.2%) collected via system transfer
- **83% smaller codebase** compared to V1 (106 lines vs 636 lines)

### Files
- `programs/raceswap/src/lib.rs` - V2 Anchor program
- `client/src/lib/raceswap-v2.ts` - V2 client library with Jupiter integration
- `client/src/pages/TestV2.tsx` - Test page accessible at `/test-v2` route

### Why V2?
The V1 custodial architecture used a swap_authority PDA to sign Jupiter CPI calls, but Solana automatically marks PDAs as signers in AccountInfo, creating an unfixable mismatch with AccountMeta that Jupiter's CPI validation rejects (error 0x1789). V2 eliminates this by having the user sign directly, making the program a simple coordinator that collects fees and passes through to Jupiter.

### Current Status
- ✅ V2 program deployed on mainnet
- ✅ Client library integrated into frontend
- ✅ Test page available at `/test-v2`
- ⏳ Testing through web interface (where Jupiter API works)
- 🎯 Next: Add RACE reflection leg after MVP validation

## System Architecture

### Frontend Architecture
The client is built with React, TypeScript, and Vite, utilizing Tailwind CSS for styling and shadcn/ui components for the interface. The application uses React Query for data fetching and state management, with Zustand for global state management. Solana wallet integration is handled through @solana/wallet-adapter-react with support for Phantom and Solflare wallets.

The frontend implements a single-page application with client-side routing using Wouter. Key pages include the lobby for viewing available races, detailed race betting interfaces, live race animations using HTML5 Canvas, and results pages with claiming functionality. The UI supports real-time updates through Server-Sent Events for live race status and betting updates.

### Backend Architecture
The server is built with Express.js and TypeScript, following a RESTful API design pattern. The application uses better-sqlite3 for local database storage with a schema-first approach using Drizzle ORM. The server implements custodial escrow functionality where it controls SPL token transfers for betting and payouts.

Key architectural patterns include middleware for admin authentication, rate limiting, and request validation using Zod schemas. The server handles blockchain interactions through @solana/web3.js, managing SPL token transfers and verification. All betting operations require on-chain transaction verification before being recorded in the database.

### Data Storage Solutions

**FIXED October 31, 2025**: Critical settlement bug fixed - system was attempting RACE token payouts even when no RACE bets existed due to currency filter treating NULL as RACE. Settlement logic now explicitly checks for `currency='RACE'` and defaults NULL/missing currency to SOL. This prevents "Escrow has insufficient tokens" errors in SOL-only mode.

**FIXED October 31, 2025**: Migration system fixed to run incremental migrations even when tables exist. Migration 005_enhance_settlement_transfers successfully applied to both development and production databases, adding proper tracking columns (status, attempts, last_error, batch_id) for the batched payout system.

**UPDATED October 26, 2025**: The application now uses PostgreSQL for all persistent storage with proper separation between development and production databases.

#### Database Architecture
- **Development**: Uses a dedicated PostgreSQL database instance for testing and feature development
- **Production**: Uses a separate PostgreSQL database instance that preserves all user data across deployments
- **Storage Layer**: Unified `PostgresStorage` abstraction handles all database operations with proper type conversion (BIGINT → Number)
- **Migration System**: Idempotent SQL migrations in `sql-scripts/` directory ensure safe schema updates without data loss

#### Database Separation - CRITICAL
To prevent production data loss, development and production MUST use separate `DATABASE_URL` values:

1. **Development Environment** (workspace):
   - Uses the `DATABASE_URL` secret you set in your workspace
   - Safe to experiment, reset, or modify without affecting users

2. **Production Deployment**:
   - Replit automatically provisions a separate production database
   - The production `DATABASE_URL` is different from development
   - All user bets, race history, and leaderboard data persist across redeployments

**Migration Safety**: All migrations use `CREATE TABLE IF NOT EXISTS` and are wrapped in error handlers. When you deploy, migrations run automatically on the production database but only add new schema elements - they never delete or truncate existing data.

#### Schema Details
The database includes tables for races, bets, claims, treasury state, leaderboard (user_stats, user_race_results), settlement transfers, and referral tracking. All monetary values are stored as NUMERIC for precision. Timestamps use BIGINT for millisecond precision. Race data includes runner information, timing, status, and price change tracking.

### Authentication and Authorization
The system implements a dual authentication model: standard wallet-based authentication for users through Solana wallet adapters, and admin token-based authentication for administrative operations. Admin routes are protected with a static bearer token validated through middleware.

User authentication is handled entirely through wallet signatures and public key verification. No traditional user accounts or passwords are required - all user identity is derived from their Solana wallet address. Admin functions require a separate authentication token for race management and faucet operations.

### Referral Payout System

**UPDATED November 7, 2025**: The referral payout system has been optimized to eliminate dust payments and improve efficiency:

#### Reward Aggregation
- **Smart Batching**: Multiple small rewards are aggregated by wallet address and currency before sending
- **Minimum Threshold**: 0.01 SOL or RACE minimum payout (applied to aggregated totals per wallet)
- **Accumulation**: Rewards below threshold remain in queue and accumulate until they reach the minimum
- **Example**: 100 rewards of 0.0001 SOL each → one payment of 0.01 SOL to the wallet

#### Scheduling Optimization
- **24-Hour Intervals**: Payouts run every 24 hours (configurable via `REF_PAYOUT_INTERVAL_MS`)
- **No Startup Payouts**: Server restarts no longer trigger immediate payouts to prevent dust transactions
- **First Payout**: Occurs 24 hours after server start, then every 24 hours thereafter
- **Independent Currencies**: SOL and RACE payouts process independently (SOL succeeds even if RACE fails)

#### Security and Verification
- **Wallet Verification Required**: Only verified wallets (Ed25519 signature) receive level 1-3 referral rewards
- **Level 0 Exception**: Bettor self-discounts (level 0) always allowed without verification
- **Grandfathered Users**: 6 existing referral users marked as verified automatically
- **Pay-First-Mark-Later**: Blockchain transaction confirmed before database marking for safety

### External Service Integrations
The application integrates with multiple external APIs for live data and real-time price tracking. Pump.fun token data is fetched from Bitquery GraphQL API as the primary source, with Birdeye API as a fallback for market cap and token metadata. Both APIs require authentication keys and implement caching strategies.

**UPDATED September 4, 2025**: The system now uses Jupiter API for live price tracking and winner determination instead of random selection. When a race starts, the system captures initial token prices and then uses Jupiter's public price API to track real price movements during the 10-second race period. The winner is determined by the token with the highest percentage price gain, making the prediction market truly based on actual market performance.

**UPDATED October 29, 2025**: Race token selection timing has been completely redesigned for maximum freshness and diversity. Tokens are now selected WHEN RACES GO LIVE (transition to LOCKED state), not when races are created. This prevents batches of similar tokens appearing back-to-back by ensuring each race gets the absolute latest trending tokens from GeckoTerminal at the moment betting opens. During the OPEN (blurred) phase, races display placeholder runners with "???" symbols. When the race transitions to LOCKED and unblurs, the system fetches fresh trending tokens from GeckoTerminal's rotating pages (1-5) and reveals the actual competing tokens. This architecture maximizes token diversity across consecutive races and ensures truly fresh market data for every prediction round.

The previous randomness-based system (drand HTTP API and Chainlink VRF) has been replaced with this real price tracking mechanism for authentic market-driven outcomes. Price change data is stored in race records for full transparency and verification.

Solana blockchain integration uses the official web3.js library with devnet RPC endpoints. All SPL token operations are performed on-chain with transaction verification and confirmation. The system maintains its own keypair for escrow operations and implements proper ATA (Associated Token Account) management for user payouts.

## Deployment Configuration

**UPDATED September 5, 2025**: The application has been enhanced with comprehensive deployment fixes to address common production issues:

### Build and Memory Optimizations
- **BigInt Bindings**: Automatic rebuild of better-sqlite3 to fix native binding issues
- **Memory Management**: NODE_OPTIONS set to 4GB for builds, 2GB for production runtime
- **Build Script**: Custom `rebuild.sh` script provides deployment-ready build process
- **Graceful Degradation**: Server continues operating even with component failures

### Database Resilience
- **Connection Retry Logic**: Automatic retry mechanism with fallback to in-memory storage
- **Health Monitoring**: Real-time component health tracking via `/health` endpoint
- **Development Fallback**: SQLite for development, in-memory store for deployment failures

### Error Handling Enhancements
- **Graceful Startup**: Server attempts recovery from initialization failures
- **Component Testing**: Startup verification of BigInt, database, and Solana connectivity
- **Deployment Safety**: Enhanced error logging and safe restart mechanisms

## External Dependencies

- **Solana Blockchain**: Devnet RPC for SPL token transfers and transaction verification
- **Bitquery API**: Primary source for live Pump.fun token data and market caps
- **Birdeye API**: Fallback provider for token metadata and market information
- **drand Network**: Decentralized randomness beacon for provably fair race outcomes
- **Chainlink VRF**: Alternative randomness source using EVM testnet oracles
- **PostgreSQL/Neon**: Database provider for production deployments (Drizzle configured)
- **External Fonts**: Google Fonts (Inter, JetBrains Mono) and Font Awesome icons
- **Wallet Providers**: Integration with Phantom and Solflare wallet browser extensions