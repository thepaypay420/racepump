# Raceswap CPI - Root Cause and Solution

## ❌ Root Cause
Error 0x1789 occurs because we're using Jupiter's HTTP `/swap` endpoint which generates transactions for **regular wallet signing**, not **PDA signing via invoke_signed**.

When Jupiter's `/swap` API receives our PDA address, it creates an instruction that expects a regular Ed25519 signature. But when we try to execute via `invoke_signed`, Jupiter validates the accounts BEFORE the PDA signature is provided, causing the validation to fail.

## 🔍 Evidence
- Error happens after only ~2800-2991 compute units (validation phase)
- Occurs with both $RACE and USDC tokens (not token-specific)
- Tried 3 different is_signer flag strategies - all failed
- Transaction structure is correct but CPI execution fails

## ✅ Correct Solutions

### Option 1: Use jupiter-cpi Rust Crate (Recommended for Production)
```toml
# Cargo.toml
[dependencies]
jupiter-cpi = { git = "https://github.com/jup-ag/jupiter-cpi" }
```

**Pros:**
- Official Jupiter CPI support
- Designed specifically for PDA-based swaps
- Well-tested and maintained

**Cons:**
- Requires significant refactoring of our Anchor program
- Need to rebuild client-side integration
- More complex setup

### Option 2: Use Jupiter's SharedAccountsRoute Instruction
Jupiter V6 provides a `SharedAccountsRoute` instruction designed for CPI calls.

```rust
// Use Jupiter's IDL to build the instruction
use jupiter::instruction::SharedAccountsRoute;

// Build instruction manually from quote data
let ix = shared_accounts_route(
    // ... accounts
    route_plan,
    in_amount,
    quoted_out_amount,
    slippage_bps,
);
```

**Pros:**
- Works with our current architecture
- No major refactoring needed
- Official CPI method

**Cons:**
- Requires understanding Jupiter's IDL structure
- Need to manually build instruction from quote

### Option 3: Simpler Alternative - Direct DEX Integration
Instead of using Jupiter aggregator, integrate directly with a single DEX like:
- Raydium
- Orca Whirlpool
- Meteora

**Pros:**
- Simpler CPI calls
- Better control over swap execution
- Smaller transaction sizes

**Cons:**
- Not as optimal pricing as Jupiter
- Need to handle routing manually
- More code to maintain

## 🚀 Recommended Next Steps

### Immediate Action (for testing):
1. **Temporarily disable raceswap** until we implement proper CPI
2. Use direct Raydium/Orca swap for meme rewards
3. Get the platform operational

### Long-term Fix (production):
1. Integrate `jupiter-cpi` crate into our Anchor program
2. Refactor to use `SharedAccountsRoute` instruction
3. Update client to work with new CPI approach
4. Thorough testing on devnet first

## 📚 Resources
- Jupiter CPI Docs: https://station.jup.ag/docs/apis/cpi
- Jupiter CPI Crate: https://github.com/jup-ag/jupiter-cpi
- Example: https://github.com/jup-ag/sol-swap-cpi
- Shared Accounts Route: https://docs.jup.ag/docs/apis/cpi#shared-accounts-route

## 💡 Key Takeaway
**You CANNOT replay HTTP API swap transactions via CPI**. You MUST use either:
- The `jupiter-cpi` Rust crate
- Manual instruction building with Jupiter's IDL
- Direct DEX integration

The HTTP `/swap` endpoint is designed for client-side wallet signing, not program-side PDA signing.
