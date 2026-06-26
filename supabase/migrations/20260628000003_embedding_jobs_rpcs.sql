-- Epic 06 (Migration 3): embedding_jobs work queue + producer/claim/complete RPCs.
-- Mirrors processing_jobs (Epic 05) but for the embedding stage. Key differences:
--   * source_version (timestamptz) records the documents.drive_modified_time being embedded;
--     chunk_count + truncated record the outcome.
--   * Embedding NEVER mutates documents (Codex C3) — neither claim cap-fail nor complete writes
--     documents. Embedding is best-effort; the /documents viewer is unaffected by failures.
--   * Version-aware enqueue + strict-equality stale-chunk purge (Codex C1/C2): only docs with a
--     non-null drive_modified_time are embedded, and all version comparisons use strict `=`.
--
-- Browser is READ-ONLY (SELECT-own RLS + REVOKE DML). All writes via SECURITY DEFINER RPCs granted
-- to service_role only. NEVER returns text/file name (no PII to logs).

CREATE TABLE IF NOT EXISTS embedding_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL,
  source_version  timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                   CONSTRAINT embedding_jobs_status_check CHECK (status IN ('pending','processing','done','failed')),
  attempts        integer NOT NULL DEFAULT 0,
  chunk_count     integer,
  truncated       boolean NOT NULL DEFAULT false,
  last_error      text,
  claimed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embedding_jobs_document_unique UNIQUE (document_id),
  CONSTRAINT embedding_jobs_user_document_fk
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE
);

-- Self-repair guard (mirrors processing_jobs): ensure unique + composite FK on a partial table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'embedding_jobs' AND constraint_name = 'embedding_jobs_document_unique'
  ) THEN
    ALTER TABLE embedding_jobs
      ADD CONSTRAINT embedding_jobs_document_unique UNIQUE (document_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'embedding_jobs' AND constraint_name = 'embedding_jobs_user_document_fk'
  ) THEN
    ALTER TABLE embedding_jobs
      ADD CONSTRAINT embedding_jobs_user_document_fk
      FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE embedding_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'embedding_jobs'
      AND policyname = 'users select own embedding jobs'
  ) THEN
    CREATE POLICY "users select own embedding jobs"
      ON embedding_jobs FOR SELECT
      TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

REVOKE INSERT, UPDATE, DELETE ON embedding_jobs FROM anon, authenticated;
GRANT SELECT ON embedding_jobs TO authenticated;

CREATE INDEX IF NOT EXISTS embedding_jobs_claim_idx
  ON embedding_jobs (status, created_at) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS embedding_jobs_user_id_idx ON embedding_jobs (user_id);

-- ============================================================================
-- enqueue_embedding_jobs() — producer (version-aware) + stale-chunk purge.
-- Inserts/reopens a job ONLY when the document's current content version (drive_modified_time)
-- differs from the version already recorded on the job. A done/failed job for the SAME version is
-- left alone → no infinite re-embed, no infinite failure-retry (Codex C1). Only docs with a real
-- content version (drive_modified_time IS NOT NULL) and extracted text are eligible.
-- After enqueue, purge chunks whose document is no longer extracted or whose version no longer
-- matches (strict equality; both non-null) — Codex C2.
-- ============================================================================
CREATE OR REPLACE FUNCTION enqueue_embedding_jobs()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.embedding_jobs (user_id, document_id, source_version)
  SELECT d.user_id, d.id, d.drive_modified_time
  FROM public.documents d
  WHERE d.content_status = 'extracted'
    AND d.text_content IS NOT NULL
    AND d.drive_modified_time IS NOT NULL
  ON CONFLICT (document_id) DO UPDATE
    SET status='pending', attempts=0, claimed_at=NULL, last_error=NULL,
        source_version=EXCLUDED.source_version, updated_at=now()
    WHERE public.embedding_jobs.source_version IS DISTINCT FROM EXCLUDED.source_version;

  -- Stale-chunk purge (Codex C2): delete chunks whose document is no longer extracted at the
  -- exact version that was embedded. FK cascade already covers document/account deletion; this
  -- also clears chunks for docs that went needs_processing/needs_ocr/skipped or whose content changed.
  DELETE FROM public.chunks c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = c.document_id
      AND d.content_status = 'extracted'
      AND d.drive_modified_time = c.source_version
  );
END;
$$;

REVOKE ALL ON FUNCTION enqueue_embedding_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_embedding_jobs() FROM anon;
REVOKE ALL ON FUNCTION enqueue_embedding_jobs() FROM authenticated;
GRANT EXECUTE ON FUNCTION enqueue_embedding_jobs() TO service_role;

