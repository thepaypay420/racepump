import { Race } from "@shared/schema";
import { executeMemeReward } from "../server/meme-rewards";
import { serverKeypair } from "../server/solana";
import Decimal from "decimal.js";

/**
 * Test script to manually execute a meme reward swap
 * Usage: tsx scripts/test-meme-reward.ts <winnerMint> <winnerSymbol>
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: tsx scripts/test-meme-reward.ts <winnerMint> <winnerSymbol>');
    console.log('Example: tsx scripts/test-meme-reward.ts So11111111111111111111111111111111111111112 SOL');
    process.exit(1);
  }

  const [winnerMint, winnerSymbol] = args;
  
  // Create a mock race with the winning coin
  const mockRace: Race = {
    id: `test_${Date.now()}`,
    status: 'SETTLED',
    startTs: Date.now() - 300000, // 5 minutes ago
    runners: [
      {
        mint: winnerMint,
        symbol: winnerSymbol,
        name: winnerSymbol,
        initialPrice: 1.0,
        initialPriceUsd: 1.0,
        priceChange: 25.5 // Mock 25.5% gain
      },
      {
        mint: 'DummyToken1111111111111111111111111111111',
        symbol: 'DUMMY',
        name: 'Dummy',
        initialPrice: 1.0,
        initialPriceUsd: 1.0,
        priceChange: 5.0
      }
    ],
    winnerIndex: 0,
    rakeBps: 500
  };

  // Create mock bets - simulate 3 different wallets betting
  const mockBets = [
    {
      id: 'bet1',
      raceId: mockRace.id,
      wallet: 'TestWallet111111111111111111111111111111',
      runner: 0,
      amount: '0.01',
      currency: 'SOL',
      ts: Date.now() - 60000
    },
    {
      id: 'bet2',
      raceId: mockRace.id,
      wallet: 'TestWallet222222222222222222222222222222',
      runner: 1,
      amount: '0.01',
      currency: 'SOL',
      ts: Date.now() - 60000
    },
    {
      id: 'bet3',
      raceId: mockRace.id,
      wallet: 'TestWallet333333333333333333333333333333',
      runner: 0,
      amount: '0.01',
      currency: 'SOL',
      ts: Date.now() - 60000
    }
  ];

  console.log('\n🧪 MEME REWARD TEST');
  console.log('='.repeat(60));
  console.log(`Winning Token: ${winnerSymbol} (${winnerMint})`);
  console.log(`SOL Amount: ${process.env.MEME_REWARD_SOL_AMOUNT || '0.1'} SOL`);
  console.log(`Escrow Wallet: ${serverKeypair.publicKey.toString()}`);
  console.log(`Mock Bettors: ${mockBets.length}`);
  console.log('='.repeat(60));
  console.log();

  try {
    console.log('🚀 Executing meme reward...\n');
    
    const result = await executeMemeReward(mockRace as any, mockBets as any);
    
    if (result) {
      console.log('\n✅ MEME REWARD SUCCESSFUL!');
      console.log('='.repeat(60));
      console.log(`Recipient:      ${result.recipient}`);
      console.log(`Token Amount:   ${result.tokenAmount} ${result.coinSymbol}`);
      console.log(`SOL Spent:      ${result.solSpent} SOL`);
      console.log(`Transaction:    ${result.txSig}`);
      console.log(`Solscan:        https://solscan.io/tx/${result.txSig}?cluster=devnet`);
      console.log('='.repeat(60));
    } else {
      console.log('\n⚠️  Meme reward was not executed (feature may be disabled or error occurred)');
    }
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exit(1);
  }
}

main().catch(console.error);
