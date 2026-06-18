-- EU-14: Add backfill tracking columns to connected_accounts.
-- backfill_start_history_id is captured BEFORE page 1 to avoid missing messages
-- that arrive during a multi-run backfill (they fall between start and end historyIds).
ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS backfill_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS backfill_page_token text,
  ADD COLUMN IF NOT EXISTS backfill_start_history_id text;

-- Index so the collector can quickly find accounts still in backfill.
CREATE INDEX IF NOT EXISTS connected_accounts_backfill_complete_idx
  ON connected_accounts(backfill_complete)
  WHERE backfill_complete = false;
