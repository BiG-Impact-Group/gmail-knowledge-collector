-- Resumable embedding (fix for the 2s edge CPU limit).
--
-- WHY: Edge Functions enforce a hard ~2s CPU budget per request, and in-boundary gte-small
-- inference is CPU-bound. Production evidence (net._http_response): every request that tried to
-- embed a whole document (15+ chunks) was killed with 546 WORKER_RESOURCE_LIMIT — even solo, with
-- zero concurrency. The ONLY requests that ever completed embedded 1–2 chunks. So a document must
-- be embedded across MANY requests, each committing a tiny batch.
--
-- DESIGN: embedding_jobs gains a `next_chunk_index` cursor. Each embedder request claims a job,
-- embeds a couple of chunks starting at the cursor, and commits them via progress_embedding_job:
--   * outcome 'progress' — insert the batch, advance the cursor, release the job back to 'pending'
--     (immediately reclaimable), reset attempts (progress = not stuck).
--   * outcome 'done'     — insert the final batch, mark the job done (chunk_count = total).
--   * outcome 'retry'    — unchanged semantics from complete_embedding_job.
-- Progress is monotonic: a CPU-killed request loses only its in-flight batch, never committed work.
-- Batch inserts are idempotent (ON CONFLICT on (document_id, chunk_index) DO UPDATE) so a lease
-- reclaimed after a mid-flight kill can safely re-commit the same cursor batch.
--
-- Lock discipline, lease guards, and strict version equality are identical to
-- complete_embedding_job v2 (account → document → job, claimed_at+attempts lease, strict
-- drive_modified_time match). On any version/lifecycle mismatch the job is released AND the cursor
-- resets to 0 (content changed → start over). complete_embedding_job is left in place untouched
-- for the deploy window; the embedder stops calling it once v5 is live.

-- 1. Cursor column.
ALTER TABLE embedding_jobs ADD COLUMN IF NOT EXISTS next_chunk_index integer NOT NULL DEFAULT 0;

-- 2. enqueue: re-pend on version change must also reset the cursor.
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
        next_chunk_index=0,
        source_version=EXCLUDED.source_version, updated_at=now()
    WHERE public.embedding_jobs.source_version IS DISTINCT FROM EXCLUDED.source_version;

  -- Stale-chunk purge (strict version equality) — unchanged from v1.
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

-- 3. claim: return the cursor too. Return type changes → DROP then CREATE (idempotent via IF EXISTS).
DROP FUNCTION IF EXISTS claim_embedding_jobs(integer, integer, integer);

