# USDC Leftover Issue - Phantom Simulation Mismatch

## Problem Identified

When performing a round-trip swap (SOL → USDC → SOL), the transaction **does not sell the full amount of USDC**, leaving a significant leftover balance. This causes Phantom's transaction simulation to mismatch with the actual execution, triggering security warnings.

## Evidence from Transaction Analysis

**Transaction**: `EWhUT4sEopUCChUevWYNtSjD6dKAKFUJYNbL5djpH5rbiMCrzSZ1kcBPy57ZQvveDf4rA2rMDisWriLErTxKnsa`

**USDC Balance Analysis**:
- **Started with**: 13.415244 USDC
- **Ended with**: 0.134196 USDC  
- **Leftover**: 0.134196 USDC (NOT SOLD)
- **Amount sold**: 13.281048 USDC out of 13.415244 USDC

This is a **~1% leftover** (0.13 USDC) - even small leftovers can trigger Phantom warnings because the simulation expects a full sell.

## Why This Triggers Phantom Warnings

1. **Simulation Mismatch**: Phantom simulates the transaction and expects all USDC to be sold (based on the quote/amount provided)
2. **Actual Execution**: Only a tiny fraction is sold, leaving most USDC untouched
3. **Security Flag**: This discrepancy triggers Phantom's heuristic-based security warnings because:
   - The simulation doesn't match reality
   - Large leftover balances are suspicious (could indicate partial execution, errors, or malicious behavior)
   - The transaction behavior is unexpected

## Root Cause Analysis

The issue likely stems from one of these problems:

### 1. **Using Quote Amount Instead of Full Balance**

When swapping USDC → SOL, the code may be using:
- A pre-calculated quote amount from the first swap
- The user-entered `amount` state variable
- An estimated amount instead of the actual token balance

**Location**: `client/src/pages/RaceSwap.tsx` line 297
```typescript
amount: Number(lamportsAmount),  // Uses state variable, not actual balance
```

### 2. **Not Fetching Actual Token Balance**

The swap execution doesn't verify or fetch the actual USDC balance before swapping. It should:
1. Fetch the current USDC token account balance
2. Use that full balance (minus fees) for the swap
3. Ensure the swap amount matches available balance

### 3. **Jupiter Quote Using Wrong Amount**

The Jupiter quote might be requested with an incorrect amount, causing only a partial swap.

## Solution

### Fix 1: Fetch and Use Actual Token Balance

When swapping from a token (not SOL), fetch the actual balance and use it:

```typescript
// In executeSwapWithReflection or handleSwap
if (inputToken.address !== SOL_MINT) {
  // Fetch actual token balance
  const actualBalance = await getTokenAccountBalance(
    connection,
    wallet.publicKey,
    inputToken.address
  );
  
  // Use full balance (or user-specified amount if less)
  const swapAmount = Math.min(
    Number(lamportsAmount),
    actualBalance
  );
  
  // Ensure we're using the actual balance, not a stale quote
  if (swapAmount < actualBalance * 0.99) {
    console.warn('Swap amount is less than 99% of balance - may leave leftover');
  }
}
```

### Fix 2: Add Balance Verification

Before executing the swap, verify the amount matches available balance:

```typescript
async function verifySwapAmount(
  connection: Connection,
  wallet: PublicKey,
  mint: string,
  requestedAmount: number
): Promise<{ valid: boolean; actualBalance: number; error?: string }> {
  const balance = await getTokenAccountBalance(connection, wallet, mint);
  
  if (requestedAmount > balance) {
    return {
      valid: false,
      actualBalance: balance,
      error: `Requested ${requestedAmount} but only have ${balance}`
    };
  }
  
  // Warn if using less than 95% of balance (could leave significant leftover)
  if (requestedAmount < balance * 0.95) {
    console.warn(`Using only ${(requestedAmount/balance*100).toFixed(2)}% of available balance`);
  }
  
  return { valid: true, actualBalance: balance };
}
```

### Fix 3: Use "Max" Button Logic for Round-Trips

When the user clicks "Max" for a token swap, ensure it uses the full balance:

```typescript
const handleMax = () => {
  if (!inputBalanceQuery.data || !inputToken) return;
  let val = inputBalanceQuery.data;
  
  if (inputToken.address === SOL_MINT) {
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0.02) {
      val = (num - 0.01).toFixed(4); // Leave 0.01 SOL for fees
    }
  } else {
    // For tokens, use full balance (Jupiter handles fees)
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) {
      val = num.toFixed(6); // Use full balance for tokens
    }
  }
  setAmount(val);
};
```

