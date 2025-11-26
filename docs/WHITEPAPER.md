## Pump Racers Whitepaper

### Abstract
Pump Racers is a parimutuel, price-velocity prediction market built on Solana that turns live Pump.fun meme coins into "runners" in time-boxed races. Participants stake SOL to predict which runner will outperform the rest during a defined window. Settlement is provably transparent and verifiable via GeckoTerminal price data. A 5% rake on SOL bets funds the protocol treasury and a rolling jackpot, while Edge Points reward power users based on performance, efficiency, and pot size. The platform also features RACESwap, a built-in token swap interface with automatic reflection buys that rewards recent race winners.

### Overview
- **Network**: Solana (mainnet)
- **Market Type**: Parimutuel pool; winners split prize pool proportionally
- **Unit of Account**: SOL (native Solana currency, 9 decimals)
- **Rake**: 5% of total pot per race for SOL bets (3% treasury, 2% jackpot)
- **Verification**: Single-source USD feeds from GeckoTerminal plus OHLCV-based post-race verification links
- **Edge Points**: Non-transferable reward points accruing to user accounts, redeemable in future programs funded by rake
- **RACESwap**: Built-in Jupiter-powered swap interface with automatic 1% reflection buys to recent race winners and 0.2% treasury fee

### Current Implementation: SOL Betting
The platform currently operates using SOL (native Solana currency) as the unit of account for all bets and payouts. This provides:
- **Immediate liquidity**: No need for token swaps before betting
- **Lower friction**: Users can bet directly with SOL from their wallets
- **Transparent economics**: All settlements and payouts in native SOL
- **Future expansion**: Support for $RACE token betting is planned for future releases

**Note**: The $RACE token will be introduced in a future update, enabling additional utility and governance features. When implemented, it will support:
- Fee-rebate tiers and airdrops
- Governance voting rights
- Enhanced Edge Points redemption programs

### Core Mechanics
Pump Racers operates parimutuel pools per race:
1. Users place predictions by staking SOL on one of the listed runners during the OPEN window.
2. At LOCK, the protocol captures a USD baseline price for every runner.
3. During IN_PROGRESS, price changes are tracked relative to baseline.
4. At SETTLED, the runner with the highest percentage gain wins; winners split the prize pool pro-rata.
5. A fixed 5% rake is taken from SOL bets; a jackpot can roll over and optionally be paid out on designated races.

