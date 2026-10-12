-- Gmail threads whose jobs were removed from the app. The email stays in Gmail;
-- the sync skips any further messages in these threads so the card doesn't come back.
create table if not exists public.removed_threads (
  thread_id text primary key,
  removed_at timestamptz not null default now()
);
alter table public.removed_threads enable row level security;
-- No policies: only the server function (service role) reads or writes this table.
