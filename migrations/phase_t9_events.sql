-- phase_t9_events.sql
--
-- Special events: free classes, trainings, promotional events, etc.
-- Distinct from `classes` (recurring, JR-synced) and `closures` (whole-day,
-- all-classes-at-a-school). Events are explicit-date (timestamptz start +
-- end), have multi-staff assignment via event_staff, and render alongside
-- classes on the schedule.
--
-- Why a new table instead of extending `classes`:
--   - JR's nightly sync owns `classes`; introducing event-shaped rows
--     would force the sync to learn about a `kind` discriminator.
--   - Events have different attendance semantics (often no enrollment).
--   - Events have multi-staff (no primary/sub asymmetry).
--   - Future RSVP/signup will live on event_staff or an event_attendees
--     table without polluting class-shaped code paths.
--
-- Permissions: NEW permission `edit_events` added to super_admin, admin,
-- manager bundles. SELECT is open to any authenticated user (mirrors the
-- classes/schools pattern — schedule needs every viewer to see events).
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: each CREATE uses IF NOT EXISTS, each policy is dropped and
-- re-created.

begin;

/* ─── Tables ─────────────────────────────────────────────────────────── */

-- event_kind enum. Adding values later requires `alter type ... add value`,
-- which is fine for forward additions (new kinds in future phases).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'event_kind') then
    create type public.event_kind as enum ('free_class','training','promotional','other');
  end if;
end$$;

create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  kind          public.event_kind not null,
  title         text not null,
  description   text,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  school_id     uuid references public.schools(id) on delete set null,
  location      text,                   -- free-form fallback (e.g. "TBD" or off-site)
  capacity      int,                    -- null = unlimited
  notes         text,                   -- internal notes (not parent-facing)
  is_cancelled  boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint events_capacity_nonneg check (capacity is null or capacity >= 0),
  constraint events_time_window check (ends_at > starts_at)
);

create index if not exists events_starts_at_idx on public.events (starts_at);
create index if not exists events_school_id_idx on public.events (school_id);
create index if not exists events_kind_idx      on public.events (kind);

create or replace function public.touch_events_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

drop trigger if exists trg_events_touch on public.events;
create trigger trg_events_touch
  before update on public.events
  for each row execute function public.touch_events_updated_at();

-- event_staff: multi-staff assignments. No primary/sub asymmetry — all
-- assigned staff are equal-tier. role_label is free-form ("Lead",
-- "Assistant", "Greeter", "Photographer") so a franchise can use whatever
-- terminology fits without a schema change.
create table if not exists public.event_staff (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  teacher_id  uuid not null references public.teachers(id) on delete cascade,
  role_label  text,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (event_id, teacher_id)
);

create index if not exists event_staff_event_id_idx   on public.event_staff (event_id);
create index if not exists event_staff_teacher_id_idx on public.event_staff (teacher_id);

/* ─── has_permission(): add edit_events to super_admin / admin / manager ── */

create or replace function public.has_permission(perm text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_granted text[];
  v_revoked text[];
  v_role_perms text[];
begin
  select role,
         coalesce(granted_permissions, '{}'),
         coalesce(revoked_permissions, '{}')
    into v_role, v_granted, v_revoked
    from public.profiles
   where id = auth.uid();

  if v_role is null then
    return false;
  end if;

  if perm = any (v_revoked) then
    return false;
  end if;

  if perm = any (v_granted) then
    return true;
  end if;

  v_role_perms := case v_role
    when 'super_admin' then array[
      'manage_billing','manage_super_admins','manage_admins',
      'manage_org','hard_delete','manage_users',
      'edit_classes','edit_teachers','edit_students','edit_enrollments','edit_attendance',
      'edit_templates','edit_categories','edit_infographics','edit_closures',
      'edit_curriculum','assign_curriculum',
      'edit_events',
      'manage_teacher_payments','manage_teacher_compliance',
      'view_pay_rates','view_billing_status','view_parent_contact',
      'run_jackrabbit_sync','respond_to_leads',
      'reconcile_students',
      'request_sub','claim_sub_requests','manage_all_sub_requests'
    ]::text[]
    when 'admin' then array[
      'manage_users',
      'edit_classes','edit_teachers','edit_students','edit_enrollments','edit_attendance',
      'edit_templates','edit_categories','edit_infographics','edit_closures',
      'edit_curriculum','assign_curriculum',
      'edit_events',
      'manage_teacher_payments','manage_teacher_compliance',
      'view_pay_rates','view_billing_status','view_parent_contact',
      'run_jackrabbit_sync','respond_to_leads',
      'reconcile_students',
      'request_sub','claim_sub_requests','manage_all_sub_requests'
    ]::text[]
    when 'manager' then array[
      'edit_templates','edit_categories','edit_infographics',
      'edit_classes','edit_teachers','edit_closures',
      'edit_curriculum','assign_curriculum',
      'edit_events',
      'respond_to_leads',
      'view_classes_readonly','view_teachers_readonly',
      'view_students_readonly','view_enrollments_readonly',
      'claim_sub_requests','manage_all_sub_requests'
    ]::text[]
    when 'teacher' then array[
      'view_own_schedule','take_own_attendance','clock_in_out',
      'view_own_curriculum','view_own_pay_history','request_sub',
      'view_own_roster','manage_own_roster_students','manage_own_enrollments',
      'claim_sub_requests'
    ]::text[]
    when 'viewer' then array[
      'view_classes_readonly','view_teachers_readonly','view_students_readonly',
      'view_enrollments_readonly','view_attendance_readonly','view_billing_status_readonly'
    ]::text[]
    else '{}'::text[]
  end;

  return perm = any (v_role_perms);
end;
$$;

/* ─── RLS ───────────────────────────────────────────────────────────── */

alter table public.events       enable row level security;
alter table public.event_staff  enable row level security;

-- events SELECT: any signed-in user. Schedule renders for everyone, and
-- promotional events benefit from being visible across the team.
drop policy if exists "events_select" on public.events;
create policy "events_select" on public.events
  for select using (auth.uid() is not null);

drop policy if exists "events_insert" on public.events;
create policy "events_insert" on public.events
  for insert with check (public.has_permission('edit_events'));

drop policy if exists "events_update" on public.events;
create policy "events_update" on public.events
  for update using (public.has_permission('edit_events'))
  with check  (public.has_permission('edit_events'));

drop policy if exists "events_delete" on public.events;
create policy "events_delete" on public.events
  for delete using (public.has_permission('edit_events'));

-- event_staff SELECT: any signed-in user, so the schedule + event card
-- can show staff initials/names without a separate role check.
drop policy if exists "event_staff_select" on public.event_staff;
create policy "event_staff_select" on public.event_staff
  for select using (auth.uid() is not null);

drop policy if exists "event_staff_insert" on public.event_staff;
create policy "event_staff_insert" on public.event_staff
  for insert with check (public.has_permission('edit_events'));

drop policy if exists "event_staff_update" on public.event_staff;
create policy "event_staff_update" on public.event_staff
  for update using (public.has_permission('edit_events'))
  with check  (public.has_permission('edit_events'));

drop policy if exists "event_staff_delete" on public.event_staff;
create policy "event_staff_delete" on public.event_staff
  for delete using (public.has_permission('edit_events'));

/* ─── Realtime publication ──────────────────────────────────────────── */

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'events'
  ) then
    execute 'alter publication supabase_realtime add table public.events';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'event_staff'
  ) then
    execute 'alter publication supabase_realtime add table public.event_staff';
  end if;
end$$;

commit;
