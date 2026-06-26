-- Migration 2: vault_delete_secret helper
-- Follows the exact grant pattern from 20260617000002_vault_helpers.sql

CREATE OR REPLACE FUNCTION vault_delete_secret(secret_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE name = secret_name;
END;
$$;

-- Match the grant pattern from vault_helpers migration
REVOKE ALL ON FUNCTION vault_delete_secret(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault_delete_secret(text) FROM anon;
REVOKE ALL ON FUNCTION vault_delete_secret(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION vault_delete_secret(text) TO service_role;
