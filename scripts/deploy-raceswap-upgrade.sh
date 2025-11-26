#!/usr/bin/env bash
# Deploy to EXISTING program ID (upgrade, not new deployment)
set -euo pipefail

ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${RPC_URL:?RPC_URL (Solana RPC) must be set in Replit Secrets.}"
: "${ESCROW_PRIVATE_KEY:?ESCROW_PRIVATE_KEY must be set (Solana keypair in JSON-array format).}"

KEYPAIR_FILE="$ROOT/.deploy/raceswap-deployer.json"
mkdir -p "$(dirname "$KEYPAIR_FILE")"
echo "$ESCROW_PRIVATE_KEY" > "$KEYPAIR_FILE"

echo "➡️  Configuring Solana CLI"
solana config set --url "$RPC_URL" >/dev/null
solana config set --keypair "$KEYPAIR_FILE" >/dev/null

DEPLOYER_PUBKEY=$(solana-keygen pubkey "$KEYPAIR_FILE")
echo "Deployer pubkey: $DEPLOYER_PUBKEY"

echo "➡️  Building Anchor program"
cd "$ROOT"
anchor build

# Use the EXISTING program ID from Anchor.toml
EXISTING_PROGRAM_ID="Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk"
echo "Target program ID: $EXISTING_PROGRAM_ID"

# Check if we can upgrade this program
echo "➡️  Checking program authority..."
PROGRAM_DATA=$(solana program show "$EXISTING_PROGRAM_ID" --url "$RPC_URL" 2>&1 || true)
echo "$PROGRAM_DATA"

PROGRAM_SIZE=$(stat -c%s target/deploy/raceswap.so)
echo "Program binary size: ${PROGRAM_SIZE} bytes"

echo ""
echo "⚠️  IMPORTANT: This will UPGRADE the existing program at $EXISTING_PROGRAM_ID"
echo "Make sure you have the program upgrade authority!"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled."
    exit 1
fi

echo "➡️  Upgrading program..."
solana program deploy target/deploy/raceswap.so \
  --program-id "$EXISTING_PROGRAM_ID" \
  --upgrade-authority "$KEYPAIR_FILE"

echo ""
echo "✅ Program upgraded successfully!"
echo "Program ID: $EXISTING_PROGRAM_ID"
