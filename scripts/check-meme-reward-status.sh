#!/bin/bash
# Check meme reward feature status in production

PROD_URL="${1:-https://racepump.fun}"

echo "🔍 Checking Meme Reward Status for: $PROD_URL"
echo "=" | awk '{for(i=0;i<70;i++)printf "="; printf "\n"}'
echo ""

# Check treasury config
echo "📊 Step 1: Checking treasury configuration..."
TREASURY=$(curl -s "$PROD_URL/api/treasury")
ENABLED=$(echo "$TREASURY" | grep -o '"memeRewardEnabled":[^,}]*' | cut -d':' -f2)
SOL_AMOUNT=$(echo "$TREASURY" | grep -o '"memeRewardSolAmount":"[^"]*"' | cut -d'"' -f4)

echo "   Meme Reward Enabled: $ENABLED"
echo "   SOL Amount: $SOL_AMOUNT SOL"
echo ""

# Check recent settled race
echo "📝 Step 2: Checking recent settled race..."
RECENT_RACE=$(curl -s "$PROD_URL/api/races?limit=5" | grep -A 500 '"status":"SETTLED"' | head -100)

# Extract meme reward fields
RECIPIENT=$(echo "$RECENT_RACE" | grep -o '"memeRewardRecipient":"[^"]*"' | head -1 | cut -d'"' -f4)
TOKEN_AMOUNT=$(echo "$RECENT_RACE" | grep -o '"memeRewardTokenAmount":"[^"]*"' | head -1 | cut -d'"' -f4)
TX_SIG=$(echo "$RECENT_RACE" | grep -o '"memeRewardTxSig":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$RECIPIENT" ]; then
  echo "   ✅ Meme reward was executed!"
  echo "   Recipient: $RECIPIENT"
  echo "   Token Amount: $TOKEN_AMOUNT"
  echo "   Transaction: https://solscan.io/tx/$TX_SIG"
else
  echo "   ❌ No meme reward found in recent race"
  echo ""
  echo "   Possible reasons:"
  echo "   1. Feature not enabled (ENABLE_MEME_REWARD=$ENABLED)"
  echo "   2. Error during execution (check production logs)"
  echo "   3. Only escrow placed bets (no eligible recipients)"
fi
echo ""

echo "=" | awk '{for(i=0;i<70;i++)printf "="; printf "\n"}'
echo "💡 To enable in production, set these secrets:"
echo "   ENABLE_MEME_REWARD=true"
echo "   MEME_REWARD_SOL_AMOUNT=0.02"
echo "=" | awk '{for(i=0;i<70;i++)printf "="; printf "\n"}'
