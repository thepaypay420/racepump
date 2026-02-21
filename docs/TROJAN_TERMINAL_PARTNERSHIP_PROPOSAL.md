# Partnership Proposal: Pump Racers x Trojan Terminal

**Pokémon Card Drops on Every Trojan Swap**

---

## TL;DR

Pump Racers brings its provably fair Pokémon Card Drop system to Trojan Terminal. Trojan users get a chance to win real, PSA-graded Pokémon cards on every qualifying swap. Trojan earns a revenue share on drop-eligible volume. Pump Racers gets distribution to 2.5M+ traders.

---

## The Opportunity

Trojan Terminal is the leading Solana trading terminal with 2.5M users, $27B+ lifetime volume, and best-in-class execution. The Arena already proves Trojan users respond to gamified incentives — cashback tiers, Gold rankings, and daily jackpots drive engagement and retention.

Pump Racers has built a provably fair, on-chain reward layer for swaps: every qualifying trade rolls for a real, graded Pokémon card held in our treasury wallet. The system is live, battle-tested, and already integrated with Jupiter routing. Cards are tokenized as Solana NFTs, verifiable on-chain, and backed by physical inventory.

**The gap:** Trojan has the users. Pump Racers has a unique reward mechanic that no other terminal offers. Together, we create a swap experience that is both the fastest and the most rewarding on Solana.

---

## What We're Proposing

### Integration: Pokémon Card Drops on Trojan Swaps

Every swap executed through Trojan Terminal that meets the minimum threshold (0.1 SOL / ~$10) becomes eligible for a Pokémon card drop. The system works alongside Trojan's existing fee structure with zero friction for the end user.

**User flow:**
1. User swaps on Trojan Terminal as normal — no extra steps
2. Swap routes through Jupiter with a small additional fee allocation to the card drop pool
3. After confirmation, Pump Racers' backend rolls for a card drop (provably fair, SHA-256 based)
4. If the user wins, a real PSA-graded Pokémon card NFT is transferred to their wallet
5. Win announcement fires across both Trojan and Pump Racers communities

**Drop mechanics (configurable per partnership terms):**
- Base rate: ~1 in 80 per 1 SOL swapped (1.25% per SOL)
- Scales linearly with swap size, capped at 25% per transaction
- Card pool includes 56 graded cards ranging from $5 to $1,217 insured value (total pool value: $4,234)
- All rolls are verifiable — seed, signature, and hash are published per swap

### What Trojan Gets

| Benefit | Detail |
|---------|--------|
| **Revenue share** | 30% of net margin on all Trojan-sourced card drop volume — Trojan earns from the surplus after card costs, paid monthly |
| **User differentiation** | Only terminal on Solana where swaps can win real collectibles |
| **Retention boost** | Card drops add a tangible, shareable reward layer on top of Arena cashback |
| **Community content** | Win announcements generate organic social engagement and viral moments |
| **Zero development cost** | Pump Racers handles all backend infrastructure, card treasury, NFT transfers, and provably fair verification |

### What Pump Racers Gets

| Benefit | Detail |
|---------|--------|
| **Distribution** | Access to 2.5M+ users and 60K+ daily active traders |
| **Volume** | Drop-eligible swap volume at scale, funded by Trojan's existing flow |
| **Brand exposure** | Presence inside the most-used Solana trading terminal |
| **$RACE awareness** | Optional: $RACE holder boost tiers visible in Trojan UI, driving token demand |

---

## Technical Integration

The integration is lightweight from Trojan's side. Pump Racers operates the entire reward backend.

**Architecture:**

```
User swaps on Trojan Terminal
        │
        ▼
Jupiter routes swap (existing Trojan flow)
        │
        ▼
2.5% card drop fee routed to Pump Racers (card pool funded first, Trojan paid from margin)
        │
        ▼
Pump Racers webhook receives swap confirmation
        │
        ▼
Provably fair roll executed server-side
        │
        ▼
Win? → Card NFT transferred from RaceBank treasury to user wallet
        │
        ▼
Result returned to Trojan for UI display (optional widget/toast)
```

**Trojan-side requirements:**
- Route 2.5% fee (250 bps) to Pump Racers' treasury via Jupiter referral program (or equivalent fee account split)
- Webhook or event emission on confirmed swaps (transaction signature + wallet + amount)
- Optional: UI widget showing drop eligibility, recent wins, and card gallery

**Pump Racers provides:**
- Full backend: roll logic, card selection, NFT transfer, receipt generation
- API endpoints for Trojan to query drop status, recent winners, and card pool
- Provably fair verification page (already built)
- Card treasury management and restocking
- Community notifications (Telegram, Twitter)

