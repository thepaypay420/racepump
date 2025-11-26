# Raceswap V3 Deployment Guide

## Prerequisites

1. **Anchor CLI v0.30.1** installed
   ```bash
   cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked
   ```

2. **Solana CLI** installed and configured
   ```bash
   solana config set --url mainnet-beta
   solana config set --keypair ~/.config/solana/id.json
   ```

3. **Sufficient SOL** for deployment (~2-3 SOL for program deployment)

## Build V3 Program

```bash
# From project root
cd programs/raceswap-v3

# Build the program
anchor build --program-name raceswap-v3

# Verify build
ls -lh ../../target/deploy/raceswap_v3.so
```

## Deploy to Mainnet

The V3 program reuses the same program ID as V2:
```
Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk
```

### Option 1: Upgrade Existing Program (Recommended)

If you have upgrade authority for the existing program:

```bash
solana program deploy \
  --program-id Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk \
  target/deploy/raceswap_v3.so \
  --upgrade-authority ~/.config/solana/id.json
```

### Option 2: Deploy Fresh (If New Program ID)

If using a new program ID, update `declare_id!` in `src/lib.rs` first:

```bash
# Generate new keypair
solana-keygen new -o target/deploy/raceswap_v3-keypair.json

# Get the program ID
solana address -k target/deploy/raceswap_v3-keypair.json

# Update src/lib.rs with the new ID
# declare_id!("YOUR_NEW_PROGRAM_ID_HERE");

# Rebuild
anchor build --program-name raceswap-v3

# Deploy
solana program deploy \
  target/deploy/raceswap_v3.so \
  --keypair target/deploy/raceswap_v3-keypair.json
```

## Verify Deployment

```bash
# Check program account
solana program show Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk

# View on Solscan
open https://solscan.io/account/Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk
```

## Test V3

Once deployed, run the test script with real SOL:

```bash
node scripts/test-v3-real.mjs
```

Expected output:
```
🚀 Testing Raceswap V3 with REAL SOL (Index-Based Architecture)
...
✅ Simulation successful!
✅ TRANSACTION SENT: <signature>
🎉 V3 SWAP SUCCESSFUL!
✅ Index-based architecture working perfectly
✅ 97% size reduction achieved
```

## V3 Improvements Over V2

| Metric | V2 | V3 | Improvement |
|--------|----|----|-------------|
| Account metadata size | 714 bytes (21 × 34) | 21 bytes (21 × 1) | **97% reduction** |
| Instruction data | ~780 bytes | ~75 bytes | **90% reduction** |
| Transaction size | 1953 bytes (TOO LARGE) | ~350 bytes | **Fits within limits** ✅ |
| Max swap complexity | Limited (simple swaps only) | Unlimited (complex multi-hop) | **No limitations** ✅ |

## Architecture Changes

### V2 (Full Metadata)
```rust
pub struct ExecuteSwapParams {
    pub amount: u64,
    pub min_out: u64,
    pub jupiter_accounts: Vec<SerializableAccountMeta>,  // 34 bytes each
    pub jupiter_data: Vec<u8>,
}
```

### V3 (Indices)
```rust
pub struct ExecuteSwapParams {
    pub amount: u64,
    pub min_out: u64,
    pub jupiter_account_indices: Vec<u8>,  // 1 byte each!
    pub jupiter_data: Vec<u8>,
}
```

The program reconstructs AccountMeta from indices:
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

## Client Integration

### Frontend

```typescript
import { executeRaceswapV3 } from '@/lib/raceswap-v3';

// Execute swap
const signature = await executeRaceswapV3(
  connection,
  wallet,
  SOL_MINT,
  USDC_MINT,
  0.01 * 1e9,  // 0.01 SOL
  50  // 0.5% slippage
);

console.log('Swap successful:', signature);
```

### Test Page

Update `/test-v2` to use V3:

```typescript
import { getJupiterSwapDataV3, buildRaceswapV3Transaction } from '@/lib/raceswap-v3';

const { quoteData, swapData, lookupTables } = await getJupiterSwapDataV3(
  connection,
  wallet.publicKey,
  SOL_MINT,
  USDC_MINT,
  amount,
  50
);

const tx = await buildRaceswapV3Transaction(
  connection,
  wallet,
  swapData,
  BigInt(amount),
  BigInt(quoteData.outAmount),
  lookupTables
);

const signed = await wallet.signTransaction(tx);
const signature = await connection.sendRawTransaction(signed.serialize());
```

## Troubleshooting

### Build Errors

**Error**: `anchor: command not found`
```bash
# Install Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked
```

**Error**: `failed to compile`
```bash
# Update Rust toolchain
rustup update
rustup component add rust-src
```

### Deployment Errors

**Error**: `Insufficient funds`
```bash
# Check balance
solana balance

# Transfer SOL to deployer wallet
solana transfer <DEPLOYER_ADDRESS> 3 --from <SOURCE_KEYPAIR>
```

**Error**: `Invalid upgrade authority`
```bash
# Check current upgrade authority
solana program show Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk | grep "Upgrade Authority"

# Transfer upgrade authority if needed
solana program set-upgrade-authority \
  Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk \
  --new-upgrade-authority <YOUR_KEYPAIR_PATH>
```

### Test Errors

**Error**: `Program failed to complete`
- Check logs with `--skip-preflight false`
- Verify program is deployed correctly
- Ensure sufficient SOL for rent + fees

**Error**: `Transaction too large`
- This should NOT happen with V3!
- If it does, verify you're using index-based serialization
- Check instruction data size in logs

## Support

For issues or questions:
1. Check Solscan transaction logs
2. Review program logs with `-v` flag
3. Test with smaller amounts first (0.001 SOL)
4. Verify Jupiter API is accessible

---

**Ready to deploy?** Run `./scripts/deploy-v3.sh` or follow the manual steps above!
