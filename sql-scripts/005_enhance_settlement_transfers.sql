-- Migration: Enhance settlement_transfers table for failure tracking and batching
-- Safe to run multiple times (idempotent)

-- Add status column (defaults to SUCCESS for backward compatibility)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'settlement_transfers' AND column_name = 'status'
  ) THEN
    ALTER TABLE settlement_transfers ADD COLUMN status TEXT DEFAULT 'SUCCESS';
    COMMENT ON COLUMN settlement_transfers.status IS 'Transfer status: PENDING, SUCCESS, or FAILED';
  END IF;
END $$;

-- Add attempts column (defaults to 1 for existing records)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'settlement_transfers' AND column_name = 'attempts'
  ) THEN
    ALTER TABLE settlement_transfers ADD COLUMN attempts INTEGER DEFAULT 1;
    COMMENT ON COLUMN settlement_transfers.attempts IS 'Number of send attempts made';
  END IF;
END $$;

-- Add last_error column for failure tracking
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'settlement_transfers' AND column_name = 'last_error'
  ) THEN
    ALTER TABLE settlement_transfers ADD COLUMN last_error TEXT;
    COMMENT ON COLUMN settlement_transfers.last_error IS 'Error message if transfer failed';
  END IF;
END $$;

-- Add batch_id column for grouping batched transfers
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'settlement_transfers' AND column_name = 'batch_id'
  ) THEN
    ALTER TABLE settlement_transfers ADD COLUMN batch_id TEXT;
    COMMENT ON COLUMN settlement_transfers.batch_id IS 'Groups transfers sent in same transaction';
  END IF;
END $$;

-- Create index for failed transfer queries
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'settlement_transfers' AND indexname = 'idx_settlement_transfers_status'
  ) THEN
    CREATE INDEX idx_settlement_transfers_status ON settlement_transfers(status) WHERE status IN ('PENDING', 'FAILED');
    COMMENT ON INDEX idx_settlement_transfers_status IS 'Fast lookup of pending/failed transfers for retry';
  END IF;
END $$;

-- Create index for batch lookups
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'settlement_transfers' AND indexname = 'idx_settlement_transfers_batch'
  ) THEN
    CREATE INDEX idx_settlement_transfers_batch ON settlement_transfers(batch_id) WHERE batch_id IS NOT NULL;
    COMMENT ON INDEX idx_settlement_transfers_batch IS 'Fast lookup of batched transfers';
  END IF;
END $$;
