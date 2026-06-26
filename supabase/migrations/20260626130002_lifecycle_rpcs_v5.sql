-- Epic 04: extend lifecycle_disconnect to also purge documents when p_purge = true.
-- Body is identical to lifecycle_rpcs_v3 except for the added documents DELETE.
-- lifecycle_delete is unchanged (the documents composite FK ON DELETE CASCADE handles it),
-- so it is not redefined here.

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
    RETURN false;
  END IF;

  UPDATE connected_accounts
    SET status = 'revoked',
        sync_cursor = NULL,
        lifecycle_version = lifecycle_version + 1,
        updated_at = now()
    WHERE id = p_account_id AND user_id = p_user_id;

  IF p_purge THEN
    DELETE FROM messages WHERE connected_account_id = p_account_id;
    DELETE FROM documents WHERE connected_account_id = p_account_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION lifecycle_disconnect(uuid, uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION lifecycle_disconnect(uuid, uuid, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION lifecycle_disconnect(uuid, uuid, boolean, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION lifecycle_disconnect(uuid, uuid, boolean, integer) TO service_role;