-- ============================================================================
-- claim_embedding_jobs(p_limit, p_stale_seconds, p_max_attempts) — consumer claim.
-- Like claim_processing_jobs BUT cap-fail touches ONLY embedding_jobs (NEVER documents — Codex C3).
-- Eligibility = active google_drive account + d.content_status='extracted' + (pending OR stale
-- processing under max). FOR UPDATE OF pj SKIP LOCKED. Returns a content-version token
-- (drive_modified_time) + lease (claimed_at) + lifecycle_version so completion verifies nothing
-- changed under it. NO text, NO file name (no PII to logs).
-- ============================================================================
CREATE OR REPLACE FUNCTION claim_embedding_jobs(
  p_limit integer,
  p_stale_seconds integer,
  p_max_attempts integer
) RETURNS TABLE (
  job_id uuid,
  document_id uuid,
  user_id uuid,
  attempts integer,
  claimed_at timestamptz,
  connected_account_id uuid,
  lifecycle_version integer,
  drive_modified_time timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stale timestamptz := now() - make_interval(secs => p_stale_seconds);
BEGIN
  -- Cap-fail crashed jobs (stale 'processing' past max attempts). NEVER touches documents (C3):
  -- a failed embedding is best-effort and must not regress the document/viewer.
  UPDATE public.embedding_jobs pj
    SET status='failed', last_error='max_attempts', claimed_at=NULL, updated_at=now()
    WHERE pj.status='processing'
      AND pj.claimed_at < v_stale
      AND pj.attempts >= p_max_attempts;

  RETURN QUERY
  WITH claimable AS (
    SELECT pj.id
    FROM public.embedding_jobs pj
    JOIN public.documents d ON d.id = pj.document_id
    JOIN public.connected_accounts ca ON ca.id = d.connected_account_id
    WHERE ca.status = 'active'
      AND ca.provider = 'google_drive'
      AND d.content_status = 'extracted'
      AND (
        pj.status = 'pending'
        OR (pj.status = 'processing' AND pj.claimed_at < v_stale AND pj.attempts < p_max_attempts)
      )
    ORDER BY pj.created_at
    LIMIT p_limit
    FOR UPDATE OF pj SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.embedding_jobs pj
      SET status='processing', claimed_at=now(), attempts=pj.attempts + 1, updated_at=now()
      FROM claimable
      WHERE pj.id = claimable.id
      RETURNING pj.id, pj.document_id, pj.user_id, pj.attempts, pj.claimed_at
  )
  SELECT
    c.id AS job_id,
    c.document_id,
    c.user_id,
    c.attempts,
    c.claimed_at,
    d.connected_account_id,
    ca.lifecycle_version,
    d.drive_modified_time
  FROM claimed c
  JOIN public.documents d ON d.id = c.document_id
  JOIN public.connected_accounts ca ON ca.id = d.connected_account_id;
END;
$$;

REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_embedding_jobs(integer, integer, integer) TO service_role;

-- ============================================================================
-- complete_embedding_job(...) — applies an outcome under lease + version recheck.
-- Based on 20260627020001_complete_job_lock_order.sql lock discipline: unlocked id derivation,
-- then account → document → job lease lock order (matching the lifecycle cascade) to avoid
-- deadlocks. NEVER writes documents (Codex C3).
--
-- 'done': validate p_chunks FULLY in SQL BEFORE any delete/insert (Codex v2 #6) — don't rely on
--   the vector(384) cast to throw mid-insert. On any failure → job failed, last_error='invalid_chunks',
--   return without touching chunks/documents. On success: DELETE then INSERT chunks (version-stamped),
--   set job done + chunk_count + truncated.
-- 'retry': attempts>=max → failed; else pending. Document untouched either way.
-- ============================================================================
CREATE OR REPLACE FUNCTION complete_embedding_job(
  p_job_id uuid,
  p_claimed_at timestamptz,
  p_attempts integer,
  p_lifecycle_version integer,
  p_drive_modified_time timestamptz,
  p_outcome text,
  p_chunks jsonb,
  p_truncated boolean,
  p_error text,
  p_max_attempts integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_max_chunks   constant integer := 50;     -- mirror MAX_CHUNKS_PER_DOC
  v_max_content  constant integer := 8000;   -- per-chunk content length cap (chars)
  v_doc uuid;
  v_acct uuid;
  v_ca_status text;
  v_ca_version integer;
  v_doc_modified timestamptz;
  v_content_status text;
  v_len integer;
  v_elem jsonb;
  v_idx integer;
BEGIN
  -- Unlocked reads to derive the ids (no row locks held yet).
  SELECT pj.document_id INTO v_doc FROM public.embedding_jobs pj WHERE pj.id = p_job_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT d.connected_account_id INTO v_acct FROM public.documents d WHERE d.id = v_doc;
  IF NOT FOUND THEN
    -- Document gone (account purged). Mark job failed only if WE still hold the lease. (No doc write.)
    UPDATE public.embedding_jobs
      SET status='failed', last_error='document_gone', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id AND status='processing' AND claimed_at = p_claimed_at AND attempts = p_attempts;
    RETURN;
  END IF;

  -- Acquire locks in lifecycle-cascade order: account → document → job.
  PERFORM 1 FROM public.connected_accounts WHERE id = v_acct FOR UPDATE;

  SELECT ca.status, ca.lifecycle_version, d.drive_modified_time, d.content_status
    INTO v_ca_status, v_ca_version, v_doc_modified, v_content_status
    FROM public.documents d
    JOIN public.connected_accounts ca ON ca.id = d.connected_account_id
    WHERE d.id = v_doc
    FOR UPDATE OF d;
  IF NOT FOUND THEN
    UPDATE public.embedding_jobs
      SET status='failed', last_error='document_gone', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id AND status='processing' AND claimed_at = p_claimed_at AND attempts = p_attempts;
    RETURN;
  END IF;

  -- Lease guard LAST (job row lock acquired after account + document).
  PERFORM 1 FROM public.embedding_jobs
    WHERE id = p_job_id AND status='processing' AND claimed_at = p_claimed_at AND attempts = p_attempts
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- Stale account generation, content version changed, or doc no longer extracted → don't write;
  -- release the job for a fresh run. Strict `=` on drive_modified_time (both non-null for embeddable docs).
  IF v_ca_status <> 'active'
     OR v_ca_version <> p_lifecycle_version
     OR v_doc_modified IS DISTINCT FROM p_drive_modified_time
     OR v_content_status <> 'extracted' THEN
    UPDATE public.embedding_jobs
      SET status='pending', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  IF p_outcome = 'done' THEN
    -- Validate p_chunks FULLY in SQL before any delete/insert (Codex v2 #6).
    v_len := jsonb_array_length(p_chunks);
    IF v_len IS NULL OR v_len < 1 OR v_len > v_max_chunks THEN
      UPDATE public.embedding_jobs
        SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now()
        WHERE id = p_job_id;
      RETURN;
    END IF;

    FOR v_idx IN 0 .. v_len - 1 LOOP
      v_elem := p_chunks -> v_idx;
      -- Each element must be {chunk_index: non-negative integer, content: non-empty string under
      -- cap, embedding: 384-element array}. chunk_index integrality enforced via the text-form regex.
      IF v_elem IS NULL
         OR jsonb_typeof(v_elem -> 'chunk_index') <> 'number'
         OR (v_elem ->> 'chunk_index') !~ '^[0-9]+$'
         OR jsonb_typeof(v_elem -> 'content') <> 'string'
         OR length(v_elem ->> 'content') = 0
         OR length(v_elem ->> 'content') > v_max_content
         OR jsonb_typeof(v_elem -> 'embedding') <> 'array'
         OR jsonb_array_length(v_elem -> 'embedding') <> 384
      THEN
        UPDATE public.embedding_jobs
          SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now()
          WHERE id = p_job_id;
        RETURN;
      END IF;
    END LOOP;

    -- Replace this document's chunks atomically (version-stamped).
    DELETE FROM public.chunks WHERE document_id = v_doc;
    INSERT INTO public.chunks (user_id, document_id, source_version, chunk_index, content, embedding)
    SELECT
      (SELECT d.user_id FROM public.documents d WHERE d.id = v_doc),
      v_doc,
      p_drive_modified_time,
      (elem ->> 'chunk_index')::integer,
      elem ->> 'content',
      (elem ->> 'embedding')::extensions.vector
    FROM jsonb_array_elements(p_chunks) AS elem;

    UPDATE public.embedding_jobs
      SET status='done', last_error=NULL, claimed_at=NULL,
          chunk_count=v_len, truncated=p_truncated, updated_at=now()
      WHERE id = p_job_id;

  ELSIF p_outcome = 'retry' THEN
    IF p_attempts >= p_max_attempts THEN
      UPDATE public.embedding_jobs
        SET status='failed', last_error=p_error, claimed_at=NULL, updated_at=now()
        WHERE id = p_job_id;
    ELSE
      UPDATE public.embedding_jobs
        SET status='pending', claimed_at=NULL, last_error=p_error, updated_at=now()
        WHERE id = p_job_id;
    END IF;

  ELSE
    RAISE EXCEPTION 'unknown outcome: %', p_outcome;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION complete_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM anon;
REVOKE ALL ON FUNCTION complete_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) TO service_role;
