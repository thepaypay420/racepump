# Phantom dApp Review Submission

## Form Responses

### Project Name
**RacePump / Pump Racers**

### Describe your dApp
**Brief Description:**
RacePump is a parimutuel prediction market built on Solana where users bet SOL on animated races between top Pump.fun meme tokens. The platform features live price tracking, provably fair settlement via GeckoTerminal, and a built-in token swap interface (RACESwap) with automatic reflection buys to recent race winners.

**Main Features:**
1. **Parimutuel Betting**: Users stake SOL on which meme token will have the highest price gain during a 20-minute race window
2. **Live Race Animations**: Real-time canvas-based race visualizations showing token performance
3. **RACESwap**: Built-in Jupiter-powered token swap with automatic 1% reflection buys to recent winners and 0.2% treasury fee
4. **Provably Fair Settlement**: All prices sourced from GeckoTerminal with OHLCV verification links
5. **Edge Points System**: Non-transferable reward points for power users based on performance
6. **Jackpot Races**: Rolling jackpot system funded by 2% of rake (40% of total 5% rake)

**Purpose:**
To create an engaging, transparent, and fair prediction market for meme token price movements while providing utility through integrated token swapping and winner rewards.

### dApp website URL
**https://racepump.fun/raceswap**

### Your Name
**[Your Name]**

### Your E-mail
**oxthepaypay@gmail.com**

### Transaction Link
**[Please complete a transaction on the dApp and provide the Solscan link here]**
Example format: `https://solscan.io/tx/[transaction_signature]`

### Team Information
**GitHub Repository**: [Your GitHub repo URL - to be added when repo is public]
**Website**: https://racepump.fun
**Developer Team**: [Your team page/profile if applicable]

### Social Media Handles
**Twitter/X**: [Your Twitter handle]
**Discord**: [Your Discord server]
**Telegram**: [Your Telegram channel]

### Repository Links
**[Your GitHub repository URL - to be added when repo is public]**

### Community Member Vouch
**[If applicable, provide name and contact info]**

### Additional Information

**Problem Being Reported:**
Phantom wallet is incorrectly flagging our legitimate swap transactions as potentially malicious. Our dApp uses RACESwap, a built-in token swap feature powered by Jupiter that enables users to swap SOL for meme tokens directly within our platform.

**What RACESwap Does:**
RACESwap is a transparent, on-chain token swap interface that:
1. Uses Jupiter's proven swap infrastructure for optimal routing and liquidity
2. Executes swaps through an Anchor program (RACESwap V3) deployed on Solana mainnet
3. Automatically splits swap amounts into:
   - 98.8% main swap to user's desired token
   - 1.0% reflection buy (automatically purchases token from most recent race winner)
   - 0.2% treasury fee (funds protocol operations)

**Why Transactions May Look Unusual:**
- RACESwap uses versioned transactions with address lookup tables for efficiency
- The swap involves multiple instructions: setup, main swap, reflection buy, and cleanup
- The Anchor program passes account indices rather than full metadata (optimization for transaction size)
- This creates a transaction structure that may appear complex but is standard for efficient Solana swaps

**Transaction Safety:**
- All swaps are executed through Jupiter's verified swap program
- The RACESwap program is open-source and deployed on-chain
- Users can verify all program addresses and treasury wallets before swapping
- All fees are transparent: 1.0% reflection + 0.2% treasury = 1.2% total
- No hidden transfers or unexpected token movements
- Users receive exactly what they see in the UI preview

**Technical Details:**
- **RACESwap Program ID**: `Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk`
- **Treasury Wallet**: `Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L`
- **Jupiter Integration**: Uses Jupiter V6 program for swaps
- **Transaction Type**: Versioned transactions (V0) with address lookup tables

**Request:**
We request that Phantom review our transaction structure and whitelist our RACESwap program and treasury wallet. All transactions are legitimate swaps with transparent fee structures. We are happy to provide additional technical documentation or answer any questions about our implementation.

**Repository Status:**
We are preparing our repository for public release to demonstrate full transparency. The codebase will be available for review once sanitized of any sensitive configuration.

---

## Notes for Submission

1. **Complete a test transaction** on the dApp before submitting and include the Solscan link
2. **Fill in your actual social media handles** and team information
3. **Add your GitHub repository URL** once the repo is public
4. **Customize the "Your Name" field** with the actual submitter's name
5. **Review all information** to ensure accuracy before submitting to Phantom
