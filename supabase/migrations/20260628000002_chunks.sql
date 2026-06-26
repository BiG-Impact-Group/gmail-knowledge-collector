-- Epic 06 (Migration 2): chunks — the per-document embedding store (gte-small, 384-dim).
-- Browser is READ-ONLY: SELECT-own RLS policy + explicit REVOKE ALL / GRANT SELECT. Only the
-- embedder edge function writes, via the SECURITY DEFINER complete_embedding_job RPC (service role).
--
-- source_version records the documents.drive_modified_time that was embedded (always non-null;
-- only docs with a real content version are embedded). All comparisons use strict `=` so a NULL
-- version can never make a stale chunk look current. Stale chunks are purged in enqueue_embedding_jobs.
--
-- Normalized embeddings → inner-product HNSW (vector_ip_ops); Epic 07 queries `ORDER BY embedding <#> $q`.
-- Document-scoped: document_id is NOT NULL (email-body embedding is a separate, later source).

CREATE TABLE IF NOT EXISTS chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL,
  source_version  timestamptz NOT NULL,
  chunk_index     integer NOT NULL,
  content         text NOT NULL,
  embedding       extensions.vector(384) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunks_doc_index_unique UNIQUE (document_id, chunk_index),
  CONSTRAINT chunks_user_document_fk
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE
);

-- Self-repair guard (mirrors processing_jobs): on a partially-created table from an aborted run,
-- ensure the UNIQUE(document_id, chunk_index) + composite FK constraints exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'chunks' AND constraint_name = 'chunks_doc_index_unique'
  ) THEN
    ALTER TABLE chunks
      ADD CONSTRAINT chunks_doc_index_unique UNIQUE (document_id, chunk_index);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'chunks' AND constraint_name = 'chunks_user_document_fk'
  ) THEN
    ALTER TABLE chunks
      ADD CONSTRAINT chunks_user_document_fk
      FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;

-- Browser is read-only: SELECT-own only. No INSERT/UPDATE/DELETE policies for authenticated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'chunks'
      AND policyname = 'users select own chunks'
  ) THEN
    CREATE POLICY "users select own chunks"
      ON chunks FOR SELECT
      TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

-- Explicit table-privilege revoke — defence in depth beyond the absent write policies.
REVOKE ALL ON TABLE chunks FROM anon, authenticated;
GRANT SELECT ON chunks TO authenticated;

-- Inner-product HNSW index for normalized embeddings (Epic 07 retrieval: ORDER BY embedding <#> $q).
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding extensions.vector_ip_ops);
CREATE INDEX IF NOT EXISTS chunks_user_id_idx ON chunks (user_id);
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);

-- Migration 2b (Codex #8): enqueue_embedding_jobs scans extracted docs every 5 min, but
-- documents_content_status_idx excludes 'extracted'. Add a partial index so the scan is cheap.
CREATE INDEX IF NOT EXISTS documents_extracted_idx ON documents (id)
  WHERE content_status = 'extracted';
