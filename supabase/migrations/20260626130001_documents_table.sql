-- Epic 04: documents table for Google Drive collected files.
-- Mirrors the messages composite-FK fix: a document's (user_id, connected_account_id)
-- pair MUST match a real (user_id, id) pair in connected_accounts, so the service role
-- cannot write a document whose user_id does not own the account (cross-user guard).
-- ON DELETE CASCADE so lifecycle_delete (which removes the account) removes its documents.

CREATE TABLE IF NOT EXISTS documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id  uuid NOT NULL,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  drive_file_id         text NOT NULL,
  name                  text NOT NULL,
  mime_type             text NOT NULL,
  web_view_link         text,
  size_bytes            bigint,
  drive_modified_time   timestamptz,
  text_content          text,
  content_status        text NOT NULL DEFAULT 'extracted'
                        CONSTRAINT documents_content_status_check
                        CHECK (content_status IN ('extracted', 'needs_processing', 'needs_ocr', 'skipped')),
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_user_account_fk
    FOREIGN KEY (user_id, connected_account_id)
    REFERENCES connected_accounts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT documents_account_file_unique UNIQUE (connected_account_id, drive_file_id)
);

-- Self-repair guard: if a partial/earlier documents table exists with the old single-column
-- FK (from an aborted run), drop it and ensure the composite FK is present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE table_name = 'documents' AND constraint_name = 'documents_connected_account_id_fkey') THEN
    ALTER TABLE documents DROP CONSTRAINT documents_connected_account_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name = 'documents' AND constraint_name = 'documents_user_account_fk') THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_user_account_fk
      FOREIGN KEY (user_id, connected_account_id)
      REFERENCES connected_accounts(user_id, id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Browser is read-only on documents: SELECT-own only. No INSERT/UPDATE/DELETE for authenticated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documents'
      AND policyname = 'users select own documents'
  ) THEN
    CREATE POLICY "users select own documents"
      ON documents FOR SELECT
      TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents (user_id);
CREATE INDEX IF NOT EXISTS documents_account_id_idx ON documents (connected_account_id);
-- UI lists sort by drive_modified_time DESC NULLS LAST — index NULLS ordering MUST match
-- the query's NULLS ordering or Postgres won't use it for the sort.
CREATE INDEX IF NOT EXISTS documents_user_id_modified_idx
  ON documents (user_id, drive_modified_time DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS documents_user_account_modified_idx
  ON documents (user_id, connected_account_id, drive_modified_time DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS documents_content_status_idx
  ON documents (content_status) WHERE content_status != 'extracted';
