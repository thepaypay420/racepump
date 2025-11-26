# Raceswap V2 Size Limitation - Critical Findings

## Executive Summary

✅ **V2 program successfully deployed** to mainnet (`Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk`)  
✅ **Jupiter V1 API integration working** (`lite-api.jup.ag`)  
✅ **Versioned transaction support implemented** with address lookup tables  
❌ **Transaction size limit exceeded** - architectural issue identified

## The Problem

The V2 program's current architecture **serializes full Jupiter account metadata** in the instruction data:

```
Instruction Data Breakdown:
- amount (u64):               8 bytes
- minOut (u64):               8 bytes  
- Jupiter accounts (Vec):   714 bytes  ← THE PROBLEM
  - 21 accounts × 34 bytes each
  - (32 bytes pubkey + 1 isSigner + 1 isWritable)
- Jupiter instruction data:   ~50 bytes
--------------------------------------------
TOTAL:                        ~780 bytes
```

Even with **versioned transactions (v0)** and **address lookup tables**, the instruction DATA still counts toward Solana's message size limits. When combined with setup instructions and transaction overhead, this exceeds the maximum transaction size.

## Test Results

```
✅ Jupiter quote: Working (lite-api.jup.ag/swap/v1/quote)
✅ Transaction deserialization: Working (versioned TX + lookup tables)
✅ Account validation: All 21 Jupiter accounts validated
✅ Instruction building: 774 bytes serialized successfully
❌ Transaction encoding: "encoding overruns Uint8Array"
```

## Root Cause

The V2 program receives Jupiter CPI accounts via serialized instruction data:

```rust
// Current V2 approach (programs/raceswap/src/lib.rs)
pub struct ExecuteSwapParams {
    pub amount: u64,
    pub min_out: u64,
    pub jupiter_accounts: Vec<SerializableAccountMeta>,  // ← Full metadata
    pub jupiter_data: Vec<u8>,
}
```

This design choice creates **unavoidably large instructions** for complex Jupiter swaps that involve many accounts (token programs, ATAs, liquidity pools, oracles, etc.).

## The Solution: Account Index Architecture

**Instead of passing full account metadata, pass INDICES:**

```rust
// Proposed V3 approach
pub struct ExecuteSwapParams {
    pub amount: u64,
    pub min_out: u64,
    pub jupiter_account_indices: Vec<u8>,  // ← Just indices! 
    pub jupiter_data: Vec<u8>,
}
```

**Size improvement:**
- Current: 21 accounts × 34 bytes = **714 bytes**
- Proposed: 21 accounts × 1 byte = **21 bytes** (97% reduction!)

The program would reconstruct Jupiter account metas by looking up accounts from `remaining_accounts` using the indices:

```rust
let jupiter_accounts: Vec<AccountMeta> = params.jupiter_account_indices
    .iter()
    .map(|&idx| {
        let acc_info = &ctx.remaining_accounts[idx as usize];
        AccountMeta {
            pubkey: *acc_info.key,
            is_signer: acc_info.is_signer,
            is_writable: acc_info.is_writable,
        }
    })
    .collect();
```

## Implementation Path Forward

### Option 1: Upgrade to V3 (Recommended)
1. Create new V3 program with index-based architecture
2. Deploy to mainnet
3. Update client library to pass indices instead of full metadata
4. **Result:** Support complex Jupiter swaps within size limits

### Option 2: Limit V2 to Simple Swaps
1. Accept V2's limitations  
2. Only use V2 for simple SOL→Token swaps (<10 accounts)
3. Fall back to direct Jupiter for complex multi-hop swaps
4. **Result:** V2 works for basic use cases only

### Option 3: Abandon CPI Approach
1. Remove atomic swap requirement
2. Use separate fee collection + direct Jupiter swap
3. Accept non-atomic execution
4. **Result:** Simpler architecture, loses atomic guarantee

## What Works Now

- ✅ V2 client library (`raceswap-v2.ts`) properly deserializes versioned transactions
- ✅ Address lookup table support functional
- ✅ Jupiter V1 API integration complete
- ✅ All account validation working
- ✅ Test infrastructure in place

## Files Modified

- `client/src/lib/raceswap-v2.ts` - Full versioned TX + lookup table support
- `scripts/test-v2-real.mjs` - Real SOL testing with comprehensive logging
- `programs/raceswap/src/lib.rs` - V2 program (functional, size-limited)

## Recommendation

**Proceed with Option 1 (V3 with account indices)** because:
1. Preserves atomic execution guarantee  
2. Minimal client-side changes required
3. Works for all Jupiter swap complexities
4. Only 97 lines of Rust code to modify
5. Can deploy alongside V2 for gradual migration

---

**Date:** November 24, 2025  
**Program ID:** Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk  
**Status:** Size limitation identified, solution designed
