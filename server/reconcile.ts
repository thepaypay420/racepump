// CRASH-SAFE BOOT RECONCILIATION: Reconcile races forward by timestamps on server restart
import Decimal from "decimal.js";
export async function reconcileStuckRaces() {
  try {
    const { getDb } = await import('./db');
    const { RaceStateMachine } = await import('./race-state-machine');

    console.log('📝 Checking for stuck races to reconcile...');

    const allRaces = getDb().getRaces();
    let reconciledCount = 0;

    for (const race of allRaces) {
      try {
        const updated = await RaceStateMachine.reconcileRace(race);
        if (updated && updated.status !== race.status) {
          reconciledCount++;
        }
      } catch (error) {
        console.error(`❌ Failed to reconcile race ${race.id}:`, error);
      }
    }

    console.log(`✅ Boot reconciliation complete: ${reconciledCount} races reconciled`);
  } catch (error) {
    console.error('❌ Boot reconciliation failed:', error);
  }
}

// Periodic on-chain bet reconciler: scans escrow ATA for recent transfers with BET memos and backfills bets
let betReconcilerStarted = false;
let lastSeenSig: string | undefined; // incremental scanning watermark
export function startBetReconciler(intervalMs: number = 30000) {
  if (betReconcilerStarted) return;
  betReconcilerStarted = true;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { getDb } = await import('./db');
      const { connection, serverKeypair, getAssociatedTokenAccountAddress, raceMintAddress, getMintDecimals } = await import('./solana');
      const { PublicKey } = await import('@solana/web3.js');
      const { verifyTransaction } = await import('./solana');
      
      const treasury = await getDb().getTreasury();
      const mintStr = raceMintAddress || treasury.raceMint;
      if (!mintStr) {
        return;
      }
      const mint = new PublicKey(mintStr);
      const escrow = serverKeypair.publicKey;
      const escrowAta = await getAssociatedTokenAccountAddress(mint, escrow);
      const decimals = await getMintDecimals(mint);
      
      // Fetch only new signatures since last tick using `until` watermark
      const sigInfos = await connection.getSignaturesForAddress(escrowAta, { limit: 200, until: lastSeenSig });
      if (sigInfos.length > 0) {
        // Newest first; advance watermark to latest signature
        lastSeenSig = sigInfos[0]?.signature || lastSeenSig;
      }

      // Quick pre-filter using RPC-provided memo to minimize expensive getTransaction calls
      // Only keep successful txs that include a JSON memo with t === 'BET'
      type SigInfo = { signature: string; err?: any; memo?: string };
      type BetCandidate = { info: SigInfo; parsed: any };
      const betCandidates: BetCandidate[] = (sigInfos as SigInfo[])
        .filter((i) => !i.err && typeof i.memo === 'string' && !!i.memo)
        .map((i) => {
          let parsed: any = null;
          try { parsed = JSON.parse(i.memo as string); } catch {}
          return { info: i, parsed } as BetCandidate;
        })
        .filter((c) => c.parsed && c.parsed.t === 'BET');

      // Throttle processing to reduce RPC pressure
      const MAX_PER_TICK = 40; // cap verifications per interval
      let processedThisTick = 0;

      for (const { info } of betCandidates) {
        const sig = info.signature;
        // Skip if already processed
        if (getDb().hasSeenTransaction(sig)) continue;
        try {
          if (processedThisTick >= MAX_PER_TICK) break;
          const verification = await verifyTransaction(sig, mint, escrow, BigInt(0));
          if (!verification.valid) continue;
          const memo = verification.memo;
          if (!memo) continue;
          let parsed: any;
          try { parsed = JSON.parse(memo); } catch { continue; }
          if (!parsed || parsed.t !== 'BET') continue;
          const raceId = parsed.raceId;
          const runnerIdx = parsed.runnerIdx;
          if (!raceId || typeof runnerIdx !== 'number') continue;
          const race = getDb().getRace(raceId);
          if (!race) continue;
          // Enforce runner index bounds
          if (runnerIdx < 0 || runnerIdx >= race.runners.length) continue;
          // Enforce timing: only accept if race is OPEN, or tx block time <= lock time
          const lockMs = (race as any).lockedBlockTimeMs || race.lockedTs || race.startTs;
          const blockTimeMs = verification.blockTimeMs;
          const allowedByTime = typeof blockTimeMs === 'number' && blockTimeMs <= (lockMs || Number.MAX_SAFE_INTEGER);
          if (race.status !== 'OPEN' && !allowedByTime) continue;
          // Determine sender wallet from transfers
          const transfers = verification.transfers || [];
          const matching = transfers.find(t => t.mint === mint.toString() && t.recipient === escrow.toString());
          if (!matching) continue;
          const sender = transfers.find(t => t.mint === mint.toString() && t.recipient === escrow.toString())?.sender;
          if (!sender) continue;
          // Use on-chain transfer amount (base units) → human units (assume 9 decimals for RACE)
          let amountStr: string | undefined;
          try {
            const baseUnits = new Decimal(matching.amount || '0');
            const human = baseUnits.div(new Decimal(10).pow(decimals));
            amountStr = human.toString();
          } catch {
            // Fallback to memo only if parsing fails
            amountStr = (parsed && parsed.amount) ? String(parsed.amount) : undefined;
          }
          if (!amountStr) continue;
          // Create bet
          const bet = {
            id: `bet_${Date.now()}_${sig.slice(-8)}`, // Use tx signature suffix instead of random
            raceId,
            wallet: sender,
            runnerIdx,
            amount: amountStr,
            sig,
            ts: Date.now(),
            blockTimeMs: verification.blockTimeMs,
            slot: verification.slot,
            clientId: parsed.clientId || null,
            memo
          };
          try {
            getDb().createBet(bet);
            getDb().recordTransaction(sig);
            console.log(`🔄 Reconciled on-chain bet for ${sender} race=${raceId} runnerIdx=${runnerIdx} amount=${amountStr}`);
          } catch (e) {
            // Ignore if insert fails due to constraints
          }
          processedThisTick++;
          // Small delay between verifications to avoid bursty 429s
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch {}
      }
    } catch (e) {
      console.warn('Bet reconciler iteration failed:', e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }, intervalMs);
}

