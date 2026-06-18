-- EU-14 (RLS integrity): Enforce that messages.user_id always matches
-- the user_id of the connected_account that produced it.
-- Without this, a bad service-role write could expose another user's messages
-- through the user_id-based RLS policy on messages.

-- Step 1: Add unique constraint on (user_id, id) so it can be a FK target.
-- connected_accounts.id is already the PK (unique), so (user_id, id) is
-- trivially unique — this constraint just makes it referenceable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'connected_accounts_user_id_id_key'
      AND table_name = 'connected_accounts'
  ) THEN
    ALTER TABLE connected_accounts
      ADD CONSTRAINT connected_accounts_user_id_id_key UNIQUE (user_id, id);
  END IF;
END $$;

-- Step 2: Composite FK from messages(user_id, connected_account_id)
-- → connected_accounts(user_id, id). This makes the DB enforce that a
-- message's user_id must match the account's user_id.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'messages_user_id_connected_account_fk'
      AND table_name = 'messages'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_user_id_connected_account_fk
      FOREIGN KEY (user_id, connected_account_id)
      REFERENCES connected_accounts(user_id, id);
  END IF;
END $$;
