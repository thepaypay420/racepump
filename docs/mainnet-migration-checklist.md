# Mainnet Migration Checklist (Dry Run) — Do NOT execute yet

Use this as a runbook later. Perform on a staging fork first.

## Preflight
- [ ] Confirm no active incidents; enable maintenance mode (freeze upcoming races)
- [ ] Snapshot current SQLite and Postgres (if used)
- [ ] Prepare production secrets securely (vault):
  - `RPC_URL` (primary) and fallback RPCs
  - `CLUSTER=mainnet-beta`
  - `ESCROW_PRIVATE_KEY` (bs58) — cold backup and rotation plan
  - `TREASURY_PUBKEY`, `JACKPOT_PUBKEY`
  - `RACE_MINT` (mainnet mint)
  - `ADMIN_TOKEN`
  - Disable `MOCK_SOLANA`
- [ ] Provision observability (logs, metrics, alerts) and dashboards

## Config & Safety Dry Run (staging)
- [ ] Launch server with staging mainnet RPCs and test mint/accounts
- [ ] Verify escrow ATA exists and has seed funding for payouts
- [ ] Verify treasury/jackpot ATAs exist
- [ ] Verify reconcilers idle correctly and respect feature flags
- [ ] Execute synthetic race lifecycle on staging (no real funds)

## Production Cutover Steps (to execute later)
- [ ] Enable `maintenanceMode` and confirm only anchored OPEN race proceeds
- [ ] Drain background workers gracefully (race timers continue for in-flight)
- [ ] Set environment variables for mainnet
- [ ] Restart server(s)
- [ ] On boot: ensure `RACE_MINT` recognized; escrow ATA materialized
- [ ] Validate RPC health and rate limits
- [ ] Create a small test race and perform end-to-end lifecycle with small amounts

## Post-Start Validation
- [ ] Confirm commitments and confirmations are healthy under load
- [ ] Verify payouts recorded in `settlement_transfers` and visible on-chain
- [ ] Verify per-user receipts and leaderboard aggregation
- [ ] Check jackpot accounting moves in DB only (no on-chain jackpot transfer)
- [ ] Run reconciliation job for ledger vs escrow balances; expect no discrepancies

## Rollback Plan
- [ ] If critical issue: enable `maintenanceMode`
- [ ] Cancel upcoming races; allow in-flight to settle normally
- [ ] Revert environment to devnet/staging configs
- [ ] Restore SQLite/Postgres snapshot if corruption suspected
- [ ] Postmortem before retry

## Feature Flags to Use
- `BLOCK_NEW_RACES`: prevent creation of new races
- `BLOCK_NEW_BETS`: block betting except existing anchored OPEN race
- `BLOCK_SETTLEMENTS`: pause settlement execution (idempotent to resume)
- `ENABLE_BET_RESCAN`: allow manual rescans when diagnosing

## Operational Scripts (to prep later)
- `scripts/check-escrow-balance.mjs`: read RACE balances for escrow/treasury/jackpot
- `scripts/reconcile-ledger.mjs`: compare SQLite/Postgres aggregates vs chain balances
- `scripts/enable-maintenance.mjs` / `disable-maintenance.mjs`
- `scripts/rotate-escrow-key.mjs` (future): safe rotation with hot/warm wallet handoff
