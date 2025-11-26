# Raceswap Anchor Program Deployment Guide

## Critical Bug Fix Applied ✅

**Issue:** The Raceswap Anchor program was failing Jupiter CPI calls with error `0x1789` (slippage tolerance exceeded) because it wasn't preserving Jupiter's original `is_signer` and `is_writable` account flags.

**Root Cause:** When Jupiter builds a swap instruction, it marks certain accounts with specific permission flags. Our CPI wrapper was ignoring these flags and using the accounts' actual status instead, causing Jupiter's validation to fail.

**Fix:** Updated the Anchor program to preserve and use Jupiter's original account permission flags during CPI calls.

## Files Modified

### Rust (Anchor Program)
**File:** `programs/raceswap/src/lib.rs`

Changes:
- Added `is_writable: Vec<bool>` and `is_signer: Vec<bool>` to `SerializedInstruction` struct
- Updated `perform_jupiter_swap` function to use Jupiter's original account flags instead of account's actual status

### TypeScript (Client & Server)
**File:** `client/src/lib/raceswap.ts`
- Updated `SerializedInstructionPayload` type with `isWritable` and `isSigner` fields
- Modified `encodeSerializedInstructionPayload` to serialize boolean arrays in Borsh format
- Updated `encodeLeg` function to accept and pass through signer/writable flags

**File:** `server/raceswap.ts`
- No changes needed (already extracts `isSigner` and `isWritable` from Jupiter instructions)

## Deployment Instructions

### Prerequisites

You'll need a development machine with:

1. **Rust & Cargo** (1.75 or newer)
   - Install: https://rustup.rs/
   
2. **Solana CLI** (1.17 or newer)
   - Install: https://docs.solanalabs.com/cli/install
   
3. **Anchor CLI** (0.29 or newer)
   - Install: https://www.anchor-lang.com/docs/installation

### Step 1: Get the Updated Code

If deploying from a different machine, you'll need:
- `programs/raceswap/src/lib.rs` (updated with CPI fix)
- `programs/raceswap/Cargo.toml`
- `Anchor.toml`
- `deploy-keypair.json` (upgrade authority keypair)

### Step 2: Build the Program

```bash
# Navigate to project root
cd /path/to/pumpbets

# Build with Anchor
anchor build

# Verify the build succeeded
ls -lh target/deploy/raceswap.so
```

Expected output:
```
-rw-r--r-- 1 user user 400K Nov 23 12:00 target/deploy/raceswap.so
```

### Step 3: Deploy to Mainnet

**IMPORTANT:** This updates the LIVE program on Solana mainnet. Double-check you have the correct upgrade authority.

#### Option A: Using the Deployment Script (Recommended)

```bash
# Make executable
chmod +x deploy-raceswap.sh

# Run deployment
./deploy-raceswap.sh
```

The script will:
- ✅ Check prerequisites
- ✅ Build the program
- ✅ Verify program ID matches
- ✅ Show upgrade authority
- ✅ Estimate costs
- ✅ Ask for confirmation before deploying
- ✅ Deploy to mainnet

#### Option B: Manual Deployment

```bash
# Set network
solana config set --url https://api.mainnet-beta.solana.com

# Deploy
solana program deploy target/deploy/raceswap.so \
  --program-id Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk \
  --upgrade-authority deploy-keypair.json \
  --keypair deploy-keypair.json \
  -v
```

### Step 4: Verify Deployment

```bash
# Check program on mainnet
solana program show Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk \
  --url mainnet-beta
```

Look for:
- ✅ Program data shows updated hash
- ✅ Upgrade authority matches your keypair
- ✅ Program is executable

### Step 5: Test the Fix

1. Navigate to https://racepump.fun
2. Connect your wallet
3. Try a raceswap transaction (SOL → $RACE or $RACE → SOL)
4. Verify the transaction succeeds without error 0x1789
5. Check transaction on Solana Explorer:
   - Should show successful inner instructions
   - Jupiter CPI call should complete without errors

## What Changed in the Code

### Before (Broken):
```rust
// programs/raceswap/src/lib.rs - perform_jupiter_swap()
metas.push(AccountMeta {
    pubkey: *account.key,
    is_signer: account.is_signer,      // ❌ Wrong - uses account's actual status
    is_writable: account.is_writable,  // ❌ May not match Jupiter's expectations
});
```

### After (Fixed):
```rust
// programs/raceswap/src/lib.rs - perform_jupiter_swap()
let is_writable = payload.is_writable.get(consumed).copied().unwrap_or(account.is_writable);
let is_signer = payload.is_signer.get(consumed).copied().unwrap_or(false);

metas.push(AccountMeta {
    pubkey: *account.key,
    is_signer,      // ✅ Uses Jupiter's original flag
    is_writable,    // ✅ Matches Jupiter's instruction data
});
```

## Cost Estimate

Deploying a Solana program to mainnet costs approximately:
- **Program deployment**: 0.5-2 SOL (depends on program size)
- **Transaction fees**: ~0.00001 SOL

**Total**: Approximately **0.5-2 SOL**

Make sure the upgrade authority account has sufficient SOL balance.

## Rollback Plan

If issues occur after deployment, you can redeploy a previous version:

```bash
# If you have a backup of the old binary
solana program deploy target/deploy/raceswap-backup.so \
  --program-id Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk \
  --upgrade-authority deploy-keypair.json \
  --keypair deploy-keypair.json
```

**Note:** Always keep a backup of working program binaries before deploying updates.

## Program Details

- **Program ID**: `Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk`
- **Network**: Solana Mainnet Beta
- **Upgrade Authority**: Escrow wallet (from `deploy-keypair.json`)
- **Jupiter Program**: `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` (v6)

## Troubleshooting

### Build Errors

**Error**: `package icu_properties_data requires rustc 1.82 or newer`
**Fix**: Update Rust to latest version: `rustup update`

**Error**: `no such command: build-bpf`
**Fix**: Install Solana build tools: `solana-install init`

### Deployment Errors

**Error**: `Insufficient funds`
**Fix**: Add more SOL to upgrade authority account

**Error**: `Invalid keypair`
**Fix**: Verify `deploy-keypair.json` contains the correct upgrade authority private key

**Error**: `Program is not upgradeable`
**Fix**: Verify the program's upgrade authority matches your keypair:
```bash
solana program show Cy63SzwBBCP5ywaByjUrLuUXQ4pXP9nR7e7kdQqp5uLk | grep "Upgrade Authority"
solana-keygen pubkey deploy-keypair.json
```

### Testing Errors

**Error**: Transaction still fails with 0x1789
**Possible causes**:
1. TypeScript client code not updated (check both client and server deployed latest versions)
2. Jupiter quote expired (retry the transaction)
3. Actual slippage exceeded tolerance (increase slippage in settings)

## Support

For deployment assistance:
1. Check Solana network status: https://status.solana.com/
2. Verify RPC endpoint is responding
3. Check Anchor version compatibility
4. Review Solana Explorer for failed transactions
