# Raceswap V2 - Simplified Architecture

## The Problem with V1
- V1 used a custodial vault owned by swap_authority PDA
- Jupiter CPI required swap_authority to sign
- Solana automatically marks PDAs as signers in AccountInfo
- This created AccountMeta vs AccountInfo mismatch → Error 0x1789

## V2 Solution: Non-Custodial Passthrough

### Architecture
```
User (owns tokens) 
  ↓
Raceswap Program (validates + takes fee)
  ↓  
Jupiter Program (user signs)
  ↓
User (receives output)
```

### Key Changes
1. **No vault** - User keeps token ownership throughout
2. **User signs for Jupiter** - No PDA signer conflicts
3. **Program is coordinator** - Just validates and executes
4. **Fee in SOL** - Taken before swap via system_program::transfer

### Flow (Single Leg - MVP)
1. User calls `execute_swap` with Jupiter quote data
2. Program takes 0.2% treasury fee in SOL
3. Program invokes Jupiter CPI with user's accounts
4. User's signer privilege flows through automatically
5. Output goes to user's destination ATA

### After MVP Works: Add Reflection Leg
- Before Jupiter swap, calculate RACE amount (2%)
- Do TWO Jupiter swaps:
  1. Main swap: 98% of input → output mint
  2. Reflection swap: 2% of input → RACE token
- Both use user as signer
- No custody needed!

## Why This Works
- User owns all accounts → User signs → No PDA issues
- Jupiter sees user as the signer (correct!)
- No AccountMeta/AccountInfo mismatch
- Clean, simple, working

## Next Steps
1. ✅ Create simplified program (lib_v2_simple.rs)
2. Test with SOL → USDC swap
3. If works, add reflection leg
4. If works, replace old lib.rs
