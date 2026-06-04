-- phase_t19_admin_work_sessions.sql
--
-- Office/admin time tracking for non-teaching work. The existing
-- `clock_ins` table is class-session-specific (teacher_id + class_id +
-- session_date) and stays as-is for teaching time. This adds a separate,
-- general work clock for admin / manager / super_admin roles: clock in when
-- you start working in the console, clock out when you're done. Idle and
-- activity nudges live entirely client-side; this table is just the store.
--
-- Decisions baked in (per product owner):
--   * Applies to manager / admin / super_admin (is_manager_or_above()).
--   * Clock-out is manual (the client nudges, never force-closes).
--   * Users can amend their own clocked_out_at to an EARLIER time if they
--     forgot to clock out — enforced client-side; the DB only guarantees
--     clocked_out_at >= clocked_in_at.
--   * At most one OPEN session per user (partial unique index), so the
--     "are you clocked in?" check is unambiguous.
--
-- Portable/modular per the DK convention: data lives in its own table,
-- decoupled from the UI. SELECT is self + admin (for future reporting);
-- writes are self-service for manager_or_above.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent.

begin;

-- 0. Role helper: manager / admin / super_admin --------------
-- Mirrors is_admin_or_above() / is_super_admin(); there was no
-- "manager or above" predicate yet.

create or replace function public.is_manager_or_above()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('super_admin','admin','manager')
  );
$$;

-- 1. admin_work_sessions -------------------------------------

create table if not exists public.admin_work_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  clocked_in_at   timestamptz not null default now(),
  clocked_out_at  timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint admin_work_sessions_out_after_in
    check (clocked_out_at is null or clocked_out_at >= clocked_in_at)
);

-- At most one open (not-yet-clocked-out) session per user.
create unique index if not exists admin_work_sessions_one_open
  on public.admin_work_sessions (user_id)
  where clocked_out_at is null;

-- Reporting / listing lookups.
create index if not exists admin_work_sessions_user_idx
  on public.admin_work_sessions (user_id, clocked_in_at desc);

create or replace function public.tg_admin_work_sessions_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists admin_work_sessions_touch on public.admin_work_sessions;
create trigger admin_work_sessions_touch
  before update on public.admin_work_sessions
  for each row execute function public.tg_admin_work_sessions_touch();

alter table public.admin_work_sessions enable row level security;

-- SELECT: a user sees their own sessions; admins/super_admins see all
-- (so a future admin-hours report can aggregate the team).
drop policy if exists "aws_select" on public.admin_work_sessions;
create policy "aws_select"
  on public.admin_work_sessions
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin_or_above());

-- INSERT: self-service, and only for manager_or_above (the roles that do
-- office work). The user_id must be the caller.
drop policy if exists "aws_insert" on public.admin_work_sessions;
create policy "aws_insert"
  on public.admin_work_sessions
  for insert
  to authenticated
  with check (user_id = auth.uid() and public.is_manager_or_above());

-- UPDATE: clock-out + amend-earlier on your own row; admins can correct
-- anyone's (e.g. fixing a forgotten clock-out for a manager).
drop policy if exists "aws_update" on public.admin_work_sessions;
create policy "aws_update"
  on public.admin_work_sessions
  for update
  to authenticated
  using      (user_id = auth.uid() or public.is_admin_or_above())
  with check (user_id = auth.uid() or public.is_admin_or_above());

-- DELETE: self or admin (discard a mistaken session).
drop policy if exists "aws_delete" on public.admin_work_sessions;
create policy "aws_delete"
  on public.admin_work_sessions
  for delete
  to authenticated
  using (user_id = auth.uid() or public.is_admin_or_above());

-- 2. Realtime ------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime' and schemaname='public'
       and tablename='admin_work_sessions'
  ) then
    alter publication supabase_realtime add table public.admin_work_sessions;
  end if;
end $$;

commit;
