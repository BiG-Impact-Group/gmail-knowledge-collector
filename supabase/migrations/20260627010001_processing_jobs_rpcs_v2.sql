-- Epic 05 (code review v1): harden claim/complete RPCs.
-- C1: complete_processing_job now locks the connected_accounts row too (account→document order,
--     matching collect_account_documents), so a concurrent reconnect can't change status/version
--     between the recheck SELECT and the document write.
-- I4: claim only picks documents that are still content_status='needs_processing', and complete
--     rechecks it before applying an outcome (a doc the collector already changed is left alone).
-- enqueue_processing_jobs is unchanged.

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
  -- Cap-fail crashed jobs (stale 'processing' past max attempts). Only flips a still-needs_processing
  -- document to 'skipped' (a file change re-collects → re-enqueues; see review note I3).
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

  RETURN QUERY
  WITH claimable AS (
    SELECT pj.id
    FROM public.processing_jobs pj
    JOIN public.documents d ON d.id = pj.document_id
    JOIN public.connected_accounts ca ON ca.id = d.connected_account_id
    WHERE ca.status = 'active'
      AND ca.provider = 'google_drive'
      AND d.content_status = 'needs_processing'   -- I4: don't claim docs already moved on
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
  v_acct uuid;
  v_ca_status text;
  v_ca_version integer;
  v_doc_modified timestamptz;
  v_content_status text;
BEGIN
  -- 1. Lease guard: derive document_id, lock the job row.
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

  -- 2. Lock the account FIRST (matches collect_account_documents' account→document order, C1),
  --    then the document, then read the recheck values.
  SELECT d.connected_account_id INTO v_acct FROM public.documents d WHERE d.id = v_doc;
  IF NOT FOUND THEN
    UPDATE public.processing_jobs
      SET status='failed', last_error='document_gone', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  PERFORM 1 FROM public.connected_accounts WHERE id = v_acct FOR UPDATE;

  SELECT ca.status, ca.lifecycle_version, d.drive_modified_time, d.content_status
    INTO v_ca_status, v_ca_version, v_doc_modified, v_content_status
    FROM public.documents d
    JOIN public.connected_accounts ca ON ca.id = d.connected_account_id
    WHERE d.id = v_doc
    FOR UPDATE OF d;

  IF NOT FOUND THEN
    UPDATE public.processing_jobs
      SET status='failed', last_error='document_gone', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  -- Stale account generation or the file changed since claim → don't write; release for a fresh job.
  IF v_ca_status <> 'active'
     OR v_ca_version <> p_lifecycle_version
     OR v_doc_modified IS DISTINCT FROM p_drive_modified_time THEN
    UPDATE public.processing_jobs
      SET status='pending', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  -- I4: the document already moved on (collector or another path changed it) → our work is moot.
  IF v_content_status <> 'needs_processing' THEN
    UPDATE public.processing_jobs
      SET status='done', last_error=NULL, claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  -- 3. Apply outcome.
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