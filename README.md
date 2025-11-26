# Pump Racers - Solana Racing dApp

A fully functional parimutuel betting game where users bet SOL on animated races between top market-cap Pump.fun tokens, built on Solana mainnet with provably fair price verification.

## 🏁 Features

- **SOL Betting**: All bets use native SOL transfers on Solana mainnet
- **Live Pump.fun Data**: Real-time top token data from GeckoTerminal APIs  
- **Parimutuel Settlement**: 5% rake on SOL bets (3% treasury, 2% jackpot)
- **Live Race Animation**: Canvas-based 15-20 second races with deterministic replay
- **Real-time Updates**: Server-Sent Events for live race status
- **Admin Panel**: Race creation, management, and controls
- **Wallet Integration**: Phantom/Solflare support via wallet-adapter
- **Persistent Storage**: Postgres-backed receipts, leaderboard, and referrals
- **RACESwap**: Built-in Jupiter swap UI with Anchor-backed execution, automatic 1% reflection buys to recent race winners, 0.2% treasury fee, and a CSGO-style crate animation showing the meme token you earned
- **Edge Points**: Non-transferable reward points system for power users

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Solana mainnet wallet with some SOL for transaction fees
- **Neon Postgres** (free tier) for production persistence ([Setup Guide](PERSISTENCE_SETUP.md))

### Installation

```bash
npm install
npm run dev
```

## ⚡ Production Setup

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

## ⚙️ RACESwap Environment

The on-chain RACESwap program is fully configurable via environment variables. Defaults are production-safe, but you can override them in `.env`/Replit secrets:

```
RACESWAP_PROGRAM_ID=Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk
RACESWAP_CONFIG_PDA=EaD9EQSfe7Lnz5c12vaEasmrje7xtML9vUEJsCYuLpHP
RACESWAP_TREASURY_WALLET=Exh4ZxgzA32hnLrQq3UnqxEXMRd4vifogMc6oXn7bP4L
RACESWAP_REFLECTION_FEE_BPS=100     # 1.00% reflection buy
RACESWAP_TREASURY_FEE_BPS=20        # 0.20% treasury fee
RACESWAP_DISABLE_REFLECTION=false   # set true to force-disable reflection leg
RPC_URL=your-solana-rpc-endpoint    # Replace with your Solana RPC endpoint
```

Make sure the treasury wallet has an associated token account for every supported input mint. The RACESwap page will surface the current program/treasury addresses so your community can verify they're correct.

## 📚 Documentation

- **Quick Start**: `QUICK_START.md` - Get up and running in 5 minutes
- **Persistence Setup**: `PERSISTENCE_SETUP.md` - **READ THIS FIRST FOR PRODUCTION**
- **Whitepaper**: `docs/WHITEPAPER.md` - Complete protocol documentation
- **Phantom Review Submission**: `docs/PHANTOM_DAPP_REVIEW_SUBMISSION.md` - Form responses for wallet review
- **Feature Documentation**: `docs/MEME_REWARD_FEATURE.md` - Meme reward system details
- **API Endpoints**: Check `/api/persistence` for health status

> **Note**: Historical development notes and deployment guides have been archived to `docs/archive/development-notes/` for reference.

## 🔒 Security Notes

- **Never commit private keys or sensitive data** - All private keys should be stored as environment variables
- **Review `.gitignore`** - Sensitive files are excluded from version control
- **Production keys** - Use secure secret management (Replit Secrets, environment variables, etc.)

## 🌐 Live Site

Visit **https://racepump.fun** to use the dApp on Solana mainnet.
