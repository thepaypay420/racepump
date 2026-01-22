## Pump Racers Whitepaper

### Abstract
Pump Racers is a parimutuel, price-velocity prediction market built on Solana that turns live Pump.fun meme coins into "runners" in time-boxed races. Participants stake SOL to predict which runner will outperform the rest during a defined window. Settlement is provably transparent and verifiable via GeckoTerminal price data. A 5% rake on SOL bets funds the protocol treasury and a rolling jackpot, while Edge Points reward power users based on performance, efficiency, and pot size. The platform also features Swap&Rip, a built-in token swap interface powered by Jupiter. Swap&Rip includes an innovative Pokémon Card Drops system where every qualifying swap has a chance to win real, professionally graded Pokémon cards held in the on-chain RaceBank treasury—all determined by a provably fair cryptographic roll. $RACE token holders receive boosted drop probabilities (up to 2x at the 20M tier), incentivizing long-term holding and community participation.

### Overview
- **Network**: Solana (mainnet)
- **Market Type**: Parimutuel pool; winners split prize pool proportionally
- **Unit of Account**: SOL (native Solana currency, 9 decimals)
- **Rake**: 5% of total pot per race for SOL bets (3% treasury, 2% jackpot)
- **Verification**: Single-source USD feeds from GeckoTerminal plus OHLCV-based post-race verification links
- **Edge Points**: Non-transferable reward points accruing to user accounts, redeemable in future programs funded by rake
- **Swap&Rip**: Built-in Jupiter-powered swap interface with Pokémon Card Drops on every qualifying swap
- **Card Drops**: Provably fair NFT reward system where users can win real, graded Pokémon cards with qualifying swaps (~1 in 80 per 1 SOL)
- **RACE Boosts**: $RACE token holders receive up to 2x boosted drop probabilities across all reward types

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

### Swap&Rip: Token Swapping with Pokémon Card Drops
Swap&Rip is the built-in token swap interface powered by Jupiter that enables users to swap SOL (or other tokens) for meme tokens directly within the Pump Racers platform. Every qualifying swap gives users a chance to win real, professionally graded Pokémon cards from the on-chain RaceBank treasury.

**How Swap&Rip Works:**
1. Users select input and output tokens via the swap interface
2. Jupiter aggregator finds the best route and executes the swap
3. A small fee is collected for the protocol treasury and card drop pool
4. After successful swap confirmation, the system rolls for a Pokémon card drop
5. Winners receive their card NFT directly to their wallet

**Technical Implementation:**
- Built on Jupiter's swap infrastructure for optimal routing and liquidity
- Browser based UltraV3 on-chain execution
- Supports versioned transactions with address lookup tables for efficiency
- Minimum swap amount: 0.1 SOL (to qualify for card drops)
- Includes crate-opening animation when a card is won

**Benefits:**
- Seamless token acquisition without leaving the platform
- Chance to win real, valuable Pokémon cards with every swap
- Transparent and provably fair drop system
- Enhanced user experience with visual feedback (crate animation)

### Pokémon Card Drops: NFT Reward System
Swap&Rip includes an innovative NFT reward system where users can win real, professionally graded Pokémon cards with every qualifying swap. These physical cards are tokenized as Solana NFTs and held in the protocol's on-chain treasury (`racebank.sol`), enabling verifiable, transparent, and provably fair distribution.

**Overview:**
- Cards are real, physical Pokémon cards that have been professionally graded (typically PSA-graded)
- Each card is tokenized as a unique NFT on Solana with on-chain metadata
- Cards are held in the RaceBank treasury wallet (`6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u`)
- The card pool is dynamically managed: won cards are immediately removed from the droppable pool
- Card metadata includes: name, set, grade, insured value (USD), and high-resolution images

**Eligibility Requirements:**
- Minimum swap size: **0.1 SOL** or **$10 USDC** equivalent (configurable via environment)
- The swap must be a recognized swap transaction (anti-spoofing verified on-chain)
- Swaps executed through Jupiter aggregator with referral fee payment
- Protocol and escrow swaps are not eligible (prevents gaming the system)

**Drop Probability Calculation:**
The probability of winning a card scales linearly with swap size, measured in SOL-equivalent value:

```
Base Probability = (Swap USD Value / SOL Price USD) / 80
Final Probability = min(Base Probability × Holder Boost Multiplier, 0.25)
```

- **Base Rate**: 1 in 80 per 1 SOL swap (~1.25% chance per SOL)
- **Maximum Cap**: 25% per swap (prevents guaranteed wins on large swaps)
- **Scaling**: Larger swaps proportionally increase odds up to the cap
- **Holder Boost**: $RACE token holders receive multiplied probabilities (see RACE Boosts section)

**Example Probabilities (at 1x boost):**
| Swap Size | Approximate Odds | Probability |
|-----------|-----------------|-------------|
| 1 SOL     | 1 in 80         | ~1.25%      |
| 5 SOL     | 1 in 16         | ~6.25%      |
| 10 SOL    | 1 in 8          | ~12.5%      |
| 20+ SOL   | 1 in 4          | 25% (capped)|

**Card Selection Process:**
When a user wins a card drop, the specific card is selected from the available pool using a provably fair mechanism:

1. **Pool Hash**: A SHA-256 hash of all available card mints (sorted alphabetically) is computed
2. **Pick Roll**: A deterministic random value derived from `SHA-256("card-pick" | seed | signature | recipient)`
3. **Index Selection**: `Pick Index = floor(Pick Roll × Pool Size)`
4. **Delivery**: The card at the selected index is transferred to the winner's wallet

The pool hash and pick roll are published in the swap receipt for independent verification.

**Provably Fair Roll System:**
All card drops use a cryptographically verifiable random number generation system:

1. **Seed Generation**: The server uses the transaction's blockhash (if available) or the transaction signature as the seed
2. **Roll Calculation**: `Roll = SHA-256("card" | seed | signature | recipient) → first 4 bytes as uint32 / 0xFFFFFFFF`
3. **Win Condition**: `Roll < Win Probability`
4. **Verification**: Users can independently compute the roll using the provided seed and signature

```javascript
// Verification snippet (Node.js)
const crypto = require('crypto');
const seed = '<blockhash_or_signature>';
const sig = '<transaction_signature>';
const recipient = '<wallet_address>';
function roll(label) {
  const h = crypto.createHash('sha256')
    .update(`${label}|${seed}|${sig}|${recipient}`)
    .digest();
  return h.readUInt32BE(0) / 0xffffffff;
}
console.log({ card: roll('card'), pick: roll('card-pick') });
```

**Card Metadata and Display:**
Each card in the treasury includes rich metadata:
- **Name**: Full card name (e.g., "1999 Pokémon Base Set Charizard Holo #4")
- **Set**: The Pokémon TCG set (e.g., "Base Set", "Jungle", "Rocket")
- **Grade**: Professional grading score (e.g., "PSA 10", "PSA 9")
- **Insured Value**: USD value for insurance purposes, reflecting market value
- **Image**: High-resolution scan of the physical graded card

Metadata is stored on decentralized storage (Arweave/IPFS) and linked via Metaplex Token Metadata standard.

**Treasury Management:**
- **RaceBank Wallet**: `6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u` (racebank.sol)
- **Pool Tracking**: PostgreSQL database tracks enabled/sent status of each card
- **Real-time Updates**: Won cards are immediately marked as "sent" and removed from the droppable pool
- **Allowlist**: Server maintains an allowlist of valid card mints to prevent unauthorized additions
- **Verification**: Users can verify treasury holdings on Solscan at any time

**Card Delivery:**
When a user wins a card:
1. The server selects a card from the available pool using the provably fair pick roll
2. An SPL token transfer is executed from the RaceBank wallet to the winner's wallet
3. The card is marked as "sent" in the database (preventing double-drops)
4. A Telegram notification is sent to the community celebrating the win
5. The receipt includes the card mint address and transfer signature for verification

