-- Epic 06 (code review v1): harden claim/complete embedding RPCs.
-- I2: bind claim to the job's source_version — only claim when the document's current
--     drive_modified_time is non-null AND equals the job's recorded source_version (avoids
--     embedding under a version mismatch / a redundant re-embed for extracted→extracted changes).
-- I2: complete uses STRICT version equality (reject null or mismatch), not IS DISTINCT FROM.
-- I3: complete fails CLOSED on bad p_chunks — require jsonb array, null-safe element checks, and
--     wrap delete+insert in an EXCEPTION block so any cast/insert error marks 'invalid_chunks'
--     (job is reclaimable) instead of aborting the whole RPC and wedging the job as 'processing'.
-- enqueue_embedding_jobs is unchanged (already version-aware + purge).

CREATE OR REPLACE FUNCTION claim_embedding_jobs(
  p_limit integer, p_stale_seconds integer, p_max_attempts integer
) RETURNS TABLE (
  job_id uuid, document_id uuid, user_id uuid, attempts integer, claimed_at timestamptz,
  connected_account_id uuid, lifecycle_version integer, drive_modified_time timestamptz
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
      AND d.drive_modified_time = pj.source_version          -- bind to the queued version (I2)
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
      RETURNING pj.id, pj.document_id, pj.user_id, pj.attempts, pj.claimed_at
  )
  SELECT c.id, c.document_id, c.user_id, c.attempts, c.claimed_at,
         d.connected_account_id, ca.lifecycle_version, d.drive_modified_time
  FROM claimed c
  JOIN public.documents d ON d.id = c.document_id
  JOIN public.connected_accounts ca ON ca.id = d.connected_account_id;
END;
$$;

REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION claim_embedding_jobs(integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_embedding_jobs(integer, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION complete_embedding_job(
  p_job_id uuid, p_claimed_at timestamptz, p_attempts integer, p_lifecycle_version integer,
  p_drive_modified_time timestamptz, p_outcome text, p_chunks jsonb, p_truncated boolean,
  p_error text, p_max_attempts integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_max_chunks   constant integer := 50;
  v_max_content  constant integer := 8000;
  v_doc uuid; v_acct uuid; v_ca_status text; v_ca_version integer;
  v_doc_modified timestamptz; v_content_status text; v_len integer; v_elem jsonb; v_idx integer;
BEGIN
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

  PERFORM 1 FROM public.embedding_jobs
    WHERE id = p_job_id AND status='processing' AND claimed_at = p_claimed_at AND attempts = p_attempts
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- Strict version equality (reject null or mismatch) + lifecycle + extracted recheck (I2).
  IF v_ca_status <> 'active'
     OR v_ca_version <> p_lifecycle_version
     OR p_drive_modified_time IS NULL
     OR v_doc_modified IS NULL
     OR v_doc_modified <> p_drive_modified_time
     OR v_content_status <> 'extracted' THEN
    UPDATE public.embedding_jobs SET status='pending', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
    RETURN;
  END IF;

  IF p_outcome = 'done' THEN
    -- Fail CLOSED on malformed payload (I3): require an array first.
    IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
      UPDATE public.embedding_jobs SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
      RETURN;
    END IF;
    v_len := jsonb_array_length(p_chunks);
    IF v_len < 1 OR v_len > v_max_chunks THEN
      UPDATE public.embedding_jobs SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
      RETURN;
    END IF;
    FOR v_idx IN 0 .. v_len - 1 LOOP
      v_elem := p_chunks -> v_idx;
      -- Null-safe element validation: missing keys are SQL NULL → caught by the IS NULL checks.
      IF v_elem IS NULL
         OR jsonb_typeof(v_elem) <> 'object'
         OR (v_elem -> 'chunk_index') IS NULL OR jsonb_typeof(v_elem -> 'chunk_index') <> 'number'
         OR (v_elem ->> 'chunk_index') !~ '^[0-9]+$'
         OR (v_elem -> 'content') IS NULL OR jsonb_typeof(v_elem -> 'content') <> 'string'
         OR length(v_elem ->> 'content') = 0 OR length(v_elem ->> 'content') > v_max_content
         OR (v_elem -> 'embedding') IS NULL OR jsonb_typeof(v_elem -> 'embedding') <> 'array'
         OR jsonb_array_length(v_elem -> 'embedding') <> 384
      THEN
        UPDATE public.embedding_jobs SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
        RETURN;
      END IF;
    END LOOP;

    -- Replace chunks atomically; any residual cast/insert error fails closed as invalid_chunks
    -- (the sub-block rolls back the delete; the job lock is still held so we can mark it).
    BEGIN
      DELETE FROM public.chunks WHERE document_id = v_doc;
      INSERT INTO public.chunks (user_id, document_id, source_version, chunk_index, content, embedding)
      SELECT
        (SELECT d.user_id FROM public.documents d WHERE d.id = v_doc),
        v_doc, p_drive_modified_time,
        (elem ->> 'chunk_index')::integer, elem ->> 'content', (elem ->> 'embedding')::extensions.vector
      FROM jsonb_array_elements(p_chunks) AS elem;
    EXCEPTION WHEN others THEN
      UPDATE public.embedding_jobs SET status='failed', last_error='invalid_chunks', claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
      RETURN;
    END;

    UPDATE public.embedding_jobs
      SET status='done', last_error=NULL, claimed_at=NULL, chunk_count=v_len, truncated=p_truncated, updated_at=now()
      WHERE id = p_job_id;

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

REVOKE ALL ON FUNCTION complete_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM anon;
REVOKE ALL ON FUNCTION complete_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_embedding_job(uuid, timestamptz, integer, integer, timestamptz, text, jsonb, boolean, text, integer) TO service_role;