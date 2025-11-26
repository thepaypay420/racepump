#!/bin/bash
set -e

echo "🎯 DEPLOYING FIXED RACESWAP PROGRAM"
echo "   Fix: Changed invoke_signed to use EMPTY signer seeds []"
echo "   This matches Jupiter's official CPI example"
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
  exit 1
fi

echo "✅ Program ID verified: $ACTUAL_ID"
echo ""

echo "🚀 Deploying to mainnet-beta..."
echo "   Make sure you have 5-10 SOL in your wallet for deployment"
echo "   Press Ctrl+C to cancel, or Enter to continue..."
read

solana program deploy target/deploy/raceswap.so \
  --program-id Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk \
  --url mainnet-beta

echo ""
echo "✅ DEPLOYMENT COMPLETE!"
echo ""
echo "🧪 Test the fix with:"
echo "   cd /path/to/replit/workspace"
echo "   NODE_ENV=production tsx scripts/test-raceswap-usdc.ts"
echo ""
echo "Expected: NO MORE 0x1789 ERROR! 🎉"
