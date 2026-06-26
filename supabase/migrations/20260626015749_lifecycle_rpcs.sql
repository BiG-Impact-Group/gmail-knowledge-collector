-- Migration 3: RPC functions for atomic lifecycle operations
-- All SECURITY DEFINER, service_role only

-- collect_account_messages: atomic upsert of messages + cursor update with advisory lock
CREATE OR REPLACE FUNCTION collect_account_messages(
  p_account_id uuid,
  p_messages jsonb,
  p_new_cursor text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msg jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));

  -- If account is no longer active, skip silently (revoked mid-run)
  IF NOT EXISTS (
    SELECT 1 FROM connected_accounts WHERE id = p_account_id AND status = 'active'
  ) THEN
    RETURN;
  END IF;

  -- Upsert each message from the JSON array
  FOR v_msg IN SELECT * FROM jsonb_array_elements(p_messages)
  LOOP
    INSERT INTO messages (
      connected_account_id,
      user_id,
      gmail_message_id,
      thread_id,
      from_address,
      to_addresses,
      subject,
      snippet,
      internal_date,
      body_text,
      body_html,
      label_ids
    )
    SELECT
      p_account_id,
      (v_msg->>'user_id')::uuid,
      v_msg->>'gmail_message_id',
      v_msg->>'thread_id',
      v_msg->>'from_address',
      v_msg->>'to_addresses',
      v_msg->>'subject',
      v_msg->>'snippet',
      (v_msg->>'internal_date')::timestamptz,
      v_msg->>'body_text',
      v_msg->>'body_html',
      ARRAY(SELECT jsonb_array_elements_text(v_msg->'label_ids'))
    ON CONFLICT (connected_account_id, gmail_message_id)
    DO UPDATE SET
      thread_id = EXCLUDED.thread_id,
      from_address = EXCLUDED.from_address,
      to_addresses = EXCLUDED.to_addresses,
      subject = EXCLUDED.subject,
      snippet = EXCLUDED.snippet,
      internal_date = EXCLUDED.internal_date,
      body_text = EXCLUDED.body_text,
      body_html = EXCLUDED.body_html,
      label_ids = EXCLUDED.label_ids;
  END LOOP;

  -- Update sync cursor
  UPDATE connected_accounts
    SET sync_cursor = p_new_cursor,
        last_synced_at = now(),
        updated_at = now()
    WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION collect_account_messages(uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION collect_account_messages(uuid, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION collect_account_messages(uuid, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION collect_account_messages(uuid, jsonb, text) TO service_role;

-- lifecycle_disconnect: atomic revoke + optional purge with version check
CREATE OR REPLACE FUNCTION lifecycle_disconnect(
  p_account_id uuid,
  p_user_id uuid,
  p_purge boolean,
  p_expected_version integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));

  SELECT lifecycle_version INTO v_version
    FROM connected_accounts
    WHERE id = p_account_id AND user_id = p_user_id;

  IF v_version IS DISTINCT FROM p_expected_version THEN
    RETURN false; -- reconnect raced; caller must revoke the new token
  END IF;

  UPDATE connected_accounts
    SET status = 'revoked',
        sync_cursor = NULL,
        updated_at = now()
    WHERE id = p_account_id AND user_id = p_user_id;

  IF p_purge THEN
    DELETE FROM messages WHERE connected_account_id = p_account_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION lifecycle_disconnect(uuid, uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION lifecycle_disconnect(uuid, uuid, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION lifecycle_disconnect(uuid, uuid, boolean, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION lifecycle_disconnect(uuid, uuid, boolean, integer) TO service_role;

-- lifecycle_delete: atomic delete with version check (cascades messages via FK)
CREATE OR REPLACE FUNCTION lifecycle_delete(
  p_account_id uuid,
  p_user_id uuid,
  p_expected_version integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));

  SELECT lifecycle_version INTO v_version
    FROM connected_accounts
    WHERE id = p_account_id AND user_id = p_user_id;

  IF v_version IS DISTINCT FROM p_expected_version THEN
    RETURN false;
  END IF;

  DELETE FROM connected_accounts
    WHERE id = p_account_id AND user_id = p_user_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION lifecycle_delete(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION lifecycle_delete(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION lifecycle_delete(uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION lifecycle_delete(uuid, uuid, integer) TO service_role;
