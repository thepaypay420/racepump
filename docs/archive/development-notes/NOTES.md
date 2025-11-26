# Operational notes: GeckoTerminal usage, timing, and flicker-free transitions

## Rate-limit math and budgets
- Public GeckoTerminal limit: 30 req/min/IP (~1 req/2s). We enforce a MIN_TIME_MS gap based on `GECKO_RPM` (default 30).
- Concurrency: `GECKO_CONCURRENCY` (default 1) to stay polite and avoid burst 429s.
- Global backoff: on 429, honor Retry-After (seconds) or fallback to ~5s with jitter.

## Centralized client behavior
- Priority scheduling with coalescing:
  - `priority`: high | normal | low. High is used for lock/settle sampling. Low is used for periodic background price updates.
  - Identical in-flight URLs are coalesced; callers join the same promise. Logs show JOIN events when `GT_LOG=1`.
- Endpoint TTLs (response cache, not the per-mint price cache):
  - trending_pools: 20s
  - pools/: 10s
  - ohlcv/minute: 60s
  - search/pools: 300s
  - Override via `cacheTtlSeconds`, bypass via `skipCache`.
- Per-mint price cache TTL: default 5s dev / 30s prod (tunable via `PRICE_CACHE_TTL_SECONDS`).

## Priority usage
- Lock (t0): high priority with up to 3 quick retries (200ms, 350ms, 500ms with jitter). Missing samples reuse last good price with a warning; do not block locking.
- Settle (t1): high priority with up to 3 quick retries (300ms, 550ms, 800ms with jitter). If any samples missing, settlement is deferred (throws) so timers/watchdog retry; never revert state.
- Price updater: low priority every 5s; respects global RPM and yields to high-priority sampling.

## Observability
- Enable granular logs: set `GT_LOG=1`.
  - Logs show cache HIT/MISS, coalesce JOINs, GET lines, and 429 backoff.
- Stats: `getGeckoStats()` exposes cacheHits, cacheMisses, coalescedJoins, networkRequests for tests.
- Transition logs (already present) include status changes and timing targets to verify single visible flips.

## Flicker-free guidance (manual test)
1. Start server in dev: `npm run dev`.
2. Open Lobby; cards should use server-provided `timing` (`targetTs`, `uiTargetTs`) and labels; expect each race to change status once at boundaries.
3. Observe that the client UI does not predict states; it follows SSE + API fields. Minor debounce is acceptable.
4. Lock boundary: verify no bouncing between OPEN/LOCKED. IN_PROGRESS appears ~2s after LOCKED, once.
5. Settle boundary: race transitions directly to SETTLED when t1 sampling completes.

## Knobs
- `GECKO_RPM`: overall RPM (default 30)
- `GECKO_CONCURRENCY`: parallelism (default 1)
- `PRICE_CACHE_TTL_SECONDS`: per-mint price cache TTL (default 5 dev / 30 prod)
- `GT_LOG=1`: enable detailed logs

## Testing scope
- `test-gecko-client.js`: coalescing smoke test ensures many callers → few network requests.
- `test-race-transitions.js`: validates deterministic transitions; state machine uses authoritative timestamps.
- Timer/watchdog: on server restarts, reconciliation catches races up to expected statuses based on timestamps; no backward moves.