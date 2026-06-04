-- phase_t19b_admin_work_caps.sql
--
-- Per-person weekly cap on admin/office time (T19 admin_work_sessions).
-- Set by super_admin only. Enforcement is "warn + notify super_admin",
-- never a hard block — the client surfaces progress toward the cap and
-- flags anyone over it to super_admins. The work-week starts Monday
-- (computed client-side in local time).
--
-- One row per capped user; weekly_cap_minutes null / no row = no cap.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent.

begin;

create table if not exists public.admin_work_caps (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  weekly_cap_minutes  integer check (weekly_cap_minutes is null or weekly_cap_minutes >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.profiles(id)
);

create or replace function public.tg_admin_work_caps_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists admin_work_caps_touch on public.admin_work_caps;
create trigger admin_work_caps_touch
  before update on public.admin_work_caps
  for each row execute function public.tg_admin_work_caps_touch();

alter table public.admin_work_caps enable row level security;

-- SELECT: a user can read their own cap; admins/super_admins read all
-- (the cap manager + over-cap surfacing need the full set).
drop policy if exists "awc_select" on public.admin_work_caps;
create policy "awc_select"
  on public.admin_work_caps
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin_or_above());

-- Writes: super_admin only.
drop policy if exists "awc_insert" on public.admin_work_caps;
create policy "awc_insert"
  on public.admin_work_caps
  for insert
  to authenticated
  with check (public.is_super_admin());

drop policy if exists "awc_update" on public.admin_work_caps;
create policy "awc_update"
  on public.admin_work_caps
  for update
  to authenticated
  using      (public.is_super_admin())
  with check (public.is_super_admin());

drop policy if exists "awc_delete" on public.admin_work_caps;
create policy "awc_delete"
  on public.admin_work_caps
  for delete
  to authenticated
  using (public.is_super_admin());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime' and schemaname='public'
       and tablename='admin_work_caps'
  ) then
    alter publication supabase_realtime add table public.admin_work_caps;
  end if;
end $$;

commit;
