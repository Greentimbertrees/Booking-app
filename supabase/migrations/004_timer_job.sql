-- Every 5 minutes: read new Gmail enquiries and send reminder emails that are due.
-- Replace the project URL if you move to a different Supabase project.
select cron.schedule(
  'greentimber-sync',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://ltfbynpckvmqkjbofssr.supabase.co/functions/v1/api',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from public.server_config where key='cron_secret')),
       body := '{"action":"cron"}'::jsonb,
       timeout_milliseconds := 120000
     ) $$
);
