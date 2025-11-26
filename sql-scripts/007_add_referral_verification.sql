-- Migration: Add wallet verification to referral system
-- Date: 2025-11-05
-- Description: Add verified and verified_at columns to require wallet ownership proof before payouts

-- Add verification columns to referral_users table
ALTER TABLE referral_users 
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verified_at BIGINT;

-- Grandfather existing referrals: mark all existing users as verified
-- This ensures current referrers continue to receive payouts without disruption
UPDATE referral_users 
SET verified = TRUE, verified_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
WHERE verified = FALSE;

-- Create index for faster verification checks during payout
CREATE INDEX IF NOT EXISTS idx_referral_users_verified ON referral_users(verified);

-- Log completion
DO $$
BEGIN
  RAISE NOTICE '✅ Referral verification columns added and existing users grandfathered';
END $$;