// One-off boot rescan to quickly hydrate recent bets after restart
export async function oneOffBootRescanBets(limit: number = 400) {
  try {
    const { getDb } = await import('./db');
    const { connection, serverKeypair, getAssociatedTokenAccountAddress, raceMintAddress, getMintDecimals } = await import('./solana');
    const { PublicKey } = await import('@solana/web3.js');
    const { verifyTransaction } = await import('./solana');

    const treasury = await getDb().getTreasury();
    const mintStr = raceMintAddress || treasury.raceMint;
    if (!mintStr) return;
    const mint = new PublicKey(mintStr);
    const escrow = serverKeypair.publicKey;
    const escrowAta = await getAssociatedTokenAccountAddress(mint, escrow);
    const decimals = await getMintDecimals(mint);

    const sigInfos = await connection.getSignaturesForAddress(escrowAta, { limit });
    type SigInfo = { signature: string; err?: any; memo?: string };
    type BetCandidate = { info: SigInfo; parsed: any };
    const betCandidates: BetCandidate[] = (sigInfos as SigInfo[])
      .filter((i) => !i.err && typeof i.memo === 'string' && !!i.memo)
      .map((i) => { let parsed: any = null; try { parsed = JSON.parse(i.memo as string); } catch {}; return { info: i, parsed } as BetCandidate; })
      .filter((c) => c.parsed && c.parsed.t === 'BET');
    let inserted = 0;
    for (const { info } of betCandidates) {
      const sig = info.signature;
      if (getDb().hasSeenTransaction(sig)) continue;
      try {
        const verification = await verifyTransaction(sig, mint, escrow, BigInt(0));
        if (!verification.valid) continue;
        const memo = verification.memo;
        if (!memo) continue;
        let parsed: any; try { parsed = JSON.parse(memo); } catch { continue; }
        if (!parsed || parsed.t !== 'BET') continue;
        const raceId = parsed.raceId;
        const runnerIdx = parsed.runnerIdx;
        if (!raceId || typeof runnerIdx !== 'number') continue;
        const race = getDb().getRace(raceId);
        if (!race) continue;
        if (runnerIdx < 0 || runnerIdx >= race.runners.length) continue;
        const transfers = verification.transfers || [];
        const matching = transfers.find(t => t.mint === mint.toString() && t.recipient === escrow.toString());
        const sender = matching?.sender;
        if (!matching || !sender) continue;
        let amountStr: string | undefined;
        try {
          const baseUnits = new Decimal(matching.amount || '0');
          const human = baseUnits.div(new Decimal(10).pow(decimals));
          amountStr = human.toString();
        } catch {
          amountStr = (parsed && parsed.amount) ? String(parsed.amount) : undefined;
        }
        if (!amountStr) continue;
        const bet = {
          id: `bet_${Date.now()}_${sig.slice(-8)}`,
          raceId,
          wallet: sender,
          runnerIdx,
          amount: amountStr,
          sig,
          ts: Date.now(),
          blockTimeMs: verification.blockTimeMs,
          slot: verification.slot,
          clientId: parsed.clientId || null,
          memo
        };
        try {
          getDb().createBet(bet);
          getDb().recordTransaction(sig);
          inserted++;
        } catch {}
      } catch {}
    }
    if (inserted > 0) {
      console.log(`🪄 Boot rescan inserted ${inserted} missing bets`);
    }
  } catch (e) {
    console.warn('Boot rescan failed:', e instanceof Error ? e.message : e);
  }
}

