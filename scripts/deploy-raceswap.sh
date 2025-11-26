#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${RPC_URL:?RPC_URL (Solana RPC) must be set in Replit Secrets.}"
: "${ESCROW_PRIVATE_KEY:?ESCROW_PRIVATE_KEY must be set (Solana keypair in JSON-array format).}"
: "${RACESWAP_TREASURY_WALLET:?Set RACESWAP_TREASURY_WALLET to the treasury address before running.}"

KEYPAIR_FILE="$ROOT/.deploy/raceswap-deployer.json"
mkdir -p "$(dirname "$KEYPAIR_FILE")"
echo "$ESCROW_PRIVATE_KEY" > "$KEYPAIR_FILE"

echo "➡️  Configuring Solana CLI"
solana config set --url "$RPC_URL" >/dev/null
solana config set --keypair "$KEYPAIR_FILE" >/dev/null

DEPLOYER_PUBKEY=$(solana-keygen pubkey "$KEYPAIR_FILE")
echo "Deployer pubkey: $DEPLOYER_PUBKEY"

echo "➡️  Installing npm deps (if needed)"
cd "$ROOT"
npm install >/dev/null

echo "➡️  Building Anchor program"
anchor build

PROGRAM_KEYPAIR="$ROOT/target/deploy/raceswap-keypair.json"
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
export RACESWAP_PROGRAM_ID="$PROGRAM_ID"
echo "Program ID: $PROGRAM_ID"

PROGRAM_SIZE=$(stat -c%s target/deploy/raceswap.so)
echo "Program binary size: ${PROGRAM_SIZE} bytes"
echo "Estimated rent-exempt deploy cost (from RPC):"
solana rent "$PROGRAM_SIZE"

echo "➡️  Deploying program"
solana program deploy target/deploy/raceswap.so --program-id "$PROGRAM_KEYPAIR"

export RACESWAP_REFLECTION_FEE_BPS=${RACESWAP_REFLECTION_FEE_BPS:-100}
export RACESWAP_TREASURY_FEE_BPS=${RACESWAP_TREASURY_FEE_BPS:-20}
export RACESWAP_CONFIG_AUTHORITY=${RACESWAP_CONFIG_AUTHORITY:-$DEPLOYER_PUBKEY}

echo "➡️  Initializing on-chain config"
node scripts/init-raceswap.js

echo "✅ Deployment complete."
echo "PROGRAM ID: $PROGRAM_ID"
