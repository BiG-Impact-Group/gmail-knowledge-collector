-- Epic 05 (code review v2): fix complete_processing_job lock ordering to avoid a deadlock with
-- lifecycle purge/delete. Previously complete locked the job row (FOR UPDATE) first, then the
-- account — while lifecycle_delete/disconnect locks the account first and cascades (account →
-- documents → processing_jobs). Opposite acquisition orders deadlock.
-- Fix: acquire in the SAME order as the lifecycle cascade — account, then document, then job
-- (lease re-checked last). Reads to derive ids are unlocked; the final lease predicate makes a
-- stale job a no-op. claim_processing_jobs is unchanged from v2.

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
  -- Unlocked reads to derive the ids (no row locks held yet).
  SELECT pj.document_id INTO v_doc FROM public.processing_jobs pj WHERE pj.id = p_job_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT d.connected_account_id INTO v_acct FROM public.documents d WHERE d.id = v_doc;
  IF NOT FOUND THEN
    -- Document already gone (account purged). Mark the job failed only if WE still hold the lease.
    UPDATE public.processing_jobs
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
    UPDATE public.processing_jobs
      SET status='failed', last_error='document_gone', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id AND status='processing' AND claimed_at = p_claimed_at AND attempts = p_attempts;
    RETURN;
  END IF;

  -- Lease guard LAST (job row lock acquired after account+document).
  PERFORM 1 FROM public.processing_jobs
    WHERE id = p_job_id AND status='processing' AND claimed_at = p_claimed_at AND attempts = p_attempts
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_ca_status <> 'active'
     OR v_ca_version <> p_lifecycle_version
     OR v_doc_modified IS DISTINCT FROM p_drive_modified_time THEN
    UPDATE public.processing_jobs
      SET status='pending', claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  IF v_content_status <> 'needs_processing' THEN
    UPDATE public.processing_jobs
      SET status='done', last_error=NULL, claimed_at=NULL, updated_at=now()
      WHERE id = p_job_id;
    RETURN;
  END IF;

  IF p_outcome = 'extracted' THEN
    UPDATE public.documents SET text_content=p_text, content_status='extracted', updated_at=now() WHERE id = v_doc;
    UPDATE public.processing_jobs SET status='done', last_error=NULL, claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
  ELSIF p_outcome = 'needs_ocr' THEN
    UPDATE public.documents SET content_status='needs_ocr', updated_at=now() WHERE id = v_doc;
    UPDATE public.processing_jobs SET status='needs_ocr', last_error=NULL, claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
  ELSIF p_outcome = 'skipped' THEN
    UPDATE public.documents SET content_status='skipped', updated_at=now() WHERE id = v_doc;
    UPDATE public.processing_jobs SET status='failed', last_error=p_error, claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
  ELSIF p_outcome = 'retry' THEN
    IF p_attempts >= p_max_attempts THEN
      UPDATE public.documents SET content_status='skipped', updated_at=now() WHERE id = v_doc;
      UPDATE public.processing_jobs SET status='failed', last_error=p_error, claimed_at=NULL, updated_at=now() WHERE id = p_job_id;
    ELSE
      UPDATE public.processing_jobs SET status='pending', claimed_at=NULL, last_error=p_error, updated_at=now() WHERE id = p_job_id;
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