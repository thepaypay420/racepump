#!/bin/bash
set -e

echo "🎯 BUILDING & DEPLOYING FIXED RACESWAP PROGRAM"
echo ""

# Check if Anchor is available
if ! command -v anchor &> /dev/null; then
    echo "❌ ERROR: Anchor CLI not found"
    echo "Install with: cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked"
    exit 1
fi

echo "✅ Anchor CLI found: $(anchor --version)"
echo ""

# Check if Solana is available
if ! command -v solana &> /dev/null; then
    echo "❌ ERROR: Solana CLI not found"
    echo "Install with: sh -c \"\$(curl -sSfL https://release.solana.com/stable/install)\""
    exit 1
fi

echo "✅ Solana CLI found: $(solana --version)"
echo ""

# Set cluster to mainnet
echo "🌐 Setting Solana cluster to mainnet-beta..."
solana config set --url mainnet-beta

# Check wallet balance
BALANCE=$(solana balance | awk '{print $1}')
echo "💰 Wallet balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 5" | bc -l) )); then
    echo "⚠️  WARNING: Low balance! Need at least 5 SOL for deployment."
    echo "   Current balance: $BALANCE SOL"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo "🔨 Building raceswap program..."
anchor build --program-name raceswap

echo ""
echo "📦 Program binary size:"
ls -lh target/deploy/raceswap.so

echo ""
echo "🔍 Verifying program ID..."
ACTUAL_ID=$(solana-keygen pubkey target/deploy/raceswap-keypair.json)
EXPECTED_ID="Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk"

if [ "$ACTUAL_ID" != "$EXPECTED_ID" ]; then
    echo "❌ ERROR: Program ID mismatch!"
    echo "   Expected: $EXPECTED_ID"
    echo "   Got: $ACTUAL_ID"
    echo ""
    echo "This means you need to use the correct program keypair."
    echo "Make sure target/deploy/raceswap-keypair.json has the right key."
    exit 1
fi

echo "✅ Program ID verified: $ACTUAL_ID"
echo ""

# Show current program info
echo "📊 Current onchain program info:"
solana program show $EXPECTED_ID || echo "Program not deployed yet"
echo ""

echo "🚀 Ready to upgrade program on mainnet-beta"
echo "   Program ID: $EXPECTED_ID"
echo "   Binary: target/deploy/raceswap.so"
echo ""
echo "Press Ctrl+C to cancel, or Enter to continue..."
read

echo ""
echo "📤 Upgrading program..."

# Use anchor upgrade for cleaner output
anchor upgrade target/deploy/raceswap.so --program-id $EXPECTED_ID

echo ""
echo "✅ DEPLOYMENT COMPLETE!"
echo ""
echo "🔗 View on Solana Explorer:"
echo "   https://explorer.solana.com/address/$EXPECTED_ID?cluster=mainnet-beta"
echo ""
echo "🧪 Test the fix from Replit workspace:"
echo "   NODE_ENV=production tsx scripts/test-raceswap-usdc.ts"
echo ""
echo "Expected result: NO MORE 0x1789 ERROR! 🎉"