// Manual rescan for a specific wallet (optional race)
export async function rescanBetsForWallet(params: {
  wallet: string;
  raceId?: string;
  pages?: number;
  limitPerPage?: number;
}): Promise<{ checked: number; validWithMemo: number; matchedWallet: number; inserted: number; alreadySeen: number }> {
  // Enforce conservative defaults and caps to protect RPC budget
  const ENABLED = ((process.env.ENABLE_BET_RESCAN || '').toLowerCase() === '1' || (process.env.ENABLE_BET_RESCAN || '').toLowerCase() === 'true');
  if (!ENABLED) {
    return { checked: 0, validWithMemo: 0, matchedWallet: 0, inserted: 0, alreadySeen: 0 };
  }
  const { wallet, raceId, pages = 3, limitPerPage = 200 } = params;
  const MAX_PAGES = Math.max(1, Number(process.env.RESCAN_MAX_PAGES || 1));
  const MAX_LIMIT = Math.max(50, Number(process.env.RESCAN_LIMIT_PER_PAGE || 100));
  const safePages = Math.min(pages, MAX_PAGES);
  const safeLimit = Math.min(limitPerPage, MAX_LIMIT);
  const { getDb } = await import('./db');
  const { connection, serverKeypair, getAssociatedTokenAccountAddress, raceMintAddress, getMintDecimals } = await import('./solana');
  const { PublicKey } = await import('@solana/web3.js');
  const { verifyTransaction } = await import('./solana');

  const treasury = await getDb().getTreasury();
  const mintStr = raceMintAddress || treasury.raceMint;
  if (!mintStr) {
    return { checked: 0, validWithMemo: 0, matchedWallet: 0, inserted: 0, alreadySeen: 0 };
  }

  const mint = new PublicKey(mintStr);
  const escrow = serverKeypair.publicKey;
  const escrowAta = await getAssociatedTokenAccountAddress(mint, escrow);
  const decimals = await getMintDecimals(mint);

  let before: string | undefined = undefined;
  let checked = 0;
  let validWithMemo = 0;
  let matchedWallet = 0;
  let inserted = 0;
  let alreadySeen = 0;

  for (let page = 0; page < safePages; page++) {
    const sigInfos = await connection.getSignaturesForAddress(escrowAta, { limit: safeLimit, before });
    type SigInfo = { signature: string; err?: any; memo?: string };
    type BetCandidate = { info: SigInfo; parsed: any };
    const betCandidates: BetCandidate[] = (sigInfos as SigInfo[])
      .filter((i) => !i.err && typeof i.memo === 'string' && !!i.memo)
      .map((i) => { let parsed: any = null; try { parsed = JSON.parse(i.memo as string); } catch {}; return { info: i, parsed } as BetCandidate; })
      .filter((c) => c.parsed && c.parsed.t === 'BET');
    if (!sigInfos.length) break;
    for (const { info } of betCandidates) {
      const sig = info.signature;
      if (getDb().hasSeenTransaction(sig)) { alreadySeen++; continue; }
      try {
        checked++;
        const verification = await verifyTransaction(sig, mint, escrow, BigInt(0));
        if (!verification.valid) continue;
        const memo = verification.memo;
        if (!memo) continue;
        let parsed: any;
        try { parsed = JSON.parse(memo); } catch { continue; }
        if (!parsed || parsed.t !== 'BET') continue;
        validWithMemo++;
        if (raceId && parsed.raceId !== raceId) continue;
        const transfers = verification.transfers || [];
        const matching = transfers.find(t => t.mint === mint.toString() && t.recipient === escrow.toString());
        const sender = matching?.sender;
        if (!sender) continue;
        if (sender !== wallet) continue;
        matchedWallet++;
        const amountStr = String(parsed.amount);
        const runnerIdx = parsed.runnerIdx;
        if (typeof runnerIdx !== 'number' || !amountStr) continue;
        const race = getDb().getRace(parsed.raceId);
        if (!race) continue;
        const bet = {
          id: `bet_${Date.now()}_${sig.slice(-8)}`, // Use tx signature suffix instead of random
          raceId: parsed.raceId,
          wallet: sender,
          runnerIdx,
          amount: amountStr,
          sig,
          ts: Date.now(),
          blockTimeMs: verification.blockTimeMs,
          slot: verification.slot,
          clientId: parsed.clientId || null,
          memo
        };
        try {
          getDb().createBet(bet);
          getDb().recordTransaction(sig);
          inserted++;
          console.log(`🧭 Rescan inserted bet for ${sender} race=${parsed.raceId} runnerIdx=${runnerIdx} amount=${amountStr}`);
        } catch (e) {
          // Ignore duplicates or constraint issues
        }
      } catch {}
    }
    before = sigInfos[sigInfos.length - 1]?.signature;
  }

  return { checked, validWithMemo, matchedWallet, inserted, alreadySeen };
}