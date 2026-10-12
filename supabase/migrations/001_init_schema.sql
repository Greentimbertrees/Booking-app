-- Who may use the app (owner and any staff added later)
create table public.app_users (
  email text primary key,
  name text,
  created_at timestamptz not null default now()
);

create or replace function public.is_app_user()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- App-wide settings (single row)
create table public.app_settings (
  id int primary key default 1 check (id = 1),
  auto_send_first_reply boolean not null default false,
  auto_send_followups boolean not null default true,
  flag_emergencies boolean not null default true,
  call_reminder_days int not null default 3,
  customer_reminder_days int not null default 2,
  visit_minutes int not null default 45,
  visit_day_start time not null default '09:00',
  visit_day_end time not null default '16:00',
  business_name text not null default 'Green Timber Trees',
  signature text not null default 'Adam – Green Timber Trees',
  vat_rate numeric(5,2) not null default 20.00,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1);

-- Rate cards per area or job scale
create table public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  day_rate numeric(10,2),
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.rate_cards (name, notes) values
  ('Brighton & Hove', 'Urban, permit parking'),
  ('Mid Sussex', 'Standard'),
  ('Large job', '3+ days');

-- Equipment and materials catalogue
create table public.catalogue_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('equipment','material')),
  name text not null,
  owned boolean not null default false,
  unit text not null default 'day',
  default_cost numeric(10,2),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.catalogue_items (kind, name, owned, unit) values
  ('equipment','Climbing and rigging kit', true, 'day'),
  ('equipment','Chipper', true, 'day'),
  ('equipment','Tracked carrier', false, 'day'),
  ('equipment','Stump grinder', false, 'day'),
  ('equipment','MEWP / cherry picker', false, 'day'),
  ('material','Ground protection boards', false, 'job'),
  ('material','Green waste disposal', false, 'load'),
  ('material','Fuel and oil', false, 'day');

-- Customers
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text,
  email text,
  whatsapp text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_email_idx on public.customers (lower(email));
create index customers_phone_idx on public.customers (phone);

-- Jobs: one per enquiry, moves through steps 1-5
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  step int not null default 1 check (step between 1 and 5),
  status text not null default 'open' check (status in ('open','won','lost','completed','cancelled')),
  title text,
  summary text,
  source text not null default 'email' check (source in ('email','whatsapp','sms','phone','web','other')),
  urgency text not null default 'standard' check (urgency in ('emergency','standard','flexible')),
  site_address text,
  postcode text,
  access_notes text,
  waste_notes text,
  missing_fields text[] not null default '{}',
  tpo_status text not null default 'unknown' check (tpo_status in ('unknown','not_required','required','applied','granted','refused')),
  conservation_area text not null default 'unknown' check (conservation_area in ('unknown','no','yes')),
  permission_submitted_on date,
  earliest_start date,
  nesting_check text not null default 'not_needed' check (nesting_check in ('not_needed','required','done')),
  rate_card_id uuid references public.rate_cards(id) on delete set null,
  crew_size int,
  days_on_site numeric(5,2),
  job_start date,
  job_end date,
  job_calendar_event_id text,
  lost_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_step_idx on public.jobs (step, status);
create index jobs_customer_idx on public.jobs (customer_id);

-- All messages in and out (email, WhatsApp, SMS)
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp','sms')),
  direction text not null check (direction in ('in','out')),
  status text not null default 'received' check (status in ('received','draft','scheduled','sent','failed')),
  from_addr text,
  to_addr text,
  subject text,
  body text,
  external_id text,
  thread_id text,
  send_at timestamptz,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index messages_external_idx on public.messages (channel, external_id) where external_id is not null;
create index messages_job_idx on public.messages (job_id, created_at);
create index messages_due_idx on public.messages (status, send_at);

-- Site visits (step 2)
create table public.site_visits (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'proposed' check (status in ('proposed','confirmed','done','cancelled')),
  calendar_event_id text,
  call_reminder_at timestamptz,
  customer_reminder_at timestamptz,
  customer_reminder_sent_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index site_visits_job_idx on public.site_visits (job_id);

-- Trees and plants to treat (step 3)
create table public.flora (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  label text,
  species text,
  size_note text,
  work_spec text,
  tpo_required boolean not null default false,
  notes text,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index flora_job_idx on public.flora (job_id);

-- Photos stored in the job-photos bucket
create table public.photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  flora_id uuid references public.flora(id) on delete set null,
  storage_path text not null,
  source text not null default 'camera' check (source in ('camera','gallery','email','whatsapp','sms')),
  caption text,
  created_at timestamptz not null default now()
);
create index photos_job_idx on public.photos (job_id);

-- Costing lines: labour, equipment hire, materials, permissions
create table public.job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  catalogue_item_id uuid references public.catalogue_items(id) on delete set null,
  kind text not null check (kind in ('labour','equipment','material','permission','other')),
  description text not null,
  quantity numeric(10,2) not null default 1,
  unit text,
  unit_cost numeric(10,2) not null default 0,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index job_items_job_idx on public.job_items (job_id);

-- Quotes (step 4)
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  version int not null default 1,
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined','expired')),
  subtotal numeric(10,2) not null default 0,
  vat numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  valid_until date,
  notes text,
  sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index quotes_job_idx on public.quotes (job_id);

-- Questions to settle at any step (e.g. step 4 Q&A, step 5 checklist)
create table public.job_questions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  step int not null check (step between 1 and 5),
  question text not null,
  answer text,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index job_questions_job_idx on public.job_questions (job_id);

-- Invoices
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  number text unique,
  status text not null default 'draft' check (status in ('draft','sent','paid','overdue','void')),
  subtotal numeric(10,2) not null default 0,
  vat numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  issued_on date,
  due_on date,
  paid_on date,
  created_at timestamptz not null default now()
);
create index invoices_job_idx on public.invoices (job_id);

-- Google account link (tokens): server functions only, never the browser
create table public.google_connections (
  id int primary key default 1 check (id = 1),
  google_email text,
  refresh_token text,
  access_token text,
  access_expires_at timestamptz,
  calendar_id text default 'primary',
  calendar_name text,
  last_gmail_history_id text,
  last_synced_at timestamptz,
  updated_at timestamptz not null default now()
);

-- updated_at triggers
create trigger customers_updated before update on public.customers for each row execute function public.set_updated_at();
create trigger jobs_updated before update on public.jobs for each row execute function public.set_updated_at();
create trigger site_visits_updated before update on public.site_visits for each row execute function public.set_updated_at();
create trigger app_settings_updated before update on public.app_settings for each row execute function public.set_updated_at();
create trigger google_connections_updated before update on public.google_connections for each row execute function public.set_updated_at();

-- Row level security: only listed app users; google_connections has no client policy
do $$
declare t text;
begin
  foreach t in array array['app_settings','rate_cards','catalogue_items','customers','jobs','messages','site_visits','flora','photos','job_items','quotes','job_questions','invoices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "app users full access" on public.%I for all to authenticated using (public.is_app_user()) with check (public.is_app_user())', t);
  end loop;
end $$;

alter table public.app_users enable row level security;
create policy "app users can see list" on public.app_users for select to authenticated using (public.is_app_user());

alter table public.google_connections enable row level security;

-- Safe view of the Google link for the app (no tokens)
create view public.google_status with (security_invoker = false) as
  select google_email, calendar_id, calendar_name, last_synced_at,
         (refresh_token is not null) as connected
  from public.google_connections
  where public.is_app_user();
grant select on public.google_status to authenticated;

-- Private photo bucket
insert into storage.buckets (id, name, public) values ('job-photos', 'job-photos', false)
on conflict (id) do nothing;

create policy "app users read photos" on storage.objects for select to authenticated
  using (bucket_id = 'job-photos' and public.is_app_user());
create policy "app users upload photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'job-photos' and public.is_app_user());
create policy "app users update photos" on storage.objects for update to authenticated
  using (bucket_id = 'job-photos' and public.is_app_user());
create policy "app users delete photos" on storage.objects for delete to authenticated
  using (bucket_id = 'job-photos' and public.is_app_user());
