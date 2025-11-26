-- Add missing columns to races table to match schema
-- This migration adds columns for race lifecycle tracking, jackpot flags, and rake

-- Add start_slot if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'start_slot'
  ) THEN
    ALTER TABLE races ADD COLUMN start_slot BIGINT;
  END IF;
END $$;

-- Add start_block_time_ms if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'start_block_time_ms'
  ) THEN
    ALTER TABLE races ADD COLUMN start_block_time_ms BIGINT;
  END IF;
END $$;

-- Add locked_ts if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'locked_ts'
  ) THEN
    ALTER TABLE races ADD COLUMN locked_ts BIGINT;
  END IF;
END $$;

-- Add locked_slot if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'locked_slot'
  ) THEN
    ALTER TABLE races ADD COLUMN locked_slot BIGINT;
  END IF;
END $$;

-- Add locked_block_time_ms if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'locked_block_time_ms'
  ) THEN
    ALTER TABLE races ADD COLUMN locked_block_time_ms BIGINT;
  END IF;
END $$;

-- Add in_progress_ts if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'in_progress_ts'
  ) THEN
    ALTER TABLE races ADD COLUMN in_progress_ts BIGINT;
  END IF;
END $$;

-- Add in_progress_slot if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'in_progress_slot'
  ) THEN
    ALTER TABLE races ADD COLUMN in_progress_slot BIGINT;
  END IF;
END $$;

-- Add in_progress_block_time_ms if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'in_progress_block_time_ms'
  ) THEN
    ALTER TABLE races ADD COLUMN in_progress_block_time_ms BIGINT;
  END IF;
END $$;

-- Add rake_bps if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'rake_bps'
  ) THEN
    ALTER TABLE races ADD COLUMN rake_bps INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Add jackpot_flag if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'jackpot_flag'
  ) THEN
    ALTER TABLE races ADD COLUMN jackpot_flag INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Add jackpot_added if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'jackpot_added'
  ) THEN
    ALTER TABLE races ADD COLUMN jackpot_added INTEGER DEFAULT 0;
  END IF;
END $$;

-- Rename end_ts to match schema expectations if needed
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'end_ts'
  ) AND NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'races' AND column_name = 'start_ts'
  ) THEN
    -- Only rename if start_ts doesn't exist yet
    NULL;
  END IF;
END $$;
