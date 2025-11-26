/**
 * Wallet Verification Utility
 * Verifies Solana wallet ownership through message signing
 */
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Verification message template
 * This message must be signed by the wallet owner to prove ownership
 */
export function getVerificationMessage(wallet: string): string {
  return `Verify wallet ownership for racepump.fun referral system\n\nWallet: ${wallet}\nTimestamp: ${Date.now()}\n\nSigning this message proves you own this wallet and authorizes it to receive referral rewards.`;
}

/**
 * Verify a signed message from a Solana wallet
 * 
 * @param wallet - The wallet address (base58 encoded public key)
 * @param message - The original message that was signed
 * @param signature - The signature (base58 encoded)
 * @returns true if the signature is valid, false otherwise
 */
export function verifyWalletSignature(
  wallet: string,
  message: string,
  signature: string
): boolean {
  try {
    // Decode the wallet address (public key)
    const publicKey = new PublicKey(wallet);
    const publicKeyBytes = publicKey.toBytes();
    
    // Decode the signature from base58
    const signatureBytes = bs58.decode(signature);
    
    // Convert message to Uint8Array
    const messageBytes = new TextEncoder().encode(message);
    
    // Verify the signature using nacl
    const isValid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes
    );
    
    return isValid;
  } catch (error) {
    console.error('[wallet-verification] Error verifying signature:', error);
    return false;
  }
}

/**
 * Validate that a verification message hasn't expired
 * Signatures are valid for 15 minutes from timestamp
 */
export function isVerificationMessageValid(message: string): { valid: boolean; reason?: string } {
  try {
    // Extract timestamp from message
    const timestampMatch = message.match(/Timestamp: (\d+)/);
    if (!timestampMatch) {
      return { valid: false, reason: 'No timestamp found in message' };
    }
    
    const timestamp = parseInt(timestampMatch[1], 10);
    const now = Date.now();
    const fifteenMinutes = 15 * 60 * 1000;
    
    if (now - timestamp > fifteenMinutes) {
      return { valid: false, reason: 'Verification message expired (older than 15 minutes)' };
    }
    
    if (timestamp > now + 60000) {
      return { valid: false, reason: 'Verification message timestamp is in the future' };
    }
    
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: 'Invalid message format' };
  }
}

/**
 * Full verification flow:
 * 1. Validate message format and expiration
 * 2. Verify signature matches wallet
 * 3. Extract wallet from message and ensure it matches provided wallet
 */
export function verifyWalletOwnership(
  wallet: string,
  message: string,
  signature: string
): { valid: boolean; reason?: string } {
  // Check message validity
  const messageCheck = isVerificationMessageValid(message);
  if (!messageCheck.valid) {
    return messageCheck;
  }
  
  // Extract wallet from message and verify it matches
  const walletMatch = message.match(/Wallet: ([A-Za-z0-9]+)/);
  if (!walletMatch || walletMatch[1] !== wallet) {
    return { valid: false, reason: 'Wallet address in message does not match provided wallet' };
  }
  
  // Verify the signature
  const signatureValid = verifyWalletSignature(wallet, message, signature);
  if (!signatureValid) {
    return { valid: false, reason: 'Invalid signature' };
  }
  
  return { valid: true };
}
