alter table public.messages add column if not exists kind text not null default 'reply'
  check (kind in ('reply','visit_reminder','job_confirmation','job_reminder','quote','invoice','other'));
alter table public.messages add column if not exists rfc_message_id text;
alter table public.app_settings add column if not exists invoice_footer text not null default 'Payment within 14 days by bank transfer. [Add bank details in Settings]';
alter table public.app_settings add column if not exists quote_valid_days int not null default 60;
alter table public.app_settings add column if not exists invoice_due_days int not null default 14;
