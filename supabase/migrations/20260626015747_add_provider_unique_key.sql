-- Migration 1a: Add provider-aware unique key (keep old constraint while deploying callback update)
-- Zero-downtime: both constraints coexist until callback is deployed, then Migration 1b drops old

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connected_accounts_user_id_provider_email_address_key'
      AND conrelid = 'public.connected_accounts'::regclass
  ) THEN
    ALTER TABLE public.connected_accounts
      ADD CONSTRAINT connected_accounts_user_id_provider_email_address_key
        UNIQUE (user_id, provider, email_address);
  END IF;
END $$;
