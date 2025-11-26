#!/usr/bin/env bash
# Close unwanted program and recover SOL
set -euo pipefail

UNWANTED_PROGRAM="4cKwXzT7i7o2YVVCwwggWMtpcVNWudeTCds5RSFPw45B"
RECIPIENT="${1:-6yHeKfbTqSDiDgteku2ExJNcF3VghXxAGUEPPyjwqT4u}"

echo "🔄 Closing unwanted program: $UNWANTED_PROGRAM"
echo "💰 SOL will be returned to: $RECIPIENT"

solana program close "$UNWANTED_PROGRAM" --recipient "$RECIPIENT" --url devnet

echo "✅ Program closed, SOL recovered!"
solana balance "$RECIPIENT" --url devnet
