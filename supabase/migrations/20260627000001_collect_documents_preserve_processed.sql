-- Epic 05 (Migration 1, Codex v1 #1): preserve Epic-05-extracted content across collector runs.
-- Epic 04's collect_account_documents upsert overwrote text_content/content_status on conflict,
-- so the next Drive collector run would reset an Epic-05-extracted file back to
-- needs_processing/null. Redefine the RPC (same 6-arg signature, CREATE OR REPLACE) so that on
-- conflict it PRESERVES text_content/content_status when the file is unchanged
-- (drive_modified_time equal), and only resets them when the file actually changed.
-- drive_modified_time itself always updates. Everything else in the RPC (advisory lock, the
-- connected_accounts FOR UPDATE row lock, the version guard, REVOKE/GRANT) is unchanged.

CREATE OR REPLACE FUNCTION collect_account_documents(
  p_account_id uuid,
  p_documents jsonb,
  p_backfill_complete boolean,
  p_backfill_page_token text,
  p_sync_cursor text,
  p_expected_version integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_doc jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));

  -- Lock the row; only proceed if still active at the same lifecycle generation.
  PERFORM 1 FROM connected_accounts
    WHERE id = p_account_id AND status = 'active' AND lifecycle_version = p_expected_version
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents)
  LOOP
    INSERT INTO documents (
      connected_account_id, user_id, drive_file_id, name, mime_type,
      web_view_link, size_bytes, drive_modified_time, text_content, content_status,
      fetched_at, updated_at
    )
    SELECT
      p_account_id,
      (v_doc->>'user_id')::uuid,
      v_doc->>'drive_file_id',
      v_doc->>'name',
      v_doc->>'mime_type',
      v_doc->>'web_view_link',
      NULLIF(v_doc->>'size_bytes','')::bigint,
      NULLIF(v_doc->>'drive_modified_time','')::timestamptz,
      v_doc->>'text_content',
      v_doc->>'content_status',
      now(), now()
    ON CONFLICT (connected_account_id, drive_file_id) DO UPDATE SET
      name = EXCLUDED.name,
      mime_type = EXCLUDED.mime_type,
      web_view_link = EXCLUDED.web_view_link,
      size_bytes = EXCLUDED.size_bytes,
      -- Preserve Epic-05-extracted content when the file is unchanged; only take the
      -- collector's freshly-classified values when drive_modified_time actually changed.
      text_content = CASE WHEN documents.drive_modified_time IS DISTINCT FROM EXCLUDED.drive_modified_time
                          THEN EXCLUDED.text_content ELSE documents.text_content END,
      content_status = CASE WHEN documents.drive_modified_time IS DISTINCT FROM EXCLUDED.drive_modified_time
                            THEN EXCLUDED.content_status ELSE documents.content_status END,
      drive_modified_time = EXCLUDED.drive_modified_time,
      updated_at = now();
  END LOOP;

  UPDATE connected_accounts SET
    backfill_complete   = COALESCE(p_backfill_complete, backfill_complete),
    backfill_page_token = CASE WHEN p_backfill_page_token = '__unchanged__' THEN backfill_page_token
                               ELSE p_backfill_page_token END,
    sync_cursor         = CASE WHEN p_sync_cursor = '__unchanged__' THEN sync_cursor
                               ELSE p_sync_cursor END,
    last_synced_at = now(),
    updated_at = now()
  WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text, integer) TO service_role;
