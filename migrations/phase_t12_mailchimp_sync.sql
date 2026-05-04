-- T12 — Mailchimp sync (one-way DK → MC + MC webhooks back).
--
-- Per-franchise audience: each PAR DK install points at its own Mailchimp
-- account. No shared audience across franchises. Sync key is lower(parent_email).
--
-- See CLAUDE.md §4.29 for the design rationale.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) dk_config: per-franchise MC credentials.
--    All four nullable; if mailchimp_api_key is null the drain no-ops gracefully.
-- ─────────────────────────────────────────────────────────────────────────────

alter table dk_config
  add column if not exists mailchimp_api_key text,
  add column if not exists mailchimp_server_prefix text,
  add column if not exists mailchimp_audience_id text,
  add column if not exists mailchimp_webhook_secret text,
  add column if not exists mailchimp_double_opt_in boolean not null default true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) students.marketing_status — only the MC webhook writes this.
-- ─────────────────────────────────────────────────────────────────────────────

alter table students
  add column if not exists marketing_status text
    check (marketing_status in ('subscribed','unsubscribed','cleaned','pending'))
    default 'pending',
  add column if not exists marketing_status_updated_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Outbox queue. One row per (student, parent_email). Drained by pg_cron
--    every 60s via dk-mailchimp-drain. Append-only from triggers; the drain
--    function stamps completed_at / attempts / last_error.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists mailchimp_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students(id) on delete cascade,
  parent_email text not null,
  op text not null check (op in ('upsert','archive')),
  enqueued_at timestamptz not null default now(),
  attempted_at timestamptz,
  attempts int not null default 0,
  last_error text,
  completed_at timestamptz
);

create index if not exists mailchimp_sync_outbox_pending_idx
  on mailchimp_sync_outbox (enqueued_at)
  where completed_at is null;

create index if not exists mailchimp_sync_outbox_student_idx
  on mailchimp_sync_outbox (student_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Append-only sync audit log. Mirrors sync_log pattern.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists mailchimp_sync_log (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('outbound','inbound')),
  event text not null,
  parent_email text,
  student_id uuid,
  status int,
  payload jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists mailchimp_sync_log_created_idx
  on mailchimp_sync_log (created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) RLS — admin SELECT only, no client writes (service-role bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────────────

alter table mailchimp_sync_outbox enable row level security;
alter table mailchimp_sync_log    enable row level security;

drop policy if exists mailchimp_outbox_admin_read on mailchimp_sync_outbox;
create policy mailchimp_outbox_admin_read on mailchimp_sync_outbox
  for select to authenticated
  using (is_admin());

drop policy if exists mailchimp_log_admin_read on mailchimp_sync_log;
create policy mailchimp_log_admin_read on mailchimp_sync_log
  for select to authenticated
  using (is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Triggers — enqueue on students INSERT/UPDATE and enrollments any change.
--    parent_emails is text[] NOT NULL (defaults to '{}') so we can iterate
--    without a null guard.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function enqueue_mailchimp_sync_for_student()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  e text;
begin
  foreach e in array coalesce(new.parent_emails, '{}'::text[]) loop
    if e is null or btrim(e) = '' then continue; end if;
    insert into mailchimp_sync_outbox (student_id, parent_email, op)
      values (new.id, lower(btrim(e)), 'upsert');
  end loop;
  return new;
end$$;

drop trigger if exists students_mc_sync on students;
create trigger students_mc_sync
  after insert or update of first_name, last_name, parent_emails,
                            parent_names, status
  on students for each row
  execute function enqueue_mailchimp_sync_for_student();

create or replace function enqueue_mailchimp_sync_for_enrollment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s_id uuid;
  s_emails text[];
  e text;
begin
  s_id := coalesce(new.student_id, old.student_id);
  if s_id is null then return coalesce(new, old); end if;

  select parent_emails into s_emails from students where id = s_id;
  if s_emails is null then return coalesce(new, old); end if;

  foreach e in array s_emails loop
    if e is null or btrim(e) = '' then continue; end if;
    insert into mailchimp_sync_outbox (student_id, parent_email, op)
      values (s_id, lower(btrim(e)), 'upsert');
  end loop;
  return coalesce(new, old);
end$$;

drop trigger if exists enrollments_mc_sync on enrollments;
create trigger enrollments_mc_sync
  after insert or update or delete on enrollments
  for each row execute function enqueue_mailchimp_sync_for_enrollment();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) Realtime — outbox + log so the admin status pill updates live.
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  begin
    alter publication supabase_realtime add table mailchimp_sync_outbox;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table mailchimp_sync_log;
  exception when duplicate_object then null; end;
end$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) Vault secret + pg_cron schedule for the drain function.
--    Mirrors the jackrabbit_sync_cron_secret pattern. The secret value is set
--    out-of-band (dashboard or `select vault.create_secret(...)`) — we don't
--    want a literal in this migration.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  has_secret boolean;
begin
  select exists(select 1 from vault.decrypted_secrets where name = 'mailchimp_drain_cron_secret')
    into has_secret;
  if not has_secret then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'mailchimp_drain_cron_secret',
      'Bearer secret for pg_cron → dk-mailchimp-drain Edge Function (T12).'
    );
  end if;
end$$;

select cron.schedule(
  'dk-mailchimp-drain',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://ybolygqdbjqowfoqvnsz.supabase.co/functions/v1/dk-mailchimp-drain',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mailchimp_drain_cron_secret')
      ),
      body    := '{}'::jsonb
    ) as request_id;
  $$
);