**Existing stack compatibility:**
- Built on Jupiter aggregator (same routing Trojan already uses)
- Solana-native NFT transfers via SPL Token standard
- PostgreSQL-backed receipt and audit trail
- Stateless API — no session or account creation required from Trojan users

---

## Fee Structure & Reward Pool Economics

### Why 2.5% exists

On our own platform, we charge a **2.5% fee on total swap value**. This isn't an arbitrary margin — it's the number that keeps the card pool solvent at our current drop rates. The fee and the drop probability are a coupled system: one can't change without the other.

**The math:**

Drop rate is 1 in 80 per 1 SOL swapped. For every SOL of swap volume:

```
Fee Revenue per SOL = 0.025 × SOL Price (USD)
Expected Card Cost per SOL = Average Card Value / 80

Solvency: 0.025 × SOL Price > Avg Card Value / 80
→ Avg Card Value < 2.0 × SOL Price
```

Card values are USD-denominated (physical collectibles). They don't move with SOL. When SOL drops, fee revenue compresses while card costs stay flat — so the reward pool margin tightens.

**Current pool (live data, 56 droppable cards):**

| Metric | Value |
|--------|-------|
| Droppable pool value | $4,234 across 56 cards |
| Average card value | $75.61 |
| Median | $45.00 |
| Range | $5 — $1,217 (1st Ed PSA 8 Dark Gengar) |
| Fee per SOL swap | $2.15 |
| Expected card cost per SOL | $0.95 |
| **Margin per SOL** | **$1.20 (56%)** |

The pool is solidly profitable at $86 SOL. The highest-value card ($1,217 Dark Gengar) is absorbed by 55 other cards averaging $54.85 — keeping the weighted average at $75.61, well under the $172 solvency ceiling.

**SOL price sensitivity — max sustainable avg card value at 2.5% fee:**

| SOL Price | Fee per SOL | Max Avg Card Value | Status |
|-----------|-------------|--------------------|---------| 
| $50 | $1.25 | $100 | Tight — pool limited to lower-value cards |
| **$86** | **$2.15** | **$172** | **Current — healthy for our pool** |
| $120 | $3.00 | $240 | Comfortable |
| $150 | $3.75 | $300 | Wide margin |

### Proposed Trojan integration

The card drop fee on Trojan swaps stays at **2.5%** — same as our platform, same drop rates, same user experience. This is non-negotiable for pool health.

**The key constraint:** At $86 SOL, every basis point we share with Trojan directly reduces our solvency ceiling. A fixed 0.5% share would drop the card pool fee to 2.0%, lowering the max sustainable avg card from $172 to $137. That's too tight — it would force us to strip premium cards from the pool and degrade the product that makes this partnership valuable in the first place.

**Solution: Trojan earns from margin, not from the fee principal.**

Instead of a fixed fee split, Trojan receives a **30% share of net margin** — the surplus between fee revenue and card costs on Trojan-sourced volume. The card pool is always fully funded first. Trojan earns from what's left over.

**Fee structure:**

| Component | Rate | Recipient |
|-----------|------|-----------|
| Card drop fee | 2.5% of swap value | Pump Racers (card pool funded first) |
| Trojan margin share | 30% of net margin | Trojan Treasury (paid monthly) |

