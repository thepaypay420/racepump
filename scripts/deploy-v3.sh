#!/bin/bash
#
# Raceswap V3 Deployment Script
# 
# This script builds and deploys the V3 program to mainnet
#

set -e

echo "🚀 Raceswap V3 Deployment"
echo "=========================="
echo ""

# Check for Anchor CLI
if ! command -v anchor &> /dev/null; then
    echo "❌ Anchor CLI not found. Installing..."
    cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked
fi

# Check for Solana CLI
if ! command -v solana &> /dev/null; then
    echo "❌ Solana CLI not found. Please install: https://docs.solana.com/cli/install-solana-cli-tools"
    exit 1
fi

echo "✅ Prerequisites check passed"
echo ""

# Build V3 program
echo "🔨 Building V3 program..."
cd programs/raceswap-v3
anchor build --program-name raceswap-v3

echo "✅ Build completed"
echo ""

# Get program ID
PROGRAM_ID="Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk"
echo "📋 Program ID: $PROGRAM_ID"

# Verify program ID matches
BUILT_ID=$(solana address -k target/deploy/raceswap_v3-keypair.json 2>/dev/null || echo "")
if [ -n "$BUILT_ID" ] && [ "$BUILT_ID" != "$PROGRAM_ID" ]; then
    echo "❌ Program ID mismatch!"
    echo "   Expected: $PROGRAM_ID"
    echo "   Got: $BUILT_ID"
    echo "   Update declare_id! in src/lib.rs"
    exit 1
fi

# Deploy/upgrade to mainnet
echo ""
echo "🚀 Deploying to mainnet..."
echo "   RPC: mainnet-beta"
echo "   Program: $PROGRAM_ID"
echo ""

# Set cluster
solana config set --url mainnet-beta

# Deploy (or upgrade if already exists)
solana program deploy \
  --program-id "$PROGRAM_ID" \
  target/deploy/raceswap_v3.so \
  --upgrade-authority ~/.config/solana/id.json

echo ""
echo "✅ V3 DEPLOYMENT SUCCESSFUL!"
echo ""
echo "📋 Next steps:"
echo "   1. Test with: node scripts/test-v3-real.mjs"
echo "   2. Verify on Solscan: https://solscan.io/account/$PROGRAM_ID"
echo "   3. Update frontend to use V3"
echo ""
