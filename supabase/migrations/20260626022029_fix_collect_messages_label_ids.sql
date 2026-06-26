-- Fix: guard label_ids ARRAY cast against null/non-array JSON values.
-- Replaces collect_account_messages from 20260626015749_lifecycle_rpcs.sql.

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
      -- Guard against null or non-array JSON to avoid runtime error
      CASE WHEN jsonb_typeof(v_msg->'label_ids') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(v_msg->'label_ids'))
        ELSE NULL
      END
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
