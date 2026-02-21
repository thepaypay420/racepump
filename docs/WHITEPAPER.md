## Swap&Rip/racepump Whitepaper

### Abstract
Swap&Rip is a Solana-native token swap interface powered by Jupiter that rewards every qualifying trade with a chance to win real, professionally graded Pokémon cards. A 2.5% fee on each swap funds the reward pool, and a provably fair cryptographic roll determines whether the user wins a card. Won cards are delivered as Solana NFTs backed 1:1 by physical graded cards held in secure vaults by Collector Crypt — redeemable at any time for the real card shipped to the winner's door. $RACE token holders receive boosted drop probabilities (up to 2x at the 20M tier), incentivizing long-term holding and community participation.

### Overview
- **Network**: Solana (mainnet)
- **Swap Engine**: Jupiter aggregator (UltraV3) — best-route execution across all Solana liquidity
- **Fee**: 2.5% of total swap value, funding the Pokémon Card Drop reward pool
- **Card Drops**: Provably fair NFT reward system — ~1 in 80 chance per 1 SOL swapped
- **Cards**: Real, PSA/CGC/Beckett-graded Pokémon cards tokenized as Solana NFTs via Collector Crypt
- **Redemption**: Full physical redemption through Collector Crypt — any card NFT can be exchanged for the real graded card, shipped worldwide
- **RACE Boosts**: $RACE token holders receive up to 2x boosted drop probabilities
- **Treasury**: RaceBank wallet (`racebank.sol`) holds card NFTs on-chain, verifiable by anyone

### How Swap&Rip Works
1. User selects input and output tokens via the swap interface
2. Jupiter aggregator finds the best route and executes the swap
3. A 2.5% fee is collected, funding the card drop reward pool
4. After successful swap confirmation, the system rolls for a Pokémon card drop
5. If the user wins, a card NFT is transferred directly to their wallet
6. The winner can hold, trade, or redeem the NFT for the physical graded card through Collector Crypt

**Technical Implementation:**
- Built on Jupiter's swap infrastructure for optimal routing and liquidity
- Browser-based UltraV3 on-chain execution
- Supports versioned transactions with address lookup tables for efficiency
- Minimum swap amount: 0.1 SOL (to qualify for card drops)
- Crate-opening animation plays when a card is won

### Pokémon Card Drops

Every qualifying swap rolls for a chance to win a real, professionally graded Pokémon card. These physical cards are tokenized as Solana NFTs by Collector Crypt and held in the protocol's on-chain treasury (`racebank.sol`), enabling verifiable, transparent, and provably fair distribution.

**The Cards:**
- Real, physical Pokémon cards professionally graded by PSA, CGC, or Beckett
- Each card is tokenized as a unique pNFT on Solana with on-chain metadata by Collector Crypt
- Cards are held in the RaceBank treasury wallet (`6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u`)
- The card pool is dynamically managed: won cards are immediately removed from the droppable pool
- Card metadata includes: name, set, grade, insured value (USD), and high-resolution images of the actual graded slab

**Eligibility Requirements:**
- Minimum swap size: **0.1 SOL** or **$10 USDC** equivalent (configurable)
- The swap must be a recognized swap transaction (anti-spoofing verified on-chain)
- Swaps executed through Jupiter aggregator with fee payment
- Protocol and escrow swaps are not eligible (prevents gaming the system)

### Drop Probability

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

### Provably Fair Roll System

All card drops use a cryptographically verifiable random number generation system. Every roll can be independently verified by anyone.

**Roll Calculation:**
1. **Seed Generation**: The server uses the transaction's blockhash (if available) or the transaction signature as the seed
2. **Roll Calculation**: `Roll = SHA-256("card" | seed | signature | recipient) → first 4 bytes as uint32 / 0xFFFFFFFF`
3. **Win Condition**: `Roll < Win Probability`
4. **Verification**: Users can independently compute the roll using the provided seed and signature

```javascript
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

**Card Selection Process:**
When a user wins a card drop, the specific card is selected from the available pool:

1. **Pool Hash**: A SHA-256 hash of all available card mints (sorted alphabetically) is computed
2. **Pick Roll**: A deterministic random value derived from `SHA-256("card-pick" | seed | signature | recipient)`
3. **Index Selection**: `Pick Index = floor(Pick Roll × Pool Size)`
4. **Delivery**: The card NFT at the selected index is transferred to the winner's wallet

The pool hash and pick roll are published in the swap receipt for independent verification.

### Fee Structure & Reward Pool Economics

**The 2.5% Fee:**

Every qualifying swap is charged a 2.5% fee on total swap value. This fee funds the entire card drop reward pool — card inventory acquisition from Collector Crypt, NFT operations, and prize fulfillment. The fee is transparent: swap, pay 2.5%, and every qualifying swap rolls for a card.

**Why 2.5%:**

The fee and the drop probability are a coupled system. For the reward pool to stay solvent, fee revenue per swap must exceed the expected card payout:

```
Fee Revenue per SOL = 0.025 × SOL Price (USD)
Expected Card Cost per SOL = Average Card Value / 80

Solvency Condition: 0.025 × SOL Price > Avg Card Value / 80
→ Avg Card Value < 2.0 × SOL Price
```

**Current pool snapshot (live data):**

| Metric | Value |
|--------|-------|
| Total cards in treasury | 59 |
| Currently droppable | 56 |
| Already won/sent | 3 |
| Total droppable pool value | $4,234 |
| Average card value (droppable) | $75.61 |
| Median card value | $45.00 |
| Min / Max card value | $5 / $1,217 |

**Value distribution:**

| Bracket | Cards | Avg Value | Total Value |
|---------|-------|-----------|-------------|
| $0 - $25 | 14 | $16 | $224 |
| $25 - $50 | 19 | $39 | $742 |
| $50 - $100 | 15 | $69 | $1,029 |
| $100 - $200 | 6 | $132 | $794 |
| $200 - $500 | 1 | $228 | $228 |
| $500+ | 1 | $1,217 | $1,217 |

**Solvency check at $86 SOL:**

| Metric | Value |
|--------|-------|
| Fee per 1 SOL swap (2.5%) | $2.15 |
| Expected card cost per SOL | $0.95 (avg $75.61 / 80) |
| **Margin per SOL** | **$1.20** |
| **Margin %** | **56.0%** |
| Solvency ceiling | $172 avg card value |
| Actual avg | $75.61 |
| Headroom | $96.39 (56% under ceiling) |

The pool is **solidly profitable at $86 SOL** with a 56% margin. The $1,217 Dark Gengar (1st Edition PSA 8 Neo Destiny) is the highest-value card in the pool, but the other 55 cards averaging $54.85 absorb it well — the weighted average stays at $75.61, well under the $172 ceiling.

**Scenario: Dark Gengar moved to reserve**

If the $1,217 card were moved to reserve (holding it in treasury but removing from the droppable pool), the remaining 55 cards would average $54.85 with a 68.1% margin. This is an option if SOL price drops significantly further, but at $86 SOL the full pool including the Dark Gengar is sustainable.

**SOL price sensitivity:**

| SOL Price | Fee per SOL | Solvency Ceiling | Current Avg ($75.61) | Margin |
|-----------|-------------|------------------|---------------------|--------|
| $50 | $1.25 | $100 | $75.61 | 24% — tight but solvent |
| **$86** | **$2.15** | **$172** | **$75.61** | **56% — current, healthy** |
| $120 | $3.00 | $240 | $75.61 | 68% — comfortable |
| $150 | $3.75 | $300 | $75.61 | 75% — wide margin |
| $200 | $5.00 | $400 | $75.61 | 81% — very wide |

Even at $50 SOL the pool remains solvent at current composition, though with thin margins. Below ~$38 SOL the current pool average would exceed the ceiling and require curation (moving higher-value cards to reserve).

**Active pool curation:** The protocol manages solvency by curating which cards are in the *active droppable pool* vs held in reserve:

1. **Active pool**: Cards currently eligible for drops. The weighted avg must stay below the solvency ceiling at the current SOL price.
2. **Reserve**: Premium cards held in treasury but not droppable. These are activated when SOL price rises or when enough lower-value cards are added to absorb the average.
3. **Dynamic adjustment**: As SOL price moves, cards shift between active and reserve. Drop rates and fees never change — only pool composition adjusts.

### Physical Redemption via Collector Crypt

Every card NFT won through Swap&Rip is fully redeemable for the real, physical graded card. Redemption is handled through our partnership with **Collector Crypt** ([@Collector_Crypt](https://x.com/Collector_Crypt)), a Solana-native platform purpose-built for bridging physical collectibles and on-chain ownership.

**How Collector Crypt Works:**

Collector Crypt tokenizes professionally graded Pokémon cards (PSA, CGC, Beckett) as pNFTs on Solana. Each NFT is backed 1:1 by a real graded card stored in Collector Crypt's insured, secure vault. The NFT functions as a certificate of ownership — whoever holds the NFT owns the card.

**Redemption Process:**
1. **Win a card** through Swap&Rip — the card NFT lands in your wallet
2. **Hold or trade** — the NFT is a standard Solana pNFT, freely tradeable on any marketplace (Tensor, Magic Eden, etc.)
3. **Redeem anytime** — when ready for the physical card, initiate redemption through Collector Crypt
4. **Collector Crypt ships** — the real graded slab is pulled from their secure vault and shipped to your address worldwide
5. **NFT is burned** — upon redemption, the NFT is burned since the physical card has left the vault

**Why This Matters:**
- **Real ownership**: Every NFT is backed by a physical card sitting in a vault — not a JPEG, not a promise
- **No shipping risk while trading**: Cards change hands instantly on-chain without the risk of damage, loss, or fraud inherent in physical shipping
- **Global access**: Anyone with a Solana wallet can win, hold, trade, or redeem — no geographic restrictions on trading
- **Lower fees**: On-chain trading avoids the 13%+ fees charged by traditional marketplaces like eBay
- **Verifiable backing**: Collector Crypt's vault holdings are auditable — each NFT maps to a specific graded card with known grade, set, and insured value

**Card Metadata:**
Each card in the treasury includes rich metadata stored on decentralized storage (Arweave/IPFS) and linked via Metaplex Token Metadata standard:
- **Name**: Full card name (e.g., "1999 Pokémon Base Set Charizard Holo #4")
- **Set**: The Pokémon TCG set (e.g., "Base Set", "Jungle", "Rocket")
- **Grade**: Professional grading score (e.g., "PSA 10", "PSA 9", "CGC 8.5")
- **Insured Value**: USD value for insurance purposes, reflecting market value
- **Image**: High-resolution scan of the physical graded slab

### Treasury Management

**RaceBank Treasury:**
- **Wallet**: `6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u` (racebank.sol)
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
5. The receipt includes the card mint address, transfer signature, and full provably fair verification data

**Card Sourcing:**
New cards are continuously sourced through Collector Crypt's tokenization pipeline. Physical graded cards are deposited into Collector Crypt's vault, minted as pNFTs, and transferred to the RaceBank treasury for inclusion in the droppable pool. This creates a sustainable loop: swap fees fund card acquisition, new cards are tokenized and added to the pool, and winners can redeem physical cards through Collector Crypt.

**Notifications:**
- **Instant Win Alerts**: Telegram notifications announce card wins with card details, winner address, and swap value
- **Scheduled Roll Posts**: Twice-daily "Card Winners Roll" posts showcase recent winners
- **Receipt Details**: Full provably fair verification data included in swap receipts

### RACE Boosts: Holder Reward Multipliers

$RACE token holders receive boosted drop probabilities on card drops. The boost system incentivizes holding $RACE while providing tangible benefits to loyal community members.

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
1. **Balance Verification**: When a swap is processed, the server queries the user's $RACE token balance on-chain
2. **Tier Determination**: The balance is compared against tier thresholds to determine the applicable multiplier
3. **Probability Scaling**: The base drop probability is multiplied by the boost multiplier
4. **Cap Enforcement**: The final probability is still capped at 25% maximum per swap

```
Final Card Probability = min(Base Probability × Boost Multiplier, 0.25)
```

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

### Security and Fairness
- All drop rolls are provably fair and independently verifiable using published seeds and signatures
- Card pool integrity is maintained through a server-side allowlist of valid card mints
- Anti-spoofing verification ensures only real swap transactions qualify for drops
- Protocol and escrow wallet swaps are excluded from eligibility to prevent gaming
- Treasury holdings are publicly verifiable on Solscan at any time
- Collector Crypt's vault holdings are auditable — each NFT maps to a specific physical graded card
- $RACE balance verification is performed server-side against on-chain data, never trusting client-reported values

### Configuration

Key environment variables:
- `RPC_URL`: Solana RPC endpoint
- `RACESWAP_PROGRAM_ID`: On-chain program address
- `RACESWAP_TREASURY_WALLET`: Treasury wallet for swap fees
- `RACESWAP_DROP_MIN_SOL`: Minimum SOL for card drop eligibility (default 0.1)
- `RACESWAP_DROP_MIN_USDC`: Minimum USDC for card drop eligibility (default 10)
- `CARD_DROP_ONE_IN_PER_SOL`: Base probability denominator per 1 SOL (default: 80)
- `CARD_DROP_PROBABILITY_CAP`: Maximum probability cap (default: 0.25)

**Boost Tier Thresholds:**
| Variable | Value | Multiplier |
|----------|-------|------------|
| Tier 1M  | 1,000,000 $RACE | 1.10x |
| Tier 5M  | 5,000,000 $RACE | 1.25x |
| Tier 10M | 10,000,000 $RACE | 1.50x |
| Tier 20M | 20,000,000 $RACE | 2.00x |

**Treasury Addresses:**
- RaceBank NFT Treasury: `6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u`
- Swap Fee Treasury: Configured via `RACESWAP_TREASURY_WALLET` environment variable

### Roadmap
- Mainnet launch with Jupiter-powered swaps
- Pokémon Card Drops with provably fair NFT distribution
- RACE Boosts holder reward system (1M/5M/10M/20M tiers)
- Collector Crypt integration for full physical card redemption
- Expanded card treasury with additional sets and premium graded cards
- Partner integrations — bringing card drops to third-party trading terminals
- $RACE token utility expansion
- Additional collectible categories beyond Pokémon (sports cards, vintage collectibles)
- Community governance around drop rates, card pool curation, and partner programs

### Disclaimers
- This product is experimental software.
- Jurisdictional restrictions may apply; users are responsible for compliance with local laws.
- Token swaps are subject to market conditions and slippage.
- Card drops are not guaranteed; probability-based rewards are subject to cryptographic randomness.
- Physical card redemption through Collector Crypt may be subject to shipping restrictions, verification requirements, and Collector Crypt's terms of service.
- $RACE token holdings for boost verification are checked on-chain and may be subject to network latency.
- Card values (insured value) reflect market estimates and may fluctuate.

### Appendix: References
- Swap implementation: `server/raceswap.ts`, `client/src/lib/raceswap-v3.ts`
- Swap rewards and boosts: `server/raceswap-swap-rewards.ts`, `server/routes.ts` (`/api/raceswap/swap-rewards`)
- Card drop notifications: `server/card-notifications.ts`
- Pokémon card metadata: `client/src/lib/pokemon-cards.ts`
- Card drops UI: `client/src/pages/CardDrops.tsx`, `client/src/components/PokemonCardRail.tsx`
- Provably fair verification: `client/src/components/ProvablyFairVerifyDialog.tsx`
- Crate animation: `client/src/components/RaceswapCardCrate.tsx`
- Mobile card showcase: `client/src/components/MobileCardShowcase.tsx`
- Collector Crypt: https://collectorcrypt.com | [@Collector_Crypt](https://x.com/Collector_Crypt)
