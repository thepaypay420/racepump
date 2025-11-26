# Raceswap V2 - Complete Rebuild

## Problem Summary
After 5+ attempts to fix error 0x1789, we identified the root cause:
- **V1 used custodial vault owned by swap_authority PDA**
- Jupiter CPI validation requires AccountMeta.is_signer == AccountInfo.is_signer  
- Solana automatically marks PDAs as signers in AccountInfo
- This creates unfixable mismatch → Error 0x1789

## V2 Solution: Non-Custodial Architecture

### Key Changes
1. ✅ **No PDA vault** - User owns all tokens throughout the swap
2. ✅ **User signs for Jupiter** - No swap_authority in Jupiter account list
3. ✅ **Program coordinates** - Takes fee and executes CPI
4. ✅ **SOL fee only (MVP)** - Simplest working version first

### Architecture Flow
```
User (owns input tokens)
  ↓ [calls execute_swap]
Raceswap Program
  ├─ Takes 0.2% fee in SOL
  └─ Invokes Jupiter CPI
       ↓ [user's signer privilege flows through]
Jupiter Program
  ↓ [executes swap]
User (receives output tokens)
```

### Why This Works
- User owns input/output ATAs → Jupiter expects USER to sign ✅
- User IS signing the transaction ✅  
- No swap_authority PDA in Jupiter's account list ✅
- No AccountMeta/AccountInfo mismatch ✅

## Files Changed

### Program Code
- `programs/raceswap/src/lib.rs` - **REPLACED** with V2 simplified version
- `programs/raceswap/src/lib_v1_broken.rs` - Backup of old custodial version
- `programs/raceswap/src/lib_v2_simple.rs` - Source of V2 implementation

### New V2 Program Structure
```rust
pub fn execute_swap(ctx: Context<ExecuteSwap>, params: ExecuteSwapParams) -> Result<()> {
    // 1. Take treasury fee in SOL (0.2% = 20 bps)
    system_program::transfer(..., treasury_fee_lamports)?;
    
    // 2. Execute Jupiter swap via CPI (user signs)
    let jupiter_ix = Instruction { ... };
    invoke(&jupiter_ix, &account_infos)?;  // ← USER signer flows through!
    
    Ok(())
}
```

### Key Differences from V1
| V1 (Broken) | V2 (Working) |
|-------------|--------------|
| Custodial vault owned by PDA | User owns tokens |
| swap_authority signs for Jupiter | User signs for Jupiter |
| Complex transfer-to-vault logic | Direct Jupiter pass-through |
| Token fee splitting on-chain | SOL fee only (for MVP) |
| Error 0x1789 | Should work! ✅ |

## Deployment Steps

### 1. Build Program (Local Cursor Environment)
```bash
cd /path/to/racepump
anchor build
```

### 2. Deploy to Devnet
```bash
# Option A: Use deploy script
bash scripts/deploy-raceswap.sh

# Option B: Manual deploy  
solana program deploy target/deploy/raceswap.so \
  --program-id target/deploy/raceswap-keypair.json \
  --url https://api.devnet.solana.com
```

### 3. Verify Deployment
```bash
solana program show Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk --url devnet
```

### 4. Test Client-Side
```bash
npx tsx scripts/test-raceswap-v2.ts
```

## Next Steps (After MVP Works)

### Phase 2: Add RACE Reflection
Once we verify the single-leg swap works, add dual-leg support:
1. Calculate split: 98% main swap + 2% RACE reflection
2. Execute TWO Jupiter swaps:
   - Leg 1: 98% input → output_mint
   - Leg 2: 2% input → RACE token  
3. Both legs use user as signer (no custody)

### Phase 3: Optimize
- Add minimum output validation
- Implement slippage protection  
- Add event logging for analytics
- Consider batching for gas efficiency

## Testing Checklist
- [ ] Program builds successfully
- [ ] Program deploys without errors
- [ ] Client can create ExecuteSwap transaction
- [ ] Transaction simulates successfully (no 0x1789!)
- [ ] Swap executes and user receives output tokens
- [ ] Treasury receives SOL fee  
- [ ] Add RACE reflection leg
- [ ] Test dual-leg swap end-to-end

## Expected Outcomes
✅ **No more 0x1789 errors** - User signs, not PDA  
✅ **Simpler architecture** - Less code, fewer failure points  
✅ **Easier to extend** - Can add reflection leg after MVP works  
✅ **Better UX** - User keeps control of tokens throughout

---

**Status**: Ready for local build & deploy
**Program ID**: Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk (will be replaced with V2 code)