**Notifications:**
- **Instant Win Alerts**: Telegram notifications announce card wins with card details, winner address, and swap value
- **Scheduled Roll Posts**: Twice-daily "Card Winners Roll" posts showcase recent winners
- **Receipt Details**: Full provably fair verification data included in swap receipts

### RACE Boosts: Holder Reward Multipliers
$RACE token holders receive boosted probabilities on all Swap&Rip rewards, including card drops and $RACE token rewards. The boost system incentivizes holding $RACE while providing tangible benefits to loyal community members.

**Boost Tier System:**
Boost multipliers are determined by the user's $RACE token balance, verified on-chain at the time of each swap:

| Tier | $RACE Balance | Multiplier | Card Drop Odds (1 SOL) |
|------|--------------|------------|------------------------|
| None | < 1M         | 1.00x      | 1 in 80 (~1.25%)       |
| 1M   | 1M - 5M      | 1.10x      | 1 in 73 (~1.38%)       |
| 5M   | 5M - 10M     | 1.25x      | 1 in 64 (~1.56%)       |
| 10M  | 10M - 20M    | 1.50x      | 1 in 53 (~1.88%)       |
| 20M  | 20M+         | 2.00x      | 1 in 40 (~2.50%)       |

**How Boosts Work:**
1. **Balance Verification**: When a swap reward is processed, the server queries the user's $RACE token balance on-chain
2. **Tier Determination**: The balance is compared against tier thresholds to determine the applicable multiplier
3. **Probability Scaling**: The base drop probability is multiplied by the boost multiplier
4. **Cap Enforcement**: The final probability is still capped at 25% maximum per swap

**Mathematical Application:**
For card drops:
```
Final Card Probability = min(Base Probability × Boost Multiplier, 0.25)
```

For $RACE token rewards (partial boost application):
```
RACE Boost Effect = 1 + (Boost Multiplier - 1) × 0.5
Final RACE Probability = min(Base RACE Probability × RACE Boost Effect, 0.08)
```

Note: $RACE reward probability receives 50% of the boost effect to maintain sustainable economics.

**Boost Benefits Summary:**
- **Card Drops**: Full multiplier applied (up to 2x at 20M tier)
- **$RACE Rewards**: Partial multiplier applied (up to 1.5x effective at 20M tier)
- **Tier Progress**: UI shows progress toward the next tier and target balance

**Example Scenarios:**

*Scenario 1: User with 3M $RACE swaps 5 SOL*
- Tier: 1M (1.10x multiplier)
- Base probability: 5/80 = 6.25%
- Boosted probability: 6.25% × 1.10 = 6.875%
- Odds: ~1 in 15

*Scenario 2: User with 15M $RACE swaps 10 SOL*
- Tier: 10M (1.50x multiplier)
- Base probability: 10/80 = 12.5%
- Boosted probability: 12.5% × 1.50 = 18.75%
- Odds: ~1 in 5

*Scenario 3: User with 25M $RACE swaps 20 SOL*
- Tier: 20M (2.00x multiplier)
- Base probability: 20/80 = 25% (already at cap)
- Boosted probability: 25% × 2.00 = 50% → capped at 25%
- Odds: 1 in 4 (cap enforced)

**On-Chain Verification:**
- Balance queries use the mainnet RPC endpoint for accurate, real-time verification
- Token accounts are queried using both SPL Token and Token-2022 program IDs
- Balances are cached for 20 seconds to reduce RPC load while maintaining freshness
- The verified boost tier and balance are included in the swap receipt for transparency

**Progression Display:**
The UI displays:
- Current tier and multiplier
- Progress bar toward the next tier
- Target balance for the next tier
- Real-time odds calculation based on current boost