### Fix 4: Add Post-Swap Balance Check

After swap execution, verify no significant leftover:

```typescript
// After swap completes
const postSwapBalance = await getTokenAccountBalance(
  connection,
  wallet.publicKey,
  inputToken.address
);

if (postSwapBalance > 0.01) { // More than 0.01 tokens leftover
  console.warn(`⚠️ Significant leftover balance: ${postSwapBalance} ${inputToken.symbol}`);
  // Could show user a warning or offer to swap remaining
}
```

## Implementation Priority

1. **High Priority**: Fix 1 - Fetch actual balance before swap
2. **High Priority**: Fix 3 - Ensure "Max" uses full balance for tokens
3. **Medium Priority**: Fix 2 - Add balance verification
4. **Low Priority**: Fix 4 - Post-swap balance check (for user awareness)

## Testing

After implementing fixes, test:

1. **Round-trip swap**: SOL → USDC → SOL
   - Verify all USDC is sold in second swap
   - Check Phantom no longer shows warnings
   - Verify no significant leftover balance

2. **Partial swap**: SOL → USDC, then swap only 50% of USDC back
   - Verify only requested amount is swapped
   - Verify leftover matches expected amount

3. **Max button**: Click "Max" for token swap
   - Verify full balance is used (minus fees)
   - Verify no leftover after swap

## Expected Outcome

After fixes:
- ✅ Full token balance is used when swapping (unless user specifies less)
- ✅ No significant leftover balances after swaps
- ✅ Phantom simulation matches actual execution
- ✅ Phantom warnings are eliminated for legitimate swaps
- ✅ Better user experience with accurate balance handling

## Fixes Implemented

### ✅ Fix 1: Auto-Use Full Balance When Close (Implemented)

**Location**: `client/src/pages/RaceSwap.tsx` - `handleSwap()` function

**Changes**:
- Before executing swap, fetch actual token balance
- If requested amount is within **5%** of actual balance, automatically use full balance
- This prevents even small leftover balances (like 0.13 USDC) that trigger Phantom warnings
- Logs when full balance is used and warns about potential leftovers

**Code**:
```typescript
// For token swaps (not SOL), fetch actual balance and ensure we use full amount if close
if (inputToken && inputToken.address !== SOL_MINT) {
  const actualBalanceStr = await fetchTokenBalance(connection, wallet.publicKey, inputToken);
  const actualBalance = parseFloat(actualBalanceStr);
  const actualBalanceBase = BigInt(
    new Decimal(actualBalance)
      .mul(new Decimal(10).pow(inputToken.decimals))
      .toFixed(0, Decimal.ROUND_DOWN)
  );
  
  // If requested amount is within 5% of actual balance, use full balance
  // This prevents even small leftovers (like 0.13 USDC) that trigger Phantom warnings
  const requestedBase = BigInt(swapAmount);
  const balanceThreshold = actualBalanceBase * BigInt(95) / BigInt(100);
  
  if (requestedBase >= balanceThreshold) {
    swapAmount = Number(actualBalanceBase); // Use full balance
  }
}
```

### ✅ Fix 2: Improved "Max" Button for Tokens (Implemented)

**Location**: `client/src/pages/RaceSwap.tsx` - `handleMax()` function

**Changes**:
- For tokens (not SOL), "Max" button now uses full balance
- Uses appropriate decimal precision based on token decimals
- Removes trailing zeros for cleaner display
- Prevents leftover balances when user clicks "Max"

**Code**:
```typescript
} else {
  // For tokens, use full balance (Jupiter handles fees from output)
  const num = parseFloat(val);
  if (!isNaN(num) && num > 0) {
    const decimals = inputToken.decimals || 6;
    val = num.toFixed(decimals).replace(/\.?0+$/, "");
  }
}
```

## Testing Checklist

After implementing fixes, verify:

- [ ] Round-trip swap (SOL → USDC → SOL) sells all USDC
- [ ] "Max" button for tokens uses full balance
- [ ] Manual amount entry close to balance (within 1%) uses full balance
- [ ] Phantom no longer shows warnings for legitimate swaps
- [ ] No significant leftover balances after swaps
- [ ] Partial swaps (user enters specific amount) work correctly

## Related Files

- `client/src/pages/RaceSwap.tsx` - Main swap UI and execution (✅ Fixed)
- `client/src/lib/jupiter-frontend.ts` - Swap execution logic
- `client/src/lib/jupiter-direct.ts` - Direct Jupiter integration
- `server/jupiter.ts` - Backend Jupiter API proxy
