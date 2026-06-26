-- Epic 05 (Migration 5): schedule file-processor to run every 5 minutes via pg_cron + pg_net.
-- Scheduled LAST in the deployment order, after the edge function is deployed and smoke-tested.
-- Mirrors 20260626130004_drive_cron.sql.
DO $$
BEGIN
  PERFORM cron.unschedule('process-files-every-5min');
EXCEPTION WHEN others THEN
  NULL;
END $$;

SELECT cron.schedule(
  'process-files-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/file-processor',
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
