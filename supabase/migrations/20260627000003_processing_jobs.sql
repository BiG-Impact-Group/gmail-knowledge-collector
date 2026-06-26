-- Epic 05 (Migration 3): processing_jobs — the file-conversion work queue.
-- Browser is READ-ONLY: SELECT-own RLS policy + explicit REVOKE INSERT/UPDATE/DELETE. All writes
-- go through SECURITY DEFINER RPCs granted to service_role only (Migration 4). Permanent failures
-- live on the job (status='failed'); the document is set 'skipped' — no 'failed' document status.

CREATE TABLE IF NOT EXISTS processing_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id   uuid NOT NULL,
  source_type   text NOT NULL DEFAULT 'drive'
                 CONSTRAINT processing_jobs_source_type_check CHECK (source_type IN ('drive','email_attachment')),
  status        text NOT NULL DEFAULT 'pending'
                 CONSTRAINT processing_jobs_status_check CHECK (status IN ('pending','processing','done','needs_ocr','failed')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  claimed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processing_jobs_document_unique UNIQUE (document_id),
  CONSTRAINT processing_jobs_user_document_fk
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE
);

-- Self-repair guard (Codex v1 #14): on a partially-created table from an aborted run, ensure the
-- composite FK and the UNIQUE(document_id) constraint exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'processing_jobs' AND constraint_name = 'processing_jobs_document_unique'
  ) THEN
    ALTER TABLE processing_jobs
      ADD CONSTRAINT processing_jobs_document_unique UNIQUE (document_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'processing_jobs' AND constraint_name = 'processing_jobs_user_document_fk'
  ) THEN
    ALTER TABLE processing_jobs
      ADD CONSTRAINT processing_jobs_user_document_fk
      FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;

-- Browser is read-only: SELECT-own only. No INSERT/UPDATE/DELETE policies for authenticated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'processing_jobs'
      AND policyname = 'users select own processing jobs'
  ) THEN
    CREATE POLICY "users select own processing jobs"
      ON processing_jobs FOR SELECT
      TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

-- Explicit table-privilege revoke (Codex v1 #9) — defence in depth beyond the absent write policies.
REVOKE INSERT, UPDATE, DELETE ON processing_jobs FROM anon, authenticated;
GRANT SELECT ON processing_jobs TO authenticated;

CREATE INDEX IF NOT EXISTS processing_jobs_claim_idx
  ON processing_jobs (status, created_at) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS processing_jobs_user_id_idx ON processing_jobs (user_id);
