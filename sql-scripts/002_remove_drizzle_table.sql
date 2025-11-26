-- Remove old drizzle_migrations table that triggers Replit's migration detection
-- This is a cleanup migration to remove the Drizzle-specific table that causes
-- Replit to incorrectly detect and try to manage our database schema

-- Drop the old drizzle_migrations table if it exists
-- This table is no longer used - we now use app_migrations instead
DROP TABLE IF EXISTS drizzle_migrations CASCADE;

-- Note: The migration system uses app_migrations table (created automatically by the runner)
-- This ensures Replit cannot detect any Drizzle-related database objects
