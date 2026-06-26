-- Epic 04 (code review v3): add a lifecycle_version guard to the document RPCs.
-- A collector run reads lifecycle_version at run-start and passes it as p_expected_version.
-- If a disconnect+reconnect bumps the version mid-run, the stale collector's writes/deletes/reset
-- no-op under the advisory lock instead of clobbering the freshly-reset backfill state.
-- The arg lists change, so drop the old signatures first (CREATE OR REPLACE can't change arity).

DROP FUNCTION IF EXISTS collect_account_documents(uuid, jsonb, boolean, text, text);
DROP FUNCTION IF EXISTS delete_account_documents(uuid, text[]);
DROP FUNCTION IF EXISTS reset_account_documents(uuid);

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

  -- Active AND same lifecycle generation as when the collector started this run.
  IF NOT EXISTS (
    SELECT 1 FROM connected_accounts
    WHERE id = p_account_id AND status = 'active' AND lifecycle_version = p_expected_version
  ) THEN
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
      drive_modified_time = EXCLUDED.drive_modified_time,
      text_content = EXCLUDED.text_content,
      content_status = EXCLUDED.content_status,
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

CREATE OR REPLACE FUNCTION delete_account_documents(
  p_account_id uuid,
  p_file_ids text[],
  p_expected_version integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  IF NOT EXISTS (
    SELECT 1 FROM connected_accounts
    WHERE id = p_account_id AND status = 'active' AND lifecycle_version = p_expected_version
  ) THEN
    RETURN;
  END IF;
  DELETE FROM documents
    WHERE connected_account_id = p_account_id
      AND drive_file_id = ANY(p_file_ids);
END;
$$;

REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[], integer) FROM anon;
REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[], integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION delete_account_documents(uuid, text[], integer) TO service_role;

CREATE OR REPLACE FUNCTION reset_account_documents(
  p_account_id uuid,
  p_expected_version integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  -- If a reconnect already bumped the version (and reset backfill), this stale 410 reset no-ops.
  IF NOT EXISTS (
    SELECT 1 FROM connected_accounts
    WHERE id = p_account_id AND status = 'active' AND lifecycle_version = p_expected_version
  ) THEN
    RETURN;
  END IF;
  DELETE FROM documents WHERE connected_account_id = p_account_id;
  UPDATE connected_accounts
    SET backfill_complete = false, sync_cursor = NULL, backfill_page_token = NULL, updated_at = now()
    WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION reset_account_documents(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_account_documents(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION reset_account_documents(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION reset_account_documents(uuid, integer) TO service_role;