CREATE FUNCTION claim_embedding_jobs(
  p_limit integer, p_stale_seconds integer, p_max_attempts integer
) RETURNS TABLE (
  job_id uuid, document_id uuid, user_id uuid, attempts integer, claimed_at timestamptz,
  connected_account_id uuid, lifecycle_version integer, drive_modified_time timestamptz,
  next_chunk_index integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stale timestamptz := now() - make_interval(secs => p_stale_seconds);
BEGIN
  UPDATE public.embedding_jobs pj
    SET status='failed', last_error='max_attempts', claimed_at=NULL, updated_at=now()
    WHERE pj.status='processing' AND pj.claimed_at < v_stale AND pj.attempts >= p_max_attempts;

  RETURN QUERY
  WITH claimable AS (
    SELECT pj.id
    FROM public.embedding_jobs pj
    JOIN public.documents d ON d.id = pj.document_id
    JOIN public.connected_accounts ca ON ca.id = d.connected_account_id
    WHERE ca.status = 'active' AND ca.provider = 'google_drive'
      AND d.content_status = 'extracted'
      AND d.drive_modified_time IS NOT NULL
      AND d.drive_modified_time = pj.source_version          -- bind to the queued version
      AND (pj.status = 'pending'
        OR (pj.status = 'processing' AND pj.claimed_at < v_stale AND pj.attempts < p_max_attempts))
    ORDER BY pj.created_at
    LIMIT p_limit
    FOR UPDATE OF pj SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.embedding_jobs pj
      SET status='processing', claimed_at=now(), attempts=pj.attempts + 1, updated_at=now()
      FROM claimable WHERE pj.id = claimable.id
      RETURNING pj.id, pj.document_id, pj.user_id, pj.attempts, pj.claimed_at, pj.next_chunk_index
  )
  SELECT c.id, c.document_id, c.user_id, c.attempts, c.claimed_at,
         d.connected_account_id, ca.lifecycle_version, d.drive_modified_time,
         c.next_chunk_index
  FROM claimed c
  JOIN public.documents d ON d.id = c.document_id
  JOIN public.connected_accounts ca ON ca.id = d.connected_account_id;
END;
$$;

REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_embedding_jobs(integer, integer, integer) TO service_role;

-- 4. progress_embedding_job — commit one small batch under lease + version recheck.
CREATE OR REPLACE FUNCTION progress_embedding_job(
  p_job_id uuid,
  p_claimed_at timestamptz,
  p_attempts integer,
  p_lifecycle_version integer,
  p_drive_modified_time timestamptz,
  p_outcome text,            -- 'progress' | 'done' | 'retry'
  p_chunks jsonb,            -- batch; absolute chunk_index values starting at the job's cursor
  p_truncated boolean,
  p_error text,
  p_max_attempts integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_max_batch    constant integer := 10;     -- per-REQUEST batch cap (CPU budget ~2 chunks; 10 = hard ceiling)
  v_max_content  constant integer := 8000;   -- per-chunk content length cap (chars)
  v_doc uuid; v_acct uuid; v_ca_status text; v_ca_version integer;
  v_doc_modified timestamptz; v_content_status text;
  v_cursor integer; v_len integer; v_elem jsonb; v_idx integer;
BEGIN
  -- Unlocked id derivation, then account → document → job lock order (mirrors complete v2).
  SELECT pj.document_id INTO v_doc FROM public.embedding_jobs pj WHERE pj.id = p_job_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT d.connected_account_id INTO v_acct FROM public.documents d WHERE d.id = v_doc;
  IF NOT FOUND THEN
    UPDATE public.embedding_jobs SET status='failed', last_error='document_gone', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id AND status='processing' AND claimed_at = p_claimed_at AND attempts = p_attempts;
    RETURN;
  END IF;

  PERFORM 1 FROM public.connected_accounts WHERE id = v_acct FOR UPDATE;

  SELECT ca.status, ca.lifecycle_version, d.drive_modified_time, d.content_status
    INTO v_ca_status, v_ca_version, v_doc_modified, v_content_status
    FROM public.documents d JOIN public.connected_accounts ca ON ca.id = d.connected_account_id
    WHERE d.id = v_doc FOR UPDATE OF d;
  IF NOT FOUND THEN
    UPDATE public.embedding_jobs SET status='failed', last_error='document_gone', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id AND status='processing' AND claimed_at = p_claimed_at AND attempts = p_attempts;
    RETURN;
  END IF;

  -- Lease guard LAST; also read the cursor under the lock.
  SELECT pj.next_chunk_index INTO v_cursor FROM public.embedding_jobs pj
    WHERE pj.id = p_job_id AND pj.status='processing' AND pj.claimed_at = p_claimed_at AND pj.attempts = p_attempts
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- Lifecycle/version/extracted recheck (strict equality). Content changed → start over from 0.
  IF v_ca_status <> 'active'
     OR v_ca_version <> p_lifecycle_version
     OR p_drive_modified_time IS NULL
     OR v_doc_modified IS NULL
     OR v_doc_modified <> p_drive_modified_time
     OR v_content_status <> 'extracted' THEN
    UPDATE public.embedding_jobs
      SET status='pending', claimed_at=NULL, next_chunk_index=0, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  IF p_outcome IN ('progress', 'done') THEN
    -- Validate the batch fully BEFORE any write. 'done' may carry an empty batch (cursor already
    -- at the end); 'progress' must carry at least one chunk or it could spin forever.
    IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
      UPDATE public.embedding_jobs SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
      RETURN;
    END IF;
    v_len := jsonb_array_length(p_chunks);
    IF v_len > v_max_batch OR (p_outcome = 'progress' AND v_len < 1) THEN
      UPDATE public.embedding_jobs SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
      RETURN;
    END IF;
    FOR v_idx IN 0 .. v_len - 1 LOOP
      v_elem := p_chunks -> v_idx;
      -- Element shape + STRICT cursor contiguity: batch element i must be chunk (cursor + i).
      IF v_elem IS NULL
         OR jsonb_typeof(v_elem) <> 'object'
         OR (v_elem -> 'chunk_index') IS NULL OR jsonb_typeof(v_elem -> 'chunk_index') <> 'number'
         OR (v_elem ->> 'chunk_index') !~ '^[0-9]+$'
         OR (v_elem ->> 'chunk_index')::integer <> v_cursor + v_idx
         OR (v_elem -> 'content') IS NULL OR jsonb_typeof(v_elem -> 'content') <> 'string'
         OR length(v_elem ->> 'content') = 0 OR length(v_elem ->> 'content') > v_max_content
         OR (v_elem -> 'embedding') IS NULL OR jsonb_typeof(v_elem -> 'embedding') <> 'array'
         OR jsonb_array_length(v_elem -> 'embedding') <> 384
      THEN
        UPDATE public.embedding_jobs SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
        RETURN;
      END IF;
    END LOOP;

    BEGIN
      -- First batch of a (re)run: clear any previous chunks for this document so the new
      -- version's chunks never interleave with leftovers.
      IF v_cursor = 0 THEN
        DELETE FROM public.chunks WHERE document_id = v_doc;
      END IF;
      -- Idempotent insert: a reclaimed lease may re-commit the same cursor batch after a kill.
      INSERT INTO public.chunks (user_id, document_id, source_version, chunk_index, content, embedding)
      SELECT
        (SELECT d.user_id FROM public.documents d WHERE d.id = v_doc),
        v_doc, p_drive_modified_time,
        (elem ->> 'chunk_index')::integer, elem ->> 'content', (elem ->> 'embedding')::extensions.vector
      FROM jsonb_array_elements(p_chunks) AS elem
      ON CONFLICT (document_id, chunk_index) DO UPDATE
        SET content = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            source_version = EXCLUDED.source_version;
    EXCEPTION WHEN others THEN
      UPDATE public.embedding_jobs SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
      RETURN;
    END;

    IF p_outcome = 'done' THEN
      UPDATE public.embedding_jobs
        SET status='done', last_error=NULL, claimed_at=NULL,
            next_chunk_index = v_cursor + v_len,
            chunk_count = v_cursor + v_len, truncated = p_truncated, updated_at=now()
        WHERE id = p_job_id;
    ELSE
      -- Batch committed: advance cursor, release for the next request, reset attempts
      -- (forward progress ≠ stuck; attempts only guard zero-progress claim loops).
      UPDATE public.embedding_jobs
        SET status='pending', claimed_at=NULL, last_error=NULL,
            next_chunk_index = v_cursor + v_len, attempts = 0, updated_at=now()
        WHERE id = p_job_id;
    END IF;

  ELSIF p_outcome = 'retry' THEN
    IF p_attempts >= p_max_attempts THEN
      UPDATE public.embedding_jobs SET status='failed', last_error=p_error, claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
    ELSE
      UPDATE public.embedding_jobs SET status='pending', claimed_at=NULL, last_error=p_error, updated_at=now() WHERE id = p_job_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown outcome: %', p_outcome;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION progress_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION progress_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM anon;
REVOKE ALL ON FUNCTION progress_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION progress_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) TO service_role;
