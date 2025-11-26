-- Migration: Fix missing columns in settlement_transfers (forced re-application)
-- This is a safety migration to ensure columns exist even if 005 partially failed
-- Safe to run multiple times (idempotent)

-- Add status column with VARCHAR type
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'settlement_transfers' AND column_name = 'status'
  ) THEN
    ALTER TABLE settlement_transfers ADD COLUMN status VARCHAR(20) DEFAULT 'SUCCESS';
    RAISE NOTICE 'Added status column';
  ELSE
    RAISE NOTICE 'Status column already exists';
  END IF;
END $$;

-- Add attempts column
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'settlement_transfers' AND column_name = 'attempts'
  ) THEN
    ALTER TABLE settlement_transfers ADD COLUMN attempts INTEGER DEFAULT 1;
    RAISE NOTICE 'Added attempts column';
  ELSE
    RAISE NOTICE 'Attempts column already exists';
  END IF;
END $$;

-- Add last_error column
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'settlement_transfers' AND column_name = 'last_error'
  ) THEN
    ALTER TABLE settlement_transfers ADD COLUMN last_error TEXT;
    RAISE NOTICE 'Added last_error column';
  ELSE
    RAISE NOTICE 'Last_error column already exists';
  END IF;
END $$;

-- Add batch_id column with VARCHAR type
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'settlement_transfers' AND column_name = 'batch_id'
  ) THEN
    ALTER TABLE settlement_transfers ADD COLUMN batch_id VARCHAR(255);
    RAISE NOTICE 'Added batch_id column';
  ELSE
    RAISE NOTICE 'Batch_id column already exists';
  END IF;
END $$;

-- Create index for failed transfer queries (safe to run multiple times)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'settlement_transfers' AND indexname = 'idx_settlement_transfers_status'
  ) THEN
    CREATE INDEX idx_settlement_transfers_status ON settlement_transfers(status) WHERE status IN ('PENDING', 'FAILED');
    RAISE NOTICE 'Created status index';
  ELSE
    RAISE NOTICE 'Status index already exists';
  END IF;
END $$;

-- Create index for batch lookups (safe to run multiple times)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'settlement_transfers' AND indexname = 'idx_settlement_transfers_batch'
  ) THEN
    CREATE INDEX idx_settlement_transfers_batch ON settlement_transfers(batch_id) WHERE batch_id IS NOT NULL;
    RAISE NOTICE 'Created batch_id index';
  ELSE
    RAISE NOTICE 'Batch_id index already exists';
  END IF;
END $$;