Mathematical outline:
- Let P be the total pot.
- Rake = 5% of P (for SOL bets). PrizePool = (P − Rake) + JackpotPayout.
- Winner share for wallet w on the winning runner = PrizePool × (w's winning stake / total winning stakes).
- Payouts are rounded down to 9 decimals (SOL precision).

### Rake and Treasury
- **Rake**: 5% of the pot per race for SOL bets, parameterized as 500 bps.
- **Split**:
  - 3% of pot (60% of rake) → Treasury
  - 2% of pot (40% of rake) → Jackpot contribution (retained in escrow accounting)
- **Jackpot**:
  - Accumulates from the 2% rake component
  - Payouts occur only on races flagged as jackpot races
  - Jackpot contributions are accounted for in database/escrow and not separately transferred on-chain at settlement time

### RACESwap: Token Swapping with Reflection Mechanism
RACESwap is a built-in token swap interface powered by Jupiter that enables users to swap SOL (or other tokens) for meme tokens directly within the Pump Racers platform. The feature includes an innovative reflection mechanism that automatically rewards recent race winners.

**How RACESwap Works:**
1. Users select input and output tokens via the swap interface
2. The swap amount is split into three components:
   - **Main Swap** (98.8%): Executes the primary swap to the desired output token
   - **Reflection Buy** (1.0%): Automatically purchases the token from the most recent race winner
   - **Treasury Fee** (0.2%): Contributed to the protocol treasury

**Reflection Mechanism:**
- The reflection buy automatically purchases tokens from the winner of the most recently settled race
- This creates a positive feedback loop where winning tokens receive additional buy pressure
- The reflection token is dynamically updated after each race settlement
- If no recent winner exists or the reflection is disabled, the reflection amount merges into the main swap

**Fees:**
- **Reflection Fee**: 1.00% (100 bps) of swap amount - automatically buys winner token
- **Treasury Fee**: 0.20% (20 bps) of swap amount - funds protocol operations
- **Total Fees**: 1.20% of swap amount

**Technical Implementation:**
- Built on Jupiter's swap infrastructure for optimal routing and liquidity
- Uses Anchor program (RACESwap V3) for on-chain execution
- Supports versioned transactions with address lookup tables for efficiency
- Minimum swap amount: 0.01 SOL (to ensure meaningful reflection amounts)
- Includes CSGO-style crate animation showing the meme token received

**Benefits:**
- Seamless token acquisition without leaving the platform
- Automatic support for winning tokens through reflection buys
- Transparent fee structure with clear treasury contribution
- Enhanced user experience with visual feedback (crate animation)

### Race Lifecycle and Phase Timing
Internal state machine enforces strict transitions:
- **OPEN**
  - Betting is open.
  - Duration defaults to PROGRESS window plus a 30s buffer (UI typically shows ~20m30s by default).
  - Only one race can be active (LOCKED/IN_PROGRESS) at a time; OPEN races may delay locking if another race is live.

- **LOCKED**
  - Betting closed; baseline price captured for each runner via GeckoTerminal.
  - Short 2s grace to transition to IN_PROGRESS.

- **IN_PROGRESS**
  - Price tracking live.
  - Default duration: 20 minutes (configurable via `PROGRESS_WINDOW_MINUTES`).

- **SETTLED**
  - Winner determined as the runner with highest percentage price increase from baseline to final.
  - Parimutuel settlement executed: rake transferred, jackpot accounted, winners paid.

- **CANCELLED**
  - All bets refunded; used only when operationally necessary.

Configurable (environment):
- `OPEN_WINDOW_MINUTES` (optional): Explicit OPEN duration override.
- `PROGRESS_WINDOW_MINUTES`: IN_PROGRESS window length (default 20).
- `TRANSITION_GRACE_MS`: Small grace for safe transitions (default 5000ms).

### Runners and Eligible Markets
Runners are Pump.fun meme coins. For each runner we track:
- Mint, name, symbol, logo
- USD baseline price and timestamp at LOCK
- GeckoTerminal pool address and chart URL

Liquidity-sensitive pool selection:
- For each mint, best pool is selected by sorting pools by 24h volume and reserve (liquidity), prioritizing deep and active markets.
- This reduces manipulation risk and improves price quality.

### Price Feeds and Verification
- **Single Source of Truth**: Live USD prices sourced from GeckoTerminal across Solana pools; no mixed quotes or alternate sources.
- **Baseline and Final Prices**: Captured at LOCK and SETTLED respectively using live price endpoints.
- **Post-Race Verification**: Minute-level OHLCV is fetched for the dominant pool around the race window. We compute start/end prices and % change and expose a clickable GeckoTerminal chart URL for independent inspection.

Verification method (high level):
1. Resolve best pool for each token by volume and liquidity.
2. Fetch minute OHLCV over [start−5m, end+5m].
3. Take the nearest candle at/after start as baseline (open), and the last candle at/before end as final (close).
4. Compute % change = (final − start) / start.
5. Mark verified if at least two data points exist; surface the chart URL for public review.

Display in UI:
- Each runner includes a "View on GeckoTerminal" link to the pool chart.
- A "Verified" badge is shown when sufficient OHLCV data supports the settlement window.

### Settlement and Payouts
At SETTLED:
- Compute total pot P and rake (500 bps for SOL bets).
- Split rake into Treasury (60%) and Jackpot contribution (40%).
- If jackpot race, add current jackpot balance to prize pool and reset accounted payout portion.
- Identify winning bets and distribute prize pool pro-rata.
- Transfer rake to treasury account; payouts to winners from escrow; jackpot contribution remains accounted in escrow.
- Record settlement transfers and per-wallet results for leaderboards and analytics.

Numerical considerations:
- SOL precision is 9 decimals (lamports); payouts are rounded down to 9 decimals.
- Transfers and calculations use Decimal arithmetic to avoid floating-point drift.

### Edge Points: Power-User Rewards
Edge Points score user performance across races and will be redeemable in future programs financed by the protocol's rake.

Scoring (per race, simplified):
- Base: 1,000 points; +5,000 if the user wins (has a positive payout).
- Bet contribution: 1,500 × sqrt(betAmount).
- Payout contribution: 2,500 × sqrt(payoutAmount).
- Efficiency: min(5, payout/bet) × 1,000.
- Pot multiplier: points × [1 + min(1, totalPot/1000) × 0.25].
- Loss scaling: ×0.7 on losses; minimum floor 500 points.

Design rationale:
- Rewards intelligent risk-taking and efficiency rather than raw size.
- Damps whale dominance via square-root scaling.
- Encourages participation in deeper, more competitive pots.

Future utility (examples):
- Tiered fee rebates and boosted jackpot tickets
- Airdrop eligibility and allowlist priority
- Governance signaling weight alongside $RACE holdings

### Security, Fairness, and Operations
- Strict state machine disallows illegal transitions and ensures only one active race at a time.
- Baseline prices are captured at LOCK to prevent "late betting."
- All pricing is from a single USD source to avoid quote skew.
- GeckoTerminal OHLCV is cached shortly to reduce load while remaining independently verifiable.
- Treasury and jackpot balances are tracked, with rake transfers executed and recorded.

Operational controls:
- Admin panel can create races, lock, and cancel when necessary.
- Faucet and dev tooling exist for non-production environments.

### Configuration
Key environment variables:
- `RPC_URL`: Solana RPC endpoint.
- `OPEN_WINDOW_MINUTES`, `PROGRESS_WINDOW_MINUTES`, `TRANSITION_GRACE_MS`: Phase timings.
- `RACESWAP_PROGRAM_ID`: On-chain RACESwap program address.
- `RACESWAP_TREASURY_WALLET`: Treasury wallet for RACESwap fees.
- `RACESWAP_REFLECTION_FEE_BPS`: Reflection fee in basis points (default 100 = 1.00%).
- `RACESWAP_TREASURY_FEE_BPS`: Treasury fee in basis points (default 20 = 0.20%).
- GeckoTerminal access is via HTTPS; no private key is required for read-only data.

### Roadmap (Indicative)
- ✅ Mainnet launch with SOL betting
- ✅ RACESwap integration with reflection mechanism
- Advanced runner curation and risk filters (liquidity thresholds, age gates)
- On-chain verifiable settlement commitments and public proofs
- Edge Points redemption, fee tiers, and partner perks
- $RACE token integration for enhanced utility and governance
- Community governance around rake, jackpot cadence, and runner lists

### Disclaimers
- This product is experimental software. Markets can be volatile and illiquid.
- Jurisdictional restrictions may apply; users are responsible for compliance with local laws.
- Token swaps via RACESwap are subject to market conditions and slippage.

### Appendix: References
- State machine and timing: `server/race-state-machine.ts`
- Settlement and rake math: `server/settlement.ts`
- Edge Points formula: `server/edge-points.ts`
- GeckoTerminal integration and OHLCV verification: `server/geckoterminal.ts`
- Live price sourcing for runners: `server/prices.ts`
- RACESwap implementation: `server/raceswap.ts`, `client/src/lib/raceswap-v3.ts`