**Anti-Gaming Measures:**
- Balance is verified server-side at swap time (not trusting client-reported values)
- Short cache TTL ensures balance changes are reflected quickly
- Cap prevents excessive advantage on large swaps regardless of boost level

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
- `RACESWAP_PROGRAM_ID`: On-chain Swap&Rip program address.
- `RACESWAP_TREASURY_WALLET`: Treasury wallet for Swap&Rip fees.
- `RACESWAP_DROP_MIN_SOL`: Minimum SOL for card drop eligibility (default 0.1).
- `RACESWAP_DROP_MIN_USDC`: Minimum USDC for card drop eligibility (default 10).
- GeckoTerminal access is via HTTPS; no private key is required for read-only data.

### Roadmap (Indicative)
- ✅ Mainnet launch with SOL betting
- ✅ Swap&Rip integration with Jupiter aggregator
- ✅ Pokémon Card Drops with provably fair NFT distribution
- ✅ RACE Boosts holder reward system (1M/5M/10M/20M tiers)
- Advanced runner curation and risk filters (liquidity thresholds, age gates)
- On-chain verifiable settlement commitments and public proofs
- Edge Points redemption, fee tiers, and partner perks
- Expanded card treasury with additional collectible categories
- $RACE token integration for enhanced utility and governance
- Community governance around rake, jackpot cadence, and runner lists

### Disclaimers
- This product is experimental software. Markets can be volatile and illiquid.
- Jurisdictional restrictions may apply; users are responsible for compliance with local laws.
- Token swaps via Swap&Rip are subject to market conditions and slippage.
- Card drops are not guaranteed; probability-based rewards are subject to cryptographic randomness.
- Physical card redemption (if offered) may be subject to shipping restrictions and verification requirements.
- $RACE token holdings for boost verification are checked on-chain and may be subject to network latency.

### Appendix: References
- State machine and timing: `server/race-state-machine.ts`
- Settlement and rake math: `server/settlement.ts`
- Edge Points formula: `server/edge-points.ts`
- GeckoTerminal integration and OHLCV verification: `server/geckoterminal.ts`
- Live price sourcing for runners: `server/prices.ts`
- Swap&Rip implementation: `server/raceswap.ts`, `client/src/lib/raceswap-v3.ts`
- Swap rewards and boosts: `server/raceswap-swap-rewards.ts`, `server/routes.ts` (`/api/raceswap/swap-rewards`)
- Card drop notifications: `server/card-notifications.ts`
- Pokémon card metadata: `client/src/lib/pokemon-cards.ts`
- Card drops UI: `client/src/pages/CardDrops.tsx`, `client/src/components/PokemonCardRail.tsx`
- Provably fair verification: `client/src/components/ProvablyFairVerifyDialog.tsx`
- Crate animation: `client/src/components/RaceswapCardCrate.tsx`
- Mobile card showcase: `client/src/components/MobileCardShowcase.tsx`

### Appendix: Configuration Reference

**Card Drop Configuration (Environment Variables):**
- `RACESWAP_DROP_MIN_SOL`: Minimum SOL amount for card drop eligibility (default: 0.1)
- `RACESWAP_DROP_MIN_USDC`: Minimum USDC amount for card drop eligibility (default: 10)
- `CARD_DROP_ONE_IN_PER_SOL`: Base probability denominator per 1 SOL (default: 80, meaning 1 in 80)
- `CARD_DROP_PROBABILITY_CAP`: Maximum probability cap (default: 0.25, meaning 25%)

**Boost Tier Thresholds (Hardcoded):**
| Variable | Value | Multiplier |
|----------|-------|------------|
| Tier 1M  | 1,000,000 $RACE | 1.10x |
| Tier 5M  | 5,000,000 $RACE | 1.25x |
| Tier 10M | 10,000,000 $RACE | 1.50x |
| Tier 20M | 20,000,000 $RACE | 2.00x |

**Treasury Addresses:**
- RaceBank NFT Treasury: `6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u`
- Swap&Rip Treasury: Configured via `RACESWAP_TREASURY_WALLET` environment variable
