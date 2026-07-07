-- SECURITY P0 (system audit, Supabase advisor 0028/0029): the Vault helper RPCs were created
-- without revoking Postgres's default PUBLIC EXECUTE grant, so `anon` and `authenticated` could
-- call them through PostgREST (/rest/v1/rpc/...). All are SECURITY DEFINER:
--   * get_vault_secret(name)        → returned OAuth refresh tokens to ANY caller (invariant #2
--                                     violation: tokens must never reach the browser)
--   * get_vault_secret_id(name)     → leaked secret ids
--   * vault_create_secret(...)      → let any caller create/plant secrets
--   * vault_update_secret(id, new)  → let any caller overwrite tokens / CRON_SECRET (corruption/DoS)
-- vault_delete_secret was already service_role-only (locked down in a prior migration); these four
-- were missed. Edge functions call these under the service role, so nothing legitimate changes.

REVOKE ALL ON FUNCTION get_vault_secret(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_vault_secret(text) FROM anon;
REVOKE ALL ON FUNCTION get_vault_secret(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_vault_secret(text) TO service_role;

REVOKE ALL ON FUNCTION get_vault_secret_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_vault_secret_id(text) FROM anon;
REVOKE ALL ON FUNCTION get_vault_secret_id(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_vault_secret_id(text) TO service_role;

REVOKE ALL ON FUNCTION vault_create_secret(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault_create_secret(text, text, text) FROM anon;
REVOKE ALL ON FUNCTION vault_create_secret(text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION vault_create_secret(text, text, text) TO service_role;

REVOKE ALL ON FUNCTION vault_update_secret(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault_update_secret(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION vault_update_secret(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION vault_update_secret(uuid, text) TO service_role;
