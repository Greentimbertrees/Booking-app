-- Calendar invites on customer emails, and the logo and mobile number under the signature.

-- The invite (Google Calendar link + .ics) that goes with an email, if any.
alter table public.messages add column if not exists calendar jsonb;

-- New message kind: confirmation of a site visit booked in the app.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
    where conrelid = 'public.messages'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table public.messages drop constraint %I', c);
  end loop;
end $$;
alter table public.messages add constraint messages_kind_check
  check (kind in ('reply','visit_confirmation','visit_reminder','job_confirmation','job_reminder','quote','invoice','other'));

alter table public.app_settings add column if not exists mobile text default '07908 240167';
alter table public.app_settings add column if not exists logo_url text;

-- Public bucket for the email logo (email clients must be able to load it without signing in).
insert into storage.buckets (id, name, public) values ('branding', 'branding', true)
  on conflict (id) do update set public = true;
drop policy if exists "app users upload branding" on storage.objects;
create policy "app users upload branding" on storage.objects for insert to authenticated
  with check (bucket_id = 'branding' and public.is_app_user());
drop policy if exists "app users update branding" on storage.objects;
create policy "app users update branding" on storage.objects for update to authenticated
  using (bucket_id = 'branding' and public.is_app_user());

-- Starting logo: the one published with the app. Change it any time in Settings.
update public.app_settings set logo_url = 'https://greentimber-jobs.netlify.app/email-logo.png' where id = 1 and logo_url is null;
