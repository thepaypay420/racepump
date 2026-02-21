# Swap&Rip — Solana Token Swaps with Pokémon Card Drops

A Jupiter-powered token swap terminal on Solana where every qualifying swap rolls for a chance to win real, PSA/CGC/Beckett-graded Pokémon cards. Cards are tokenized as NFTs by Collector Crypt and fully redeemable for the physical graded card shipped worldwide.

## Features

- **Jupiter-Powered Swaps (UltraV3)**: Best-route execution across all Solana liquidity via Jupiter aggregation
- **Pokémon Card Drop Reward Pool**: 2.5% swap fee funds a pool of real graded Pokémon cards
- **Provably Fair Card Drops**: ~1 in 80 chance per 1 SOL swapped, scales linearly with swap size (25% probability cap)
- **56 Real Graded Cards in Treasury**: $4,234 total value held in `racebank.sol`
- **Collector Crypt Integration**: Cards sourced and redeemable through [@Collector_Crypt](https://twitter.com/Collector_Crypt) — any card NFT can be redeemed for the physical graded slab
- **$RACE Token Holder Boost**: Tiered drop probability boosts (1M / 5M / 10M / 20M tokens) for up to 2x drop chance
- **Crate-Opening Animation**: CSGO-style reveal animation on winning drops
- **Provably Fair Verification**: SHA-256 roll system, independently verifiable
- **Telegram Win Notifications**: Instant alerts when a card drop hits
- **Wallet Integration**: Phantom/Solflare support via wallet-adapter
- **Persistent Storage**: Postgres-backed receipts, leaderboard, and referrals
- **Real-time Updates**: Server-Sent Events for live swap and drop status

## Quick Start

### Prerequisites

- Node.js 18+
- Solana mainnet wallet with some SOL for transaction fees
- **Neon Postgres** (free tier) for production persistence ([Setup Guide](PERSISTENCE_SETUP.md))

### Installation

```bash
npm install
npm run dev
```

## Production Setup

### Essential: Configure Persistent Storage

**Without this, receipts/leaderboard/referrals will reset on every redeploy!**

1. Create a free Neon Postgres database: https://neon.tech
2. Add to Replit Secrets:
   ```
   DATABASE_URL=postgres://user:pass@your-host.neon.tech/dbname?sslmode=require
   ```
3. Redeploy
4. Verify: `curl https://your-app.repl.co/api/persistence`

**See [PERSISTENCE_SETUP.md](PERSISTENCE_SETUP.md) for detailed instructions.**

### Verify Persistence Status

After deploying, check:
```bash
curl https://your-app.repl.co/api/persistence
```

Expected response:
```json
{
  "status": "healthy",
  "backend": "postgres",
  "persistent": true
}
```

If you see `"persistent": false` or warnings, follow the setup guide.

## Swap Terminal Environment

The on-chain swap program is fully configurable via environment variables. Defaults are production-safe, but you can override them in `.env`/Replit secrets:

```
RACESWAP_PROGRAM_ID=Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk
RACESWAP_CONFIG_PDA=EaD9EQSfe7Lnz5c12vaEasmrje7xtML9vUEJsCYuLpHP
RACESWAP_TREASURY_WALLET=Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L
RACESWAP_SWAP_FEE_BPS=250              # 2.50% swap fee funding the card drop pool
RACESWAP_DISABLE_CARD_DROPS=false      # set true to force-disable card drop rolls
RPC_URL=your-solana-rpc-endpoint       # Replace with your Solana RPC endpoint
```

Make sure the treasury wallet has an associated token account for every supported input mint. The swap terminal page surfaces the current program/treasury addresses so your community can verify they're correct.

## Documentation

- **Persistence Setup**: `PERSISTENCE_SETUP.md` — **READ THIS FIRST FOR PRODUCTION**
- **Whitepaper**: [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md) — Complete protocol documentation

## Security Notes

- **Never commit private keys or sensitive data** — All private keys should be stored as environment variables
- **Review `.gitignore`** — Sensitive files are excluded from version control
- **Production keys** — Use secure secret management (Replit Secrets, environment variables, etc.)

## Live Site

Visit **https://racepump.fun** to use the swap terminal on Solana mainnet.
