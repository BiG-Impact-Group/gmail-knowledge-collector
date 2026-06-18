CREATE OR REPLACE FUNCTION vault_create_secret(
  secret text,
  name text,
  description text DEFAULT ''
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT vault.create_secret(secret, name, description);
$$;

CREATE OR REPLACE FUNCTION vault_update_secret(
  secret_id uuid,
  new_secret text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT vault.update_secret(secret_id, new_secret);
$$;

CREATE OR REPLACE FUNCTION get_vault_secret(secret_name text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = secret_name LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_vault_secret_id(secret_name text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT id FROM vault.secrets WHERE name = secret_name LIMIT 1;
$$;

REVOKE ALL ON FUNCTION vault_create_secret(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault_update_secret(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_vault_secret(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_vault_secret_id(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION vault_create_secret(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION vault_update_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION get_vault_secret(text) TO service_role;
GRANT EXECUTE ON FUNCTION get_vault_secret_id(text) TO service_role;
