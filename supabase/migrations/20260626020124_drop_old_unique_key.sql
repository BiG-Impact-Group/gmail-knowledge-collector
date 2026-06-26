-- Migration 1b: Drop old unique key (after callback updated to use new constraint)
-- Zero-downtime: callback was updated to user_id,provider,email_address before this runs

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connected_accounts_user_email_unique'
      AND conrelid = 'public.connected_accounts'::regclass
  ) THEN
    ALTER TABLE public.connected_accounts
      DROP CONSTRAINT connected_accounts_user_email_unique;
  END IF;

  -- Guard alternative name in case of prior partial migration
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connected_accounts_user_id_email_address_key'
      AND conrelid = 'public.connected_accounts'::regclass
  ) THEN
    ALTER TABLE public.connected_accounts
      DROP CONSTRAINT connected_accounts_user_id_email_address_key;
  END IF;
END $$;
