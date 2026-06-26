-- Epic 04: schedule google-drive-collector to run every 5 minutes via pg_cron + pg_net.
-- Scheduled LAST in the deployment order, after the collector is deployed and smoke-tested.
DO $$
BEGIN
  PERFORM cron.unschedule('collect-drive-every-5min');
EXCEPTION WHEN others THEN
  NULL;
END $$;

SELECT cron.schedule(
  'collect-drive-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-drive-collector',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'CRON_SECRET'
        LIMIT 1
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
