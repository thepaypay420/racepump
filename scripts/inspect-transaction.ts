import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

const TRANSACTION_SIGNATURE = "EWhUT4sEopUCChUevWYNtSjD6dKAKFUJYNbL5djpH5rbiMCrzSZ1kcBPy57ZQvveDf4rA2rMDisWriLErTxKnsa";

interface InstructionAnalysis {
  programId: string;
  programName: string;
  accounts: string[];
  data: string;
  suspiciousFlags: string[];
}

interface AccountAnalysis {
  pubkey: string;
  role: string;
  balanceChange: number;
  isWritable: boolean;
  isSigner: boolean;
}

async function analyzeTransaction() {
  console.log("🔍 Fetching transaction:", TRANSACTION_SIGNATURE);
  console.log("📡 Using RPC:", RPC_URL);
  console.log("");

  try {
    const tx = await connection.getTransaction(TRANSACTION_SIGNATURE, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      console.error("❌ Transaction not found");
      return;
    }

    if (tx.meta?.err) {
      console.error("❌ Transaction failed:", tx.meta.err);
      return;
    }

    console.log("✅ Transaction found!");
    console.log("📊 Transaction Details:");
    console.log("   Slot:", tx.slot);
    console.log("   Block Time:", tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "N/A");
    console.log("   Fee:", tx.meta?.fee ? `${tx.meta.fee / 1e9} SOL` : "N/A");
    console.log("");

    // Analyze accounts
    const msg = tx.transaction.message as any;
    const accountKeys = (msg.staticAccountKeys || msg.accountKeys || []).map((k: any) => 
      k.toString ? k.toString() : String(k)
    );
    const writableAccounts = msg.header?.numReadonlySignedAccounts !== undefined 
      ? accountKeys.slice(0, accountKeys.length - (msg.header.numReadonlySignedAccounts + msg.header.numReadonlyUnsignedAccounts))
      : accountKeys;

    console.log("👥 Accounts in Transaction:");
    const accountAnalyses: AccountAnalysis[] = [];
    const preBalances = tx.meta?.preBalances || [];
    const postBalances = tx.meta?.postBalances || [];

    for (let i = 0; i < accountKeys.length; i++) {
      const pubkey = accountKeys[i];
      const isWritable = i < writableAccounts.length;
      const isSigner = i < (msg.header?.numRequiredSignatures || 0);
      const balanceChange = (postBalances[i] || 0) - (preBalances[i] || 0);
      
      let role = "Unknown";
      if (isSigner) role = "Signer";
      else if (isWritable) role = "Writable";
      else role = "Read-only";

      accountAnalyses.push({
        pubkey,
        role,
        balanceChange,
        isWritable,
        isSigner,
      });

      console.log(`   ${i}. ${pubkey.substring(0, 8)}...${pubkey.substring(pubkey.length - 8)}`);
      console.log(`      Role: ${role} | Balance Change: ${balanceChange / 1e9} SOL`);
    }
    console.log("");

    // Analyze instructions
    console.log("📝 Instructions:");
    const instructions = msg.compiledInstructions || msg.instructions || [];
    const instructionAnalyses: InstructionAnalysis[] = [];

    // Known program IDs
    const KNOWN_PROGRAMS: Record<string, string> = {
      "11111111111111111111111111111111": "System Program",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "Token Program",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "Token-2022 Program",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "Associated Token Program (Token-2022)",
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr": "Memo Program",
      "ComputeBudget111111111111111111111111111111": "Compute Budget",
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter V6",
      "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB": "Jupiter V4",
      "JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph": "Jupiter V3",
      "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Whirlpool",
      "So11111111111111111111111111111111111111112": "Wrapped SOL",
    };

    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      const programIdIndex = typeof ix.programIdIndex === 'number' 
        ? ix.programIdIndex 
        : ix.programIdIndex?.toNumber?.() ?? 0;
      const programId = accountKeys[programIdIndex];
      const programName = KNOWN_PROGRAMS[programId] || "Unknown Program";
      
      const accountIndices = ix.accountKeyIndexes || ix.accounts || [];
      const accounts = accountIndices.map((idx: number) => accountKeys[idx]);

      let data = "";
      if (ix.data) {
        if (typeof ix.data === 'string') {
          data = ix.data;
        } else if (ix.data instanceof Uint8Array || (ix.data as any).length !== undefined) {
          try {
            // Try to decode as UTF-8 first
            const utf8 = Buffer.from(ix.data as Uint8Array).toString('utf8');
            if (/^[\x20-\x7E]*$/.test(utf8)) {
              data = utf8;
            } else {
              data = bs58.encode(ix.data as Uint8Array);
            }
          } catch {
            data = bs58.encode(ix.data as Uint8Array);
          }
        }
      }

      const suspiciousFlags: string[] = [];

      // Check for suspicious patterns
      if (programName === "Unknown Program") {
        suspiciousFlags.push("Unknown program ID");
      }

      // Check for token transfers to unknown addresses
      if (programName.includes("Token") && accounts.length >= 2) {
        // Token transfers are common, but check for unusual patterns
        if (accounts.length > 10) {
          suspiciousFlags.push("Unusually high number of accounts in token instruction");
        }
      }

      // Check for memo with suspicious content
      if (programName === "Memo Program") {
        try {
          const memoData = typeof data === 'string' && data.length > 0
            ? (data.startsWith('base64:') ? Buffer.from(data.slice(7), 'base64').toString('utf8')
              : bs58.decode(data).toString('utf8'))
            : "";
          if (memoData.toLowerCase().includes('approve') || 
              memoData.toLowerCase().includes('permit') ||
              memoData.toLowerCase().includes('authorize')) {
            suspiciousFlags.push("Memo contains approval-like keywords");
          }
        } catch {}
      }

      // Check for multiple signers (could indicate multi-sig or delegation)
      const signerCount = accountAnalyses.filter(a => a.isSigner).length;
      if (signerCount > 1) {
        suspiciousFlags.push("Multiple signers (could indicate delegation)");
      }

      instructionAnalyses.push({
        programId,
        programName,
        accounts,
        data: data.substring(0, 100) + (data.length > 100 ? "..." : ""),
        suspiciousFlags,
      });

      console.log(`   Instruction ${i + 1}:`);
      console.log(`      Program: ${programName} (${programId.substring(0, 8)}...)`);
      console.log(`      Accounts: ${accounts.length}`);
      if (accounts.length > 0 && accounts.length <= 5) {
        accounts.forEach((acc, idx) => {
          const accAnalysis = accountAnalyses.find(a => a.pubkey === acc);
          console.log(`         ${idx}: ${acc.substring(0, 8)}...${acc.substring(acc.length - 8)} (${accAnalysis?.role || 'unknown'})`);
        });
      }
      if (data) {
        console.log(`      Data: ${data.substring(0, 50)}${data.length > 50 ? "..." : ""}`);
      }
      if (suspiciousFlags.length > 0) {
        console.log(`      ⚠️  Flags: ${suspiciousFlags.join(", ")}`);
      }
      console.log("");
    }

    // Analyze token transfers
    console.log("🪙 Token Transfers:");
    const preTokenBalances = tx.meta?.preTokenBalances || [];
    const postTokenBalances = tx.meta?.postTokenBalances || [];
    
    if (preTokenBalances.length === 0 && postTokenBalances.length === 0) {
      console.log("   No token transfers detected");
    } else {
      const tokenTransfers = new Map<string, { mint: string; owner: string; pre: bigint; post: bigint }>();
      
      for (const balance of preTokenBalances) {
        const key = `${balance.accountIndex}-${balance.mint}`;
        const amount = BigInt(balance.uiTokenAmount?.amount || "0");
        tokenTransfers.set(key, {
          mint: balance.mint,
          owner: balance.owner || "",
          pre: amount,
          post: BigInt(0),
        });
      }
      
      for (const balance of postTokenBalances) {
        const key = `${balance.accountIndex}-${balance.mint}`;
        const existing = tokenTransfers.get(key);
        const amount = BigInt(balance.uiTokenAmount?.amount || "0");
        if (existing) {
          existing.post = amount;
        } else {
          tokenTransfers.set(key, {
            mint: balance.mint,
            owner: balance.owner || "",
            pre: BigInt(0),
            post: amount,
          });
        }
      }

      // Track balances by owner and mint to detect leftovers
      const balancesByOwnerMint = new Map<string, Map<string, { pre: bigint; post: bigint }>>();
      
      for (const [key, transfer] of tokenTransfers.entries()) {
        const delta = transfer.post - transfer.pre;
        if (delta !== BigInt(0)) {
          const decimals = preTokenBalances.find(b => b.mint === transfer.mint)?.uiTokenAmount?.decimals || 9;
          const displayAmount = Number(delta) / Math.pow(10, decimals);
          console.log(`   ${delta > 0 ? "➕" : "➖"} ${displayAmount} tokens (mint: ${transfer.mint.substring(0, 8)}...)`);
          console.log(`      Owner: ${transfer.owner.substring(0, 8)}...${transfer.owner.substring(transfer.owner.length - 8)}`);
          
          // Track for leftover detection
          if (!balancesByOwnerMint.has(transfer.owner)) {
            balancesByOwnerMint.set(transfer.owner, new Map());
          }
          const ownerMap = balancesByOwnerMint.get(transfer.owner)!;
          if (!ownerMap.has(transfer.mint)) {
            ownerMap.set(transfer.mint, { pre: BigInt(0), post: BigInt(0) });
          }
          const balance = ownerMap.get(transfer.mint)!;
          balance.pre += transfer.pre;
          balance.post += transfer.post;
        }
      }
      
      // Check for leftover balances (post > 0 after a swap)
      console.log("");
      console.log("🔍 Checking for leftover token balances...");
      const USDC_MINT = "EPjFWdd5AufQSSqM2Q6h2TwyhtTJqA5wGHSuMx6L8Z9X"; // USDC mint
      let foundLeftover = false;
      
      for (const [owner, mintMap] of balancesByOwnerMint.entries()) {
        for (const [mint, balance] of mintMap.entries()) {
          if (balance.post > BigInt(0) && balance.pre === BigInt(0)) {
            // New balance created
            const decimals = preTokenBalances.find(b => b.mint === mint)?.uiTokenAmount?.decimals || 9;
            const displayAmount = Number(balance.post) / Math.pow(10, decimals);
            const isUSDC = mint === USDC_MINT || mint.startsWith("EPjFWdd5");
            if (isUSDC && displayAmount > 0.0001) { // More than 0.0001 USDC
              console.log(`   ⚠️  LEFTOVER USDC DETECTED:`);
              console.log(`      Owner: ${owner.substring(0, 8)}...${owner.substring(owner.length - 8)}`);
              console.log(`      Amount: ${displayAmount} USDC`);
              console.log(`      This could cause Phantom simulation mismatch!`);
              foundLeftover = true;
            }
          } else if (balance.pre > BigInt(0) && balance.post > BigInt(0) && balance.post < balance.pre) {
            // Partial sell - this is the issue!
            const decimals = preTokenBalances.find(b => b.mint === mint)?.uiTokenAmount?.decimals || 9;
            const preAmount = Number(balance.pre) / Math.pow(10, decimals);
            const postAmount = Number(balance.post) / Math.pow(10, decimals);
            const leftover = postAmount;
            const isUSDC = mint === USDC_MINT || mint.startsWith("EPjFWdd5");
            if (isUSDC && leftover > 0.0001) {
              console.log(`   ⚠️  PARTIAL USDC SELL DETECTED:`);
              console.log(`      Owner: ${owner.substring(0, 8)}...${owner.substring(owner.length - 8)}`);
              console.log(`      Started with: ${preAmount} USDC`);
              console.log(`      Ended with: ${postAmount} USDC`);
              console.log(`      Leftover: ${leftover} USDC (NOT SOLD)`);
              console.log(`      ⚠️  THIS IS THE PROBLEM - Phantom expects full sell!`);
              foundLeftover = true;
            }
          }
        }
      }
      
      if (!foundLeftover) {
        console.log("   ✅ No significant leftover balances detected");
      }
    }
    console.log("");

    // Check for common suspicious patterns
    console.log("🔎 Suspicious Pattern Analysis:");
    const allSuspiciousFlags: string[] = [];

    // Check for unknown programs
    const unknownPrograms = instructionAnalyses.filter(ix => ix.programName === "Unknown Program");
    if (unknownPrograms.length > 0) {
      allSuspiciousFlags.push(`Contains ${unknownPrograms.length} unknown program(s)`);
      unknownPrograms.forEach(ix => {
        console.log(`   ⚠️  Unknown program: ${ix.programId}`);
      });
    }

    // Check for unusual account patterns
    const writableSigners = accountAnalyses.filter(a => a.isWritable && a.isSigner);
    if (writableSigners.length > 1) {
      allSuspiciousFlags.push("Multiple writable signers (could indicate delegation or multi-sig)");
      console.log(`   ⚠️  Multiple writable signers detected`);
    }

    // Check for large balance changes
    const largeChanges = accountAnalyses.filter(a => Math.abs(a.balanceChange) > 1e9 * 10); // > 10 SOL
    if (largeChanges.length > 0) {
      console.log(`   ⚠️  Large balance changes detected:`);
      largeChanges.forEach(acc => {
        console.log(`      ${acc.pubkey.substring(0, 8)}...: ${acc.balanceChange / 1e9} SOL`);
      });
    }

    // Check for token approvals (if we can detect them)
    const tokenInstructions = instructionAnalyses.filter(ix => 
      ix.programName.includes("Token") && ix.accounts.length >= 3
    );
    if (tokenInstructions.length > 5) {
      allSuspiciousFlags.push("Unusually high number of token instructions");
      console.log(`   ⚠️  High number of token instructions: ${tokenInstructions.length}`);
    }

    // Check transaction logs for errors or warnings
    if (tx.meta?.logMessages) {
      const errorLogs = tx.meta.logMessages.filter((log: string) => 
        log.toLowerCase().includes('error') || 
        log.toLowerCase().includes('failed') ||
        log.toLowerCase().includes('unauthorized')
      );
      if (errorLogs.length > 0) {
        allSuspiciousFlags.push("Error or warning logs detected");
        console.log(`   ⚠️  Error/warning logs:`);
        errorLogs.forEach(log => {
          console.log(`      ${log.substring(0, 100)}`);
        });
      }
    }

    console.log("");
    console.log("📋 Summary:");
    if (allSuspiciousFlags.length === 0) {
      console.log("   ✅ No obvious suspicious patterns detected");
      console.log("   ℹ️  Phantom may flag transactions based on:");
      console.log("      - Unknown or new program IDs");
      console.log("      - Unusual account patterns");
      console.log("      - Recent scam reports");
      console.log("      - Heuristic-based analysis");
    } else {
      console.log("   ⚠️  Potential issues detected:");
      allSuspiciousFlags.forEach(flag => {
        console.log(`      - ${flag}`);
      });
    }

    // Additional Phantom-specific checks
    console.log("");
    console.log("👻 Phantom-Specific Checks:");
    
    // Check if transaction involves known scam addresses (this would require a database, but we can check patterns)
    const allAddresses = accountAnalyses.map(a => a.pubkey);
    const shortAddresses = allAddresses.filter(addr => {
      // Check for addresses that might be suspicious (this is heuristic)
      // In reality, Phantom uses a database of known scam addresses
      return false; // Placeholder
    });

    // Check for delegation patterns
    const hasDelegation = instructionAnalyses.some(ix => 
      ix.programName === "System Program" && 
      ix.accounts.length >= 2 &&
      accountAnalyses.find(a => a.pubkey === ix.accounts[0] && a.isSigner)
    );
    if (hasDelegation) {
      console.log("   ⚠️  Possible delegation detected (System Program with signer)");
    }

    // Check transaction size
    const txSize = JSON.stringify(tx).length;
    if (txSize > 100000) {
      console.log(`   ⚠️  Large transaction size: ${txSize} bytes`);
    }

    console.log("");
    console.log("💡 Recommendations:");
    console.log("   1. Verify all program IDs are from trusted sources");
    console.log("   2. Check that all recipient addresses are correct");
    console.log("   3. Review all instructions carefully");
    console.log("   4. If this is a legitimate transaction, Phantom's warning may be a false positive");
    console.log("   5. Consider using Solana Explorer to view the transaction in detail:");
    console.log(`      https://solscan.io/tx/${TRANSACTION_SIGNATURE}`);
    console.log(`      https://explorer.solana.com/tx/${TRANSACTION_SIGNATURE}`);

  } catch (error) {
    console.error("❌ Error analyzing transaction:", error);
    if (error instanceof Error) {
      console.error("   Message:", error.message);
      console.error("   Stack:", error.stack);
    }
  }
}

analyzeTransaction().catch(console.error);
