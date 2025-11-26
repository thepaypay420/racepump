# Pump Racers Mainnet Readiness Audit (Pre-Launch)

Status: Draft (Devnet-only). Do NOT change envs or deploy.

## Scope
- Inventory devnet-specific codepaths and configs
- Identify mainnet deltas and risks
- Define migration plan inputs (no changes yet)

## Current Cluster/Network Assumptions
- Default RPC URL fallback: `https://api.devnet.solana.com`
  - server: `server/solana.ts` uses `RPC_URL` env else devnet
  - client: `VITE_RPC_URL` env else devnet
- Commitment levels used: processed/confirmed/finalized mix
  - `server/solana.ts` sender: getLatestBlockhash(commitment loop), confirmTransaction("confirmed")
  - parsing/reads: `confirmed`
  - client bet flow: `Connection(rpc, 'confirmed')`, background confirm at `confirmed`
- CLUSTER env default: `devnet`
- Explorer links include `?cluster=devnet` in client store

## Program IDs and On-chain Contracts
- SPL Token program via @solana/spl-token (TOKEN_PROGRAM_ID)
- Memo program used explicitly: `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`
- No custom Anchor programs detected. Escrow is server wallet ATA, not a program.

## Key Accounts and Mints
- Escrow keypair: server-managed, from `ESCROW_PRIVATE_KEY` (bs58) or generated/persisted file `escrow-keypair.b58`
- Treasury and Jackpot pubkeys: `TREASURY_PUBKEY`, `JACKPOT_PUBKEY` (fallback: server wallet)
- RACE mint: `RACE_MINT` (env) preferred; else DB `treasury.raceMint`; dev tooling can create mint on devnet
- Token decimals assumed 9

## RPC/Rate Limits/Parsing
- Robust send with retries/backoff and status checks (server/solana.ts)
- Parsed transactions with cache; memo extraction supports base64/bs58 and log fallback
- Reconciler scans escrow ATA signatures and verifies via parsed transfers + JSON memo `t: 'BET'`
- Caps: `MAX_PER_TICK=40` per cycle, periodic every 30s (configurable)

## Priority Fees & Compute Budget
- No explicit CU/priority fee ixs added in client nor server
- Rely on default fees; mainnet may require priority fee strategy under load

## Commitment strategy (mainnet considerations)
- Sending uses rotating commitments for blockhash/preflight; confirmation at `confirmed`
- Parsing uses `confirmed`; settlement and verification also use `confirmed`
- Mainnet recommendation: confirm at `finalized` for critical settlement writes, or double-check statuses

## Maintenance Mode
- Centralized in SQLite `treasury` row: fields `maintenanceMode`, `maintenanceMessage`, `maintenanceAnchorRaceId`
- Effects:
  - Blocks creating new races (admin and auto)
  - Betting: if maintenance ON, only earliest OPEN race accepts bets; others blocked
  - State machine: during maintenance, only anchored OPEN may progress; price updates for LOCKED/IN_PROGRESS continue

## Lifecycle Safety (Open → Locked → In Progress → Settled/Cancelled)
- Single active LOCKED/IN_PROGRESS at a time enforced by state machine
- Lock captures baseline prices with retries and fallbacks
- Settlement computes winner from GeckoTerminal OHLCV; emits payouts/refunds
- Idempotency:
  - Seen tx signatures for bets via `seen_tx` (reserve/release/upsert)
  - Settlement transfers recorded in `settlement_transfers`; payouts/refunds skip if already recorded
  - Per-user results upserted in `user_race_results` and aggregated into `user_stats`

## Funds Flow
- Bets: SPL transfer to escrow ATA with JSON memo
- Payouts: SPL transfers from escrow to winners with memo `payout:<raceId>:<wallet>`
- Refunds (no winners): SPL transfers from escrow, typed as PAYOUT in schema
- Rake: SPL transfer to treasury; jackpot contribution accounted in DB (escrow retains tokens)

## Env/Flags Inventory
- RPC_URL, CLUSTER (default devnet)
- ESCROW_PRIVATE_KEY | SERVER_KEYPAIR (bs58)
- RACE_MINT, TREASURY_PUBKEY, JACKPOT_PUBKEY
- MOCK_SOLANA: simulates on-chain ops if true
- ENABLE_BET_RESCAN (server)
- RESCAN_MAX_PAGES/LIMITS
- OPEN_WINDOW_MINUTES, PROGRESS_WINDOW_MINUTES, TRANSITION_GRACE_MS
- SOLANA_RPC_MIN_INTERVAL_MS, ONCHAIN_TIME_REFRESH_MS
- ADMIN_TOKEN
- VITE_RPC_URL, VITE_ENABLE_RESCAN (client)

## Data Stores
- Primary: SQLite (persistent path resolution with WAL); optional Postgres mirror of key tables
- Tables: races, bets, claims, treasury, seen_tx, settlement_transfers, user_race_results, user_stats, recent_winners

## Observability
- Pino logger (server/index.ts)
- Structured logs on transitions, settlement, reconciler, SPL transfers
- SSE events: race_* events, payout_executed, user_loss

## Mainnet Gaps/Risks
- Priority fee not configured; may need compute budget and fee ixs for busy periods
- Confirmation at `confirmed`; for settlements consider `finalized` or post-check
- Single RPC URL; recommend multiple endpoints/load-balanced or fallback
- MOCK_SOLANA must be strictly disabled in production
- Ensure escrow key handling and file permissions are secured; avoid generating keys in prod
- Jackpot accounting is DB-local; on-chain jackpot pool not separated
- GeckoTerminal dependency; add fallback/provider redundancy
- Rate limiting and retries tuned for devnet; revisit for mainnet RPC limits

## Required Changes for Mainnet (do not implement yet)
- Set environment variables for mainnet:
  - RPC_URL (primary), optional fallback(s)
  - CLUSTER=mainnet-beta
  - RACE_MINT (real SPL mint), TREASURY_PUBKEY, JACKPOT_PUBKEY, ESCROW_PRIVATE_KEY
  - Disable MOCK_SOLANA
  - Tune OPEN/PROGRESS windows if needed
  - ENABLE_BET_RESCAN based on ops preference
- Transaction policy updates:
  - Add optional compute budget + priority fee ixs (feature flag)
  - Raise confirmation to finalized for settlement critical path or add second-phase verification
- Observability:
  - Centralized log shipping, alerting on settlement discrepancies
  - Metrics for reconciler throughput, payout success rates
- RPC strategy:
  - Add fallback RPCs and health checks; exponential backoff per provider

## Upgrade Authority and Security
- No custom program upgrade authority in scope
- Secure .env/secrets handling for escrow/treasury/jackpot keys
- Rotate admin token; enforce allowlists for admin UI

## External Dependencies
- GeckoTerminal API for OHLCV; consider caching and provider redundancy

