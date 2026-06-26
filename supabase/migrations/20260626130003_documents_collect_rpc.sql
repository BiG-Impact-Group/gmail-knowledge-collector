-- Epic 04: atomic, advisory-locked document write RPCs, mirroring collect_account_messages.
-- Closes the purge/collection TOCTOU race: a lifecycle_disconnect(..., purge=true) that runs
-- between a status check and an upsert can no longer be raced into re-inserting purged PII,
-- because the status re-check happens INSIDE the locked transaction.

CREATE OR REPLACE FUNCTION collect_account_documents(
  p_account_id uuid,
  p_documents jsonb,           -- array of document rows to upsert
  p_backfill_complete boolean, -- null = leave unchanged
  p_backfill_page_token text,  -- '__unchanged__' sentinel = leave unchanged
  p_sync_cursor text           -- '__unchanged__' sentinel = leave unchanged
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_doc jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));

  -- Account must still be active inside this transaction, else skip (purge/disconnect raced).
  IF NOT EXISTS (SELECT 1 FROM connected_accounts WHERE id = p_account_id AND status = 'active') THEN
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

  -- Cursor / backfill state writes, atomic with the upserts above.
  -- '__unchanged__' sentinel lets the collector leave a column alone.
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

REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text) FROM anon;
REVOKE ALL ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION collect_account_documents(uuid, jsonb, boolean, text, text) TO service_role;

-- Locked deletion path for removed/trashed files.
CREATE OR REPLACE FUNCTION delete_account_documents(
  p_account_id uuid,
  p_file_ids text[]
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  -- Only act while the account is active. If the user disconnected with purge=false
  -- (status='revoked'), a stale in-flight collector must NOT delete kept documents.
  IF NOT EXISTS (SELECT 1 FROM connected_accounts WHERE id = p_account_id AND status = 'active') THEN
    RETURN;
  END IF;
  DELETE FROM documents
    WHERE connected_account_id = p_account_id
      AND drive_file_id = ANY(p_file_ids);
END;
$$;

REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[]) FROM anon;
REVOKE ALL ON FUNCTION delete_account_documents(uuid, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION delete_account_documents(uuid, text[]) TO service_role;

-- Purge-all + backfill reset under the lock, for the 410-Gone recovery path.
CREATE OR REPLACE FUNCTION reset_account_documents(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  -- Only reset while active — a disconnected account's data must be left to the
  -- lifecycle path, not wiped by a stale collector.
  IF NOT EXISTS (SELECT 1 FROM connected_accounts WHERE id = p_account_id AND status = 'active') THEN
    RETURN;
  END IF;
  DELETE FROM documents WHERE connected_account_id = p_account_id;
  UPDATE connected_accounts
    SET backfill_complete = false, sync_cursor = NULL, backfill_page_token = NULL, updated_at = now()
    WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION reset_account_documents(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_account_documents(uuid) FROM anon;
REVOKE ALL ON FUNCTION reset_account_documents(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION reset_account_documents(uuid) TO service_role;
