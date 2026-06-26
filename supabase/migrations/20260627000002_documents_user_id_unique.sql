-- Epic 05 (Migration 2): processing_jobs needs a composite FK to documents(user_id, id) so the
-- DB enforces that a job's user_id matches the document's user_id (cross-user guard, mirrors the
-- messages/documents composite-FK pattern). documents.id is already the PK (unique), so
-- (user_id, id) is trivially unique — this constraint just makes it a referenceable FK target.
-- Idempotent DO-block mirrors 20260618000002_messages_user_fk.sql.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'documents_user_id_id_key'
      AND table_name = 'documents'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_user_id_id_key UNIQUE (user_id, id);
  END IF;
END $$;
