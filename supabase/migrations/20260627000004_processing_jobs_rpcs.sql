-- Epic 05 (Migration 4): producer/claim/complete RPCs for processing_jobs.
-- All SECURITY DEFINER SET search_path = public, schema-qualified refs, REVOKE from
-- PUBLIC/anon/authenticated + GRANT EXECUTE to service_role only (Codex v2 #3). The browser never
-- calls these; only the file-processor edge function (service role) does.

-- ============================================================================
-- enqueue_processing_jobs() — producer.
-- Inserts a pending job for every documents row with content_status='needs_processing'. On
-- conflict it REOPENS a terminal job (done/failed/needs_ocr) so a file that changed and was reset
-- re-runs, but leaves in-flight (pending/processing) jobs alone (Codex v1 #10).
-- ============================================================================
CREATE OR REPLACE FUNCTION enqueue_processing_jobs()
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO public.processing_jobs (user_id, document_id, source_type)
  SELECT d.user_id, d.id, 'drive'
  FROM public.documents d
  WHERE d.content_status = 'needs_processing'
  ON CONFLICT (document_id) DO UPDATE
    SET status='pending', attempts=0, claimed_at=NULL, last_error=NULL, updated_at=now()
    WHERE public.processing_jobs.status IN ('done','failed','needs_ocr');
$$;

REVOKE ALL ON FUNCTION enqueue_processing_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_processing_jobs() FROM anon;
REVOKE ALL ON FUNCTION enqueue_processing_jobs() FROM authenticated;
GRANT EXECUTE ON FUNCTION enqueue_processing_jobs() TO service_role;

-- ============================================================================
-- claim_processing_jobs(p_limit, p_stale_seconds, p_max_attempts) — consumer claim.
-- Returns a content-version token (drive_modified_time) + lease (claimed_at) + lifecycle_version
-- so completion can verify nothing changed under it. NO file name is returned (Codex v1 #12 — no
-- PII to logs).
-- ============================================================================
CREATE OR REPLACE FUNCTION claim_processing_jobs(
  p_limit integer,
  p_stale_seconds integer,
  p_max_attempts integer
) RETURNS TABLE (
  job_id uuid,
  document_id uuid,
  user_id uuid,
  attempts integer,
  claimed_at timestamptz,
  drive_file_id text,
  mime_type text,
  connected_account_id uuid,
  lifecycle_version integer,
  drive_modified_time timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stale timestamptz := now() - make_interval(secs => p_stale_seconds);
BEGIN
  -- Step 1 (Codex v1 #4): cap-fail crashed jobs — stale 'processing' jobs that have already
  -- exhausted their attempts → status='failed', and flip their still-needs_processing documents
  -- to 'skipped' so the producer won't re-enqueue them forever.
  WITH capped AS (
    UPDATE public.processing_jobs pj
      SET status='failed', last_error='max_attempts', claimed_at=NULL, updated_at=now()
      WHERE pj.status='processing'
        AND pj.claimed_at < v_stale
        AND pj.attempts >= p_max_attempts
      RETURNING pj.document_id
  )
  UPDATE public.documents d
    SET content_status='skipped', updated_at=now()
    FROM capped
    WHERE d.id = capped.document_id
      AND d.content_status='needs_processing';

  -- Step 2: claim eligible jobs with FOR UPDATE OF pj SKIP LOCKED (no double-claim across
  -- concurrent runs). Eligible = pending OR (processing AND stale AND attempts < max). Only for
  -- active google_drive accounts (Codex v1 #8).
  RETURN QUERY
  WITH claimable AS (
    SELECT pj.id
    FROM public.processing_jobs pj
    JOIN public.documents d ON d.id = pj.document_id
    JOIN public.connected_accounts ca ON ca.id = d.connected_account_id
    WHERE ca.status = 'active'
      AND ca.provider = 'google_drive'
      AND (
        pj.status = 'pending'
        OR (pj.status = 'processing' AND pj.claimed_at < v_stale AND pj.attempts < p_max_attempts)
      )
    ORDER BY pj.created_at
    LIMIT p_limit
    FOR UPDATE OF pj SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.processing_jobs pj
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
    d.drive_file_id,
    d.mime_type,
    d.connected_account_id,
    ca.lifecycle_version,
    d.drive_modified_time
  FROM claimed c
  JOIN public.documents d ON d.id = c.document_id
  JOIN public.connected_accounts ca ON ca.id = d.connected_account_id;
END;
$$;

REVOKE ALL ON FUNCTION claim_processing_jobs(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_processing_jobs(integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION claim_processing_jobs(integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_processing_jobs(integer, integer, integer) TO service_role;

-- ============================================================================
-- complete_processing_job(...) — finalize atomically with lease guard + document row lock +
-- lifecycle recheck + content-version recheck. There is NO p_document_id param — the document is
-- derived from the job row so a caller bug can't write to the wrong document (Codex v2 #1).
-- ============================================================================
CREATE OR REPLACE FUNCTION complete_processing_job(
  p_job_id uuid,
  p_claimed_at timestamptz,
  p_attempts integer,
  p_lifecycle_version integer,
  p_drive_modified_time timestamptz,
  p_outcome text,
  p_text text,
  p_error text,
  p_max_attempts integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_doc uuid;
  v_ca_status text;
  v_ca_version integer;
  v_doc_modified timestamptz;
BEGIN
  -- 1. Lease guard: derive document_id and lock the job row. Only the current attempt
  --    (status='processing' AND claimed_at=lease AND attempts=lease) may finalize. Otherwise a
  --    newer attempt owns it (or it was reset) — return WITHOUT writing (Codex v1 #3).
  SELECT pj.document_id INTO v_doc
    FROM public.processing_jobs pj
    WHERE pj.id = p_job_id
      AND pj.status = 'processing'
      AND pj.claimed_at = p_claimed_at
      AND pj.attempts = p_attempts
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- 2. Lock the document + recheck lifecycle and content version. The document FOR UPDATE
  --    serializes against collect_account_documents' row lock (Codex v1 #2).
  SELECT ca.status, ca.lifecycle_version, d.drive_modified_time
    INTO v_ca_status, v_ca_version, v_doc_modified
    FROM public.documents d
    JOIN public.connected_accounts ca ON ca.id = d.connected_account_id
    WHERE d.id = v_doc
    FOR UPDATE OF d;

  IF NOT FOUND THEN
    -- Document gone (account purged after claim) → permanent: mark job failed, nothing to write.
    UPDATE public.processing_jobs
      SET status='failed', last_error='document_gone', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  IF v_ca_status <> 'active'
     OR v_ca_version <> p_lifecycle_version
     OR v_doc_modified IS DISTINCT FROM p_drive_modified_time THEN
    -- Disconnect/reconnect after claim (Codex v2 #2), or the file changed after claim and the
    -- collector already reset the document (Codex v3): this extraction is of stale content. Do
    -- NOT write the document; release the job back to pending so a fresh job reprocesses.
    UPDATE public.processing_jobs
      SET status='pending', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  -- 3. Apply the outcome.
  IF p_outcome = 'extracted' THEN
    UPDATE public.documents
      SET text_content=p_text, content_status='extracted', updated_at=now()
      WHERE id = v_doc;
    UPDATE public.processing_jobs
      SET status='done', last_error=NULL, claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;

  ELSIF p_outcome = 'needs_ocr' THEN
    UPDATE public.documents
      SET content_status='needs_ocr', updated_at=now()
      WHERE id = v_doc;
    UPDATE public.processing_jobs
      SET status='needs_ocr', last_error=NULL, claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;

  ELSIF p_outcome = 'skipped' THEN
    UPDATE public.documents
      SET content_status='skipped', updated_at=now()
      WHERE id = v_doc;
    UPDATE public.processing_jobs
      SET status='failed', last_error=p_error, claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;

  ELSIF p_outcome = 'retry' THEN
    IF p_attempts >= p_max_attempts THEN
      UPDATE public.documents
        SET content_status='skipped', updated_at=now()
        WHERE id = v_doc;
      UPDATE public.processing_jobs
        SET status='failed', last_error=p_error, claimed_at=NULL, updated_at=now()
        WHERE id = p_job_id;
    ELSE
      -- Document stays needs_processing; release the job for another attempt.
      UPDATE public.processing_jobs
        SET status='pending', claimed_at=NULL, last_error=p_error, updated_at=now()
        WHERE id = p_job_id;
    END IF;

  ELSE
    RAISE EXCEPTION 'unknown outcome: %', p_outcome;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION complete_processing_job(uuid, timestamptz, integer, integer, timestamptz, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_processing_job(uuid, timestamptz, integer, integer, timestamptz, text, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION complete_processing_job(uuid, timestamptz, integer, integer, timestamptz, text, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_processing_job(uuid, timestamptz, integer, integer, timestamptz, text, text, text, integer) TO service_role;
