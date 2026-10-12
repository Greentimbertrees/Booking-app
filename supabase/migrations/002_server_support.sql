create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table public.jobs add column if not exists offered_slots jsonb not null default '[]'::jsonb;
alter table public.site_visits add column if not exists call_event_id text;

-- Gmail messages already looked at (enquiry or not)
create table public.processed_gmail (
  gmail_id text primary key,
  is_enquiry boolean,
  processed_at timestamptz not null default now()
);
alter table public.processed_gmail enable row level security;

-- Server-only settings (no client access)
create table public.server_config (
  key text primary key,
  value text not null
);
alter table public.server_config enable row level security;
insert into public.server_config (key, value) values
  ('state_secret', encode(extensions.gen_random_bytes(32), 'hex')),
  ('cron_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- Invoice numbers GT-0001, GT-0002 ...
create sequence if not exists public.invoice_seq;
