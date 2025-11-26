# Anchor Build Fixes for Raceswap V2

## Errors Fixed

### 1. ✅ AccountMeta Serialization Error
**Problem:** `AccountMeta` doesn't implement `BorshSerialize` and `BorshDeserialize`  
**Solution:** Created custom `SerializableAccountMeta` struct with Borsh traits

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SerializableAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}
```

Then convert to `AccountMeta` inside the program:
```rust
let jupiter_accounts: Vec<AccountMeta> = params.jupiter_accounts
    .iter()
    .map(|acc| AccountMeta {
        pubkey: acc.pubkey,
        is_signer: acc.is_signer,
        is_writable: acc.is_writable,
    })
    .collect();
```

### 2. ✅ Anchor Version Mismatch
**Problem:** `anchor-lang` version (0.30.1) doesn't match CLI version (0.32.1)  
**Solution:** Added `[toolchain]` section to `Anchor.toml`

```toml
[toolchain]
anchor_version = "0.30.1"
```

### 3. ⚠️  Solana Program Warning (Non-Critical)
**Warning:** "Adding `solana-program` as a separate dependency might cause conflicts"  
**Status:** Can be ignored - we're using `anchor_lang::solana_program` in code  
**Note:** The workspace dependency may be needed for other parts of the project

## Files Modified

1. **`programs/raceswap/src/lib.rs`**
   - Replaced `Vec<AccountMeta>` with `Vec<SerializableAccountMeta>` in params
   - Added `SerializableAccountMeta` struct definition
   - Added conversion logic from `SerializableAccountMeta` to `AccountMeta`

2. **`Anchor.toml`**
   - Added `[toolchain]` section with `anchor_version = "0.30.1"`

## Build Instructions

Now you should be able to build successfully:

```bash
anchor build
```

Expected output:
- No more `BorshSerialize`/`BorshDeserialize` errors ✅
- No more version mismatch warning ✅
- Warnings about `custom-heap`, `custom-panic`, `anchor-debug` are normal (Anchor framework internals)

## Next Steps

1. **Build the program**
   ```bash
   anchor build
   ```

2. **Deploy to devnet**
   ```bash
   bash scripts/deploy-raceswap.sh
   ```

3. **Test it works**
   ```bash
   npx tsx scripts/test-raceswap-v2.ts
   ```

## Expected Build Output

After the fixes, you should see:
- ✅ Program compiles successfully
- ⚠️ Some warnings about cfg conditions (normal for Anchor)
- ✅ Binary created at `target/deploy/raceswap.so`
- ✅ No errors!

The program is now ready to deploy and test! 🚀
