-- Add meme reward fields to races table
-- These fields track whether a race included a meme coin reward and the details of the reward distribution

ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_recipient VARCHAR(255);
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_token_amount VARCHAR(100);
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_sol_spent VARCHAR(100);
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_tx_sig VARCHAR(255);

-- Add index for querying meme reward races
CREATE INDEX IF NOT EXISTS idx_races_meme_reward_enabled ON races(meme_reward_enabled) WHERE meme_reward_enabled = TRUE;
