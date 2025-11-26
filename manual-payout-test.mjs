import pg from 'pg';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import Decimal from 'decimal.js';

const { Pool } = pg;

// Database connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Solana connection
const ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://spring-cold-tree.solana-mainnet.quiknode.pro/24011188359c3607a1ed91ac2ecbfe22b8e39681/';
const escrowKeypair = Keypair.fromSecretKey(bs58.decode(ESCROW_PRIVATE_KEY));
const connection = new Connection(RPC_URL, 'confirmed');

console.log('🔐 Escrow wallet:', escrowKeypair.publicKey.toString());
console.log('📊 Checking for settled races with user bets...\n');

async function findMissedPayouts() {
  // Find settled SOL races with non-escrow bets
  const racesQuery = `
    SELECT DISTINCT r.id, r.winner_index, r.status, r.start_ts
    FROM races r
    JOIN bets b ON r.id = b.race_id
    WHERE r.status = 'SETTLED'
      AND b.currency = 'SOL'
      AND b.wallet != $1
    ORDER BY r.start_ts DESC
    LIMIT 10
  `;
  
  const racesResult = await pool.query(racesQuery, [escrowKeypair.publicKey.toString()]);
  
  if (racesResult.rows.length === 0) {
    console.log('❌ No settled races with user bets found.');
    console.log('This means either:');
    console.log('  1. No users have placed bets yet (only house seeds exist)');
    console.log('  2. You\'re looking at a different database than the live site\n');
    return [];
  }
  
  console.log(`✅ Found ${racesResult.rows.length} settled races with user bets\n`);
  
  const missedPayouts = [];
  
  for (const race of racesResult.rows) {
    console.log(`\n🏁 Race: ${race.id} (Winner: ${race.winner_index})`);
    
    // Get all bets for this race
    const betsQuery = `SELECT * FROM bets WHERE race_id = $1 AND currency = 'SOL'`;
    const betsResult = await pool.query(betsQuery, [race.id]);
    const bets = betsResult.rows;
    
    console.log(`   Total bets: ${bets.length}`);
    
    // Calculate settlement (simplified - matches server logic)
    const totalPot = bets.reduce((sum, bet) => sum.add(new Decimal(bet.amount)), new Decimal(0));
    const rake = totalPot.mul(0.05); // 5% rake
    const prizePool = totalPot.sub(rake);
    
    const winningBets = bets.filter(b => b.runner_idx === race.winner_index);
    const totalWinningAmount = winningBets.reduce((sum, bet) => sum.add(new Decimal(bet.amount)), new Decimal(0));
    
    if (totalWinningAmount.eq(0)) {
      console.log('   ⚠️  No winning bets - refund scenario');
      continue;
    }
    
    // Calculate payouts for each winner
    const winnerPayouts = new Map();
    winningBets.forEach(bet => {
      const share = new Decimal(bet.amount).div(totalWinningAmount);
      const payout = prizePool.mul(share);
      const current = winnerPayouts.get(bet.wallet) || new Decimal(0);
      winnerPayouts.set(bet.wallet, current.add(payout));
    });
    
    console.log(`   Winner payouts: ${winnerPayouts.size} wallets`);
    
    // Check which payouts are missing
    for (const [wallet, amount] of winnerPayouts) {
      // Skip escrow wallet
      if (wallet === escrowKeypair.publicKey.toString()) {
        console.log(`   🏦 Skipping house wallet: ${amount.toFixed(4)} SOL`);
        continue;
      }
      
      // Check if payout already sent
      const transferQuery = `
        SELECT * FROM settlement_transfers 
        WHERE race_id = $1 
          AND to_wallet = $2 
          AND transfer_type = 'PAYOUT' 
          AND currency = 'SOL'
          AND status = 'SUCCESS'
      `;
      const transferResult = await pool.query(transferQuery, [race.id, wallet]);
      
      if (transferResult.rows.length > 0) {
        console.log(`   ✅ Already paid: ${wallet.slice(0, 8)}... ${amount.toFixed(4)} SOL`);
      } else {
        console.log(`   ❌ MISSING PAYOUT: ${wallet.slice(0, 8)}... ${amount.toFixed(4)} SOL`);
        missedPayouts.push({ raceId: race.id, wallet, amount });
      }
    }
  }
  
  return missedPayouts;
}

async function sendMissedPayouts(payouts) {
  if (payouts.length === 0) {
    console.log('\n✅ No missed payouts to send!');
    return;
  }
  
  console.log(`\n📤 Sending ${payouts.length} missed payouts...\n`);
  
  for (const { raceId, wallet, amount } of payouts) {
    try {
      const recipientPubkey = new PublicKey(wallet);
      const lamports = amount.mul(LAMPORTS_PER_SOL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
      
      console.log(`💸 Sending ${amount.toFixed(4)} SOL to ${wallet.slice(0, 8)}...`);
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: escrowKeypair.publicKey,
          toPubkey: recipientPubkey,
          lamports: BigInt(lamports.toString())
        })
      );
      
      const signature = await connection.sendTransaction(transaction, [escrowKeypair]);
      await connection.confirmTransaction(signature, 'confirmed');
      
      // Record in settlement_transfers
      await pool.query(`
        INSERT INTO settlement_transfers (id, race_id, transfer_type, to_wallet, amount, tx_sig, currency, status, ts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        `manual_${Date.now()}_${wallet.slice(-6)}`,
        raceId,
        'PAYOUT',
        wallet,
        amount.toString(),
        signature,
        'SOL',
        'SUCCESS',
        Date.now()
      ]);
      
      console.log(`   ✅ Sent! Tx: ${signature}\n`);
      
    } catch (error) {
      console.error(`   ❌ Failed:`, error.message);
    }
  }
}

// Run the payout checker and sender
try {
  const missedPayouts = await findMissedPayouts();
  await sendMissedPayouts(missedPayouts);
  
  // Final balance
  const balance = await connection.getBalance(escrowKeypair.publicKey);
  const balanceSol = new Decimal(balance).div(LAMPORTS_PER_SOL);
  console.log(`\n💰 Final escrow balance: ${balanceSol.toString()} SOL`);
  
} catch (error) {
  console.error('\n❌ Error:', error);
} finally {
  await pool.end();
}
