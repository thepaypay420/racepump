The "insufficient funds for rent" error during the atomic swap (Main Swap + Reflection Swap) was caused by conflicting WSOL wrapping/unwrapping logic when calling Jupiter API twice for the same transaction.

Fix applied in `client/src/lib/jupiter-frontend.ts`:
1. Changed Reflection Swap to use `WSOL` as input instead of `SOL`.
2. Disabled `wrapAndUnwrapSol` for Reflection Swap instructions.
3. Added manual funding (Transfer + SyncNative) for the reflection amount to the WSOL account.
4. Relied on Main Swap's setup to create the WSOL account and Main Swap's cleanup to close it.

This ensures a single WSOL account lifecycle:
[Create WSOL] -> [Fund Main] -> [Fund Reflection] -> [Sync] -> [Swap Main] -> [Swap Reflection] -> [Close WSOL]
