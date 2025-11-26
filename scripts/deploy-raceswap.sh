#!/bin/bash
set -e

echo "=================================================="
echo "Raceswap Program Deployment Script"
echo "=================================================="
echo ""

# Configuration
PROGRAM_ID="Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk"
NETWORK="mainnet-beta"
KEYPAIR_FILE="deploy-keypair.json"

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v anchor &> /dev/null; then
    echo "❌ ERROR: Anchor CLI not found"
    echo "Install Anchor: https://www.anchor-lang.com/docs/installation"
    exit 1
fi

if ! command -v solana &> /dev/null; then
    echo "❌ ERROR: Solana CLI not found"
    echo "Install Solana: https://docs.solanalabs.com/cli/install"
    exit 1
fi

if [ ! -f "$KEYPAIR_FILE" ]; then
    echo "❌ ERROR: Keypair file not found: $KEYPAIR_FILE"
    echo "Make sure $KEYPAIR_FILE exists with the upgrade authority private key"
    exit 1
fi

echo "✅ All prerequisites met"
echo ""

# Show current Solana config
echo "Current Solana configuration:"
solana config get
echo ""

# Set network
echo "Setting network to $NETWORK..."
solana config set --url https://api.mainnet-beta.solana.com
echo ""

# Build the program
echo "Building Anchor program..."
anchor build
echo ""

# Check build output
PROGRAM_SO="target/deploy/raceswap.so"
if [ ! -f "$PROGRAM_SO" ]; then
    echo "❌ ERROR: Build failed - $PROGRAM_SO not found"
    exit 1
fi

echo "✅ Build successful: $PROGRAM_SO"
echo "Program size: $(du -h $PROGRAM_SO | cut -f1)"
echo ""

# Verify program ID matches
echo "Verifying program ID..."
BUILT_PROGRAM_ID=$(solana-keygen pubkey target/deploy/raceswap-keypair.json)
if [ "$BUILT_PROGRAM_ID" != "$PROGRAM_ID" ]; then
    echo "⚠️  WARNING: Built program ID doesn't match expected ID"
    echo "Expected: $PROGRAM_ID"
    echo "Got:      $BUILT_PROGRAM_ID"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Show upgrade authority
UPGRADE_AUTH=$(solana-keygen pubkey $KEYPAIR_FILE)
echo "Upgrade authority: $UPGRADE_AUTH"
echo ""

# Check current program state
echo "Checking current program state on $NETWORK..."
solana program show $PROGRAM_ID --url $NETWORK || echo "Program not deployed yet"
echo ""

# Estimate cost
echo "Estimating deployment cost..."
BUFFER=$(solana program write-buffer $PROGRAM_SO --url $NETWORK --output json --keypair $KEYPAIR_FILE 2>&1 | grep -o '"buffer":"[^"]*"' | cut -d'"' -f4 || echo "")
if [ -n "$BUFFER" ]; then
    echo "✅ Test buffer created: $BUFFER"
    solana program close $BUFFER --url $NETWORK --keypair $KEYPAIR_FILE &> /dev/null || true
fi
echo ""

# Confirm deployment
echo "=================================================="
echo "Ready to deploy to MAINNET-BETA"
echo "=================================================="
echo "Program ID: $PROGRAM_ID"
echo "Network:    $NETWORK"
echo "Authority:  $UPGRADE_AUTH"
echo ""
read -p "Deploy now? (yes/no) " -r
echo
if [ "$REPLY" != "yes" ]; then
    echo "Deployment cancelled"
    exit 0
fi

# Deploy
echo "Deploying program to mainnet..."
solana program deploy $PROGRAM_SO \
    --program-id $PROGRAM_ID \
    --upgrade-authority $KEYPAIR_FILE \
    --url $NETWORK \
    --keypair $KEYPAIR_FILE \
    -v

echo ""
echo "=================================================="
echo "✅ Deployment complete!"
echo "=================================================="
echo "Program ID: $PROGRAM_ID"
echo "Network:    $NETWORK"
echo ""
echo "Verify deployment:"
echo "solana program show $PROGRAM_ID --url $NETWORK"
