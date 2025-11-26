# Adding Meme Reward Columns to Production Database

## Option 1: Automatic (Recommended)

Deploy your app to production. The migration will run automatically during deployment.

The migration file `sql-scripts/008_add_meme_reward_fields.sql` is already in your codebase and will be applied when you publish.

## Option 2: Manual (If you need them now)

If you want to add the columns immediately without deploying, run these SQL commands in your Neon database console:

### SQL Commands

```sql
-- Add meme reward fields to races table
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_recipient VARCHAR(255);
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_token_amount VARCHAR(100);
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_sol_spent VARCHAR(100);
ALTER TABLE races ADD COLUMN IF NOT EXISTS meme_reward_tx_sig VARCHAR(255);

-- Add index for querying meme reward races
CREATE INDEX IF NOT EXISTS idx_races_meme_reward_enabled ON races(meme_reward_enabled) WHERE meme_reward_enabled = TRUE;
```

### Steps to Run in Neon Console

1. Go to https://console.neon.tech/
2. Select your project
3. Click on "SQL Editor" in the left sidebar
4. Select your production database
5. Copy and paste the SQL commands above
6. Click "Run" or press Ctrl+Enter
7. Verify the columns were added by running:
   ```sql
   SELECT column_name, data_type 
   FROM information_schema.columns 
   WHERE table_name = 'races' 
   AND column_name LIKE 'meme_reward%';
   ```

## Verification

After adding the columns (either method), you should see 5 new columns in the races table:
- `meme_reward_enabled` (boolean)
- `meme_reward_recipient` (varchar 255)
- `meme_reward_token_amount` (varchar 100)
- `meme_reward_sol_spent` (varchar 100)
- `meme_reward_tx_sig` (varchar 255)

## ⚠️ Important Note

If you're using the manual method, you'll need to re-enable your Neon endpoint first, as it's currently showing as disabled in the connection logs.

The endpoint error was:
```
The endpoint has been disabled. Enable it using Neon API and retry.
```

You can re-enable it in the Neon dashboard under Project Settings → Compute.
