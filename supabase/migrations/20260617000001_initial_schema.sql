-- connected_accounts: stores OAuth-connected Gmail accounts per user
CREATE TABLE IF NOT EXISTS connected_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'google',
  email_address     text NOT NULL,
  status            text NOT NULL DEFAULT 'active'
                    CONSTRAINT connected_accounts_status_check
                    CHECK (status IN ('active', 'error', 'revoked')),
  granted_scopes    text,
  sync_cursor       text,
  last_synced_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connected_accounts_user_email_unique UNIQUE (user_id, email_address)
);

ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'connected_accounts' AND policyname = 'users select own accounts'
  ) THEN
    CREATE POLICY "users select own accounts"
      ON connected_accounts
      FOR SELECT
      TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS connected_accounts_user_id_idx
  ON connected_accounts (user_id);

CREATE INDEX IF NOT EXISTS connected_accounts_user_id_status_idx
  ON connected_accounts (user_id, status);

-- messages: collected email messages, written only by the collector edge function
CREATE TABLE IF NOT EXISTS messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id  uuid NOT NULL
                        REFERENCES connected_accounts(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL,
  gmail_message_id      text NOT NULL,
  thread_id             text,
  from_address          text,
  to_addresses          text,
  subject               text,
  snippet               text,
  internal_date         timestamptz,
  body_text             text,
  body_html             text,
  label_ids             text[],
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_account_gmail_id_unique
    UNIQUE (connected_account_id, gmail_message_id)
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'users select own messages'
  ) THEN
    CREATE POLICY "users select own messages"
      ON messages
      FOR SELECT
      TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS messages_user_id_internal_date_idx
  ON messages (user_id, internal_date DESC);

CREATE INDEX IF NOT EXISTS messages_user_id_account_id_internal_date_idx
  ON messages (user_id, connected_account_id, internal_date DESC);

CREATE INDEX IF NOT EXISTS messages_connected_account_id_idx
  ON messages (connected_account_id);