Total user fee on Trojan: **3.5%** (Trojan's existing 1% base fee + 2.5% card drop layer).

**How Trojan's margin share works:**

```
Net Margin = Total Fee Revenue − Total Card Costs − Operations
Trojan Payment = Net Margin × 30%
```

**Why 3.5% works for users:**
- Memecoin traders on Solana routinely accept 5-15% slippage on volatile tokens — 2.5% for a shot at $20-$500+ graded Pokémon cards is tangible value, not friction
- No other terminal offers real-world collectible rewards at any fee level
- The card drop is a premium feature, not a hidden cost — users see exactly what they're paying for and what they can win
- Trojan's Arena cashback (up to 45%) already reduces the base 1% — the card drop layer sits on top as an opt-in reward experience

### Revenue projections

At $86 SOL with current pool composition ($75.61 avg, 56% margin):

| Daily Trojan Volume | Drop-Eligible (est. 60%) | Fee Revenue (2.5%) | Est. Card Costs | Net Margin | Trojan Share (30%) |
|---------------------|--------------------------|--------------------|-----------------|-----------|--------------------|
| $10M | $6M | $150K/day | $66K/day | $84K/day | $25K/day |
| $30M | $18M | $450K/day | $198K/day | $252K/day | $76K/day |
| $50M | $30M | $750K/day | $330K/day | $420K/day | $126K/day |

As SOL price recovers, margins widen and Trojan's share grows proportionally — at $150 SOL with the same card pool, Trojan's daily share roughly doubles. The margin-based model means Trojan is naturally aligned with the system's health.

### Why margin-based sharing protects both sides

- **Card pool is always funded first.** The full 2.5% goes to Pump Racers. Card acquisition, NFT operations, and restocking are covered before Trojan sees a dollar. With 56 droppable cards averaging $75.61 against a $172 solvency ceiling at $86 SOL, the pool has 56% headroom.
- **Trojan's upside scales with volume AND SOL price.** As volume grows and/or SOL recovers, margins expand and Trojan earns more. This is better long-term than a fixed 0.5% that could force pool degradation in a bear market.
- **No pool composition compromises.** With the full 2.5% funding cards, we keep premium graded cards ($100-$500+) in the droppable pool. This is the product — high-value prizes are what make card drops exciting and shareable. A fixed fee split would pressure us to remove these.
- **Drop rates stay identical.** Users on Trojan get the exact same odds as users on our platform. No diluted experience, no second-class treatment.
- **Transparent and auditable.** Monthly margin reports show fee revenue, card costs, and Trojan's share. Both parties can verify independently.
- **SOL-price resilient.** If SOL drops to $50, the pool tightens but stays solvent. Trojan's share compresses but doesn't force the pool into deficit. If SOL runs to $200, Trojan's share expands. The model breathes with the market.

---

## Why This Works for Both Sides

**For Trojan:**
- The Arena rewards loyalty with cashback. Card drops reward *every swap* with a shot at something tangible and collectible. These mechanics are complementary, not competitive.
- No other terminal offers physical collectible rewards. This is a genuine differentiator in a crowded market of fee-based terminals.
- Trojan earns 30% of net margin on volume it already processes. No inventory risk, no backend overhead, no card pool management. Revenue scales up as SOL recovers and volume grows.

**For Pump Racers:**
- Our card drop system is proven but needs distribution. Trojan provides the largest concentrated pool of active Solana traders.
- Swap volume at Trojan's scale funds sustainable card inventory replenishment.
- Brand visibility inside Trojan drives awareness of $RACE token and the broader Pump Racers ecosystem (races, Edge Points, future features).

**For users:**
- Free upside on swaps they're already making. No opt-in, no extra clicks.
- Provably fair — every roll is verifiable on-chain.
- Real, tangible prizes (PSA-graded Pokémon cards worth $20-$500+), not just points or tokens.

---

## Optional Enhancements

These are not required for launch but could deepen the integration over time:

1. **$RACE Boost Tiers in Trojan UI** — Trojan users holding $RACE get boosted drop rates (up to 2x), displayed in the swap interface. Drives $RACE demand and adds another loyalty layer.

2. **Trojan-Exclusive Card Series** — Limited-edition cards only droppable through Trojan swaps. Creates exclusivity and co-branded content.

3. **Arena x Card Drops Synergy** — Higher Arena ranks could unlock bonus drop probability or exclusive card tiers. Reinforces Trojan's existing gamification loop.

4. **Leaderboard Integration** — "Top Card Winners" leaderboard within Trojan, creating social competition and engagement.

5. **Co-Branded Campaigns** — Joint Twitter/Telegram campaigns around major card drops (e.g., a Charizard Base Set drop event).

---

## Proposed Timeline

| Phase | Scope | Duration |
|-------|-------|----------|
| **Discovery** | Technical review, fee structure negotiation, API spec alignment | 1-2 weeks |
| **Integration** | Webhook setup, fee routing, basic UI widget | 2-3 weeks |
| **Testing** | Devnet/staging validation, provably fair audit | 1 week |
| **Launch** | Co-marketed launch with inaugural card drop event | 1 week |
| **Total** | End-to-end | ~5-7 weeks |

---

## About Pump Racers

- **Product:** Parimutuel prediction market + swap terminal on Solana (racepump.fun)
- **Swap&Rip:** Jupiter-powered swap interface with provably fair Pokémon Card Drops
- **Card Treasury:** Real, PSA-graded Pokémon cards tokenized as Solana NFTs, held in `racebank.sol`
- **On-chain Program:** Anchor-based Solana program (RaceSwap) for swap execution and fee management
- **Token:** $RACE — holder boost tiers for enhanced drop rates (1.1x to 2x multiplier)
- **Status:** Live on Solana mainnet

---

## Next Steps

1. Introductory call to align on strategic fit and fee terms
2. Trojan technical team reviews API spec and webhook requirements
3. Define fee split and drop rate parameters for Trojan integration
4. Execute integration on staging environment
5. Co-announce partnership and launch

---

*This proposal is confidential and intended for Trojan Terminal team review.*

**Contact:** [Pump Racers Team]
**Website:** https://racepump.fun
