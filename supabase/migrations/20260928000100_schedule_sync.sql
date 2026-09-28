-- Every 30 minutes, ask the API to do its scheduled work: a full Plaid sync once a day, plus re-pulling any
-- login linked in the last hour (Plaid delivers the history a few minutes after linking).
--
-- The function's address and the shared secret live in Supabase Vault (set once when deploying; never in
-- this repo):
--   select vault.create_secret('https://<project>.supabase.co/functions/v1/api', 'api_url');
--   select vault.create_secret('<random secret, same as the CRON_SECRET function secret>', 'cron_secret');
-- Until both exist, the job does nothing.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'finance-hub-sync',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'api_url') || '/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000)
  where exists (select 1 from vault.decrypted_secrets where name = 'api_url')
    and exists (select 1 from vault.decrypted_secrets where name = 'cron_secret');
  $$
);
