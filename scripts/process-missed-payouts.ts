import { getDb, hydrationPromise } from '../server/db';
import { calculateSettlement } from '../server/settlement';
import { sendLamports, serverKeypair } from '../server/solana';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';

async function processMissedPayouts() {
  try {
    console.log('⏳ Waiting for database to initialize...\n');
    await hydrationPromise;
    console.log('✅ Database ready!\n');
    
    console.log('🔍 Starting missed payouts check...\n');
    
    const db = getDb();
    
    // Get all settled races
    const settledRaces = await db.getRaces('SETTLED');
    
    console.log(`Found ${settledRaces.length} settled races\n`);
    
    const results = {
      racesChecked: 0,
      missedPayouts: [] as any[],
      sentPayouts: [] as any[],
      errors: [] as any[]
    };
    
    for (const race of settledRaces) {
      try {
        results.racesChecked++;
        
        // Get bets for this race
        const bets = await db.getBetsForRace(race.id);
        
        // Only process SOL races
        const solBets = bets.filter((b: any) => b.currency === 'SOL');
        if (solBets.length === 0) continue;
        
        // Calculate settlement
        const settlement = await calculateSettlement(solBets as any, race as any);
        
        // Check existing transfers
        const existingTransfers = await db.getSettlementTransfers(race.id) || [];
        
        // Process each winner
        for (const [wallet, payout] of settlement.winnerPayouts.entries()) {
          if (!payout || payout.lte(0)) continue;
          
          // Skip escrow wallet (house doesn't pay itself)
          if (wallet === serverKeypair.publicKey.toString()) {
            continue;
          }
          
          // Check if already paid
          const alreadyPaid = existingTransfers.some((t: any) =>
            t.transferType === 'PAYOUT' &&
            t.toWallet === wallet &&
            t.currency === 'SOL' &&
            (t.status === 'SUCCESS' || !t.status)
          );
          
          if (alreadyPaid) continue;
          
          // Found missed payout!
          console.log(`💰 Found missed payout: Race ${race.id}, Wallet ${wallet.slice(0, 8)}..., Amount ${payout.toString()} SOL`);
          
          results.missedPayouts.push({
            raceId: race.id,
            wallet,
            amount: payout.toString()
          });
          
          // Send the payout
          try {
            const lamports = payout.mul(LAMPORTS_PER_SOL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
            const recipientPubkey = new PublicKey(wallet);
            
            console.log(`  💸 Sending ${payout.toString()} SOL (${lamports.toString()} lamports)...`);
            
            const txSig = await sendLamports(
              serverKeypair,
              recipientPubkey,
              BigInt(lamports.toString())
            );
            
            // Record the transfer
            await db.recordSettlementTransfer({
              id: `manual_${Date.now()}_${wallet.slice(-6)}`,
              raceId: race.id,
              transferType: 'PAYOUT',
              toWallet: wallet,
              amount: payout.toString(),
              txSig,
              currency: 'SOL',
              ts: Date.now()
            });
            
            results.sentPayouts.push({
              raceId: race.id,
              wallet,
              amount: payout.toString(),
              txSig
            });
            
            console.log(`  ✅ SUCCESS! TX: ${txSig}\n`);
            
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            results.errors.push({
              raceId: race.id,
              wallet,
              amount: payout.toString(),
              error: errMsg
            });
            console.error(`  ❌ FAILED: ${errMsg}\n`);
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        results.errors.push({
          raceId: race.id,
          error: errMsg
        });
        console.error(`❌ Error processing race ${race.id}:`, errMsg);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 MISSED PAYOUTS SUMMARY');
    console.log('='.repeat(60));
    console.log(`Races checked: ${results.racesChecked}`);
    console.log(`Missed payouts found: ${results.missedPayouts.length}`);
    console.log(`Successfully sent: ${results.sentPayouts.length}`);
    console.log(`Errors: ${results.errors.length}`);
    console.log('='.repeat(60));
    
    if (results.missedPayouts.length > 0) {
      console.log('\n💰 MISSED PAYOUTS DETAILS:');
      results.missedPayouts.forEach((p, i) => {
        console.log(`  ${i + 1}. Race ${p.raceId}: ${p.amount} SOL to ${p.wallet.slice(0, 8)}...`);
      });
    }
    
    if (results.sentPayouts.length > 0) {
      console.log('\n✅ SENT PAYOUTS:');
      results.sentPayouts.forEach((p, i) => {
        console.log(`  ${i + 1}. Race ${p.raceId}: ${p.amount} SOL to ${p.wallet.slice(0, 8)}...`);
        console.log(`     TX: ${p.txSig}`);
      });
    }
    
    if (results.errors.length > 0) {
      console.log('\n❌ ERRORS:');
      results.errors.forEach((e, i) => {
        console.log(`  ${i + 1}. Race ${e.raceId}:`, e.error);
      });
    }
    
    console.log('\n✨ Processing complete!\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n💥 Fatal error:', error);
    process.exit(1);
  }
}

processMissedPayouts();
