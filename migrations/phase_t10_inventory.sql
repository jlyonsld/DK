-- phase_t10_inventory.sql
--
-- Inventory: physical items (props, costumes, supplies, equipment) the
-- franchise checks out to a class session or an event. Items can be in
-- only one place at a time — the schema does NOT hard-prevent overlapping
-- assignments (admins occasionally need to override double-bookings),
-- but every read path surfaces conflicts via a time-window overlap check
-- so they can't be missed.
--
-- Why one assignment table with nullable class_id + event_id (vs. two
-- tables): the conflict query is "any two assignments for the same item
-- whose [usage_starts_at, usage_ends_at) windows overlap", and that's
-- trivially expressed against one table. Splitting would require a UNION
-- on every read. The check constraint enforces exactly one of the two
-- FKs is set.
--
-- Why store usage_starts_at / usage_ends_at on the assignment row even
-- though events already have starts_at/ends_at: classes don't have
-- explicit timestamps (they're recurring on a session_date), so the
-- assignment has to materialize the time window from the class's
-- session_date + classes.times string. Doing it once at write time keeps
-- the conflict query a single column-level overlap and lets us index it.
--
-- Permissions: NEW permission `edit_inventory` added to super_admin,
-- admin, manager bundles. SELECT is open to any authenticated user
-- (teachers need to see what's been assigned to their class on the home
-- bento + class detail panel; mirrors classes/schools/events SELECT).
--
-- Photos: stored in a NEW public storage bucket `inventory-photos`
-- mirroring the `infographics` pattern (admin/manager-only writes via
-- the bucket policies; public reads via getPublicUrl). Photo URLs are
-- persisted in inventory_items.photo_urls (text[]) so the UI doesn't
-- need a separate join.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: each CREATE uses IF NOT EXISTS, each policy is dropped and
-- re-created.

begin;

/* ─── Tables ─────────────────────────────────────────────────────────── */

create table if not exists public.inventory_items (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  description       text,
  storage_location  text,                       -- e.g. "Storage room A, shelf 2"
  tags              text[] not null default '{}',
  photo_urls        text[] not null default '{}',
  reorder_url       text,                       -- vendor link to re-order
  notes             text,
  is_archived       boolean not null default false,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists inventory_items_name_idx     on public.inventory_items (name);
create index if not exists inventory_items_archived_idx on public.inventory_items (is_archived);
-- GIN index on tags for "filter by tag" queries.
create index if not exists inventory_items_tags_idx     on public.inventory_items using gin (tags);

create or replace function public.touch_inventory_items_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

drop trigger if exists trg_inventory_items_touch on public.inventory_items;
create trigger trg_inventory_items_touch
  before update on public.inventory_items
  for each row execute function public.touch_inventory_items_updated_at();

-- inventory_assignments: an item checked out for a specific class session
-- OR a specific event. Exactly one of class_id/event_id must be set,
-- enforced by inventory_assignments_target_xor.
--
-- usage_starts_at / usage_ends_at materialize the time window so the
-- conflict overlap query is a single index-able column comparison
-- regardless of class-vs-event. For class assignments the writer
-- computes these from session_date + classes.times; for event
-- assignments they mirror events.starts_at / events.ends_at.
--
-- session_date is kept on class assignments so the schedule can render
-- "what's checked out to this session" without re-deriving the date
-- from usage_starts_at (which is a timestamptz that may have crossed a
-- day boundary in some timezone).
create table if not exists public.inventory_assignments (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references public.inventory_items(id) on delete cascade,
  class_id           uuid references public.classes(id) on delete cascade,
  event_id           uuid references public.events(id) on delete cascade,
  session_date       date,                                -- set when class_id is set
  usage_starts_at    timestamptz not null,
  usage_ends_at      timestamptz not null,
  returned_at        timestamptz,                         -- null = still assigned
  notes              text,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint inventory_assignments_target_xor check (
    (class_id is not null and event_id is null) or
    (class_id is null and event_id is not null)
  ),
  constraint inventory_assignments_class_session_date check (
    class_id is null or session_date is not null
  ),
  constraint inventory_assignments_time_window check (usage_ends_at > usage_starts_at)
);

create index if not exists inventory_assignments_item_idx        on public.inventory_assignments (item_id);
create index if not exists inventory_assignments_class_idx       on public.inventory_assignments (class_id);
create index if not exists inventory_assignments_event_idx       on public.inventory_assignments (event_id);
create index if not exists inventory_assignments_window_idx      on public.inventory_assignments (item_id, usage_starts_at, usage_ends_at);
create index if not exists inventory_assignments_class_sess_idx  on public.inventory_assignments (class_id, session_date);
-- Partial unique: a single class session can't have the same item assigned
-- twice (returned + re-assigned is fine because returned rows aren't part
-- of the constraint). Same idea as sub_requests' partial unique on
-- (class_id, session_date) excluding cancelled rows.
create unique index if not exists inventory_assignments_class_unique
  on public.inventory_assignments (item_id, class_id, session_date)
  where class_id is not null and returned_at is null;
create unique index if not exists inventory_assignments_event_unique
  on public.inventory_assignments (item_id, event_id)
  where event_id is not null and returned_at is null;

/* ─── has_permission(): add edit_inventory ──────────────────────────── */

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
      'edit_inventory',
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
      'edit_inventory',
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
      'edit_inventory',
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

alter table public.inventory_items       enable row level security;
alter table public.inventory_assignments enable row level security;

-- inventory_items SELECT: any signed-in user. Teachers need to see what's
-- assigned to their class on the home bento + class detail panel.
drop policy if exists "inventory_items_select" on public.inventory_items;
create policy "inventory_items_select" on public.inventory_items
  for select using (auth.uid() is not null);

drop policy if exists "inventory_items_insert" on public.inventory_items;
create policy "inventory_items_insert" on public.inventory_items
  for insert with check (public.has_permission('edit_inventory'));

drop policy if exists "inventory_items_update" on public.inventory_items;
create policy "inventory_items_update" on public.inventory_items
  for update using (public.has_permission('edit_inventory'))
  with check  (public.has_permission('edit_inventory'));

drop policy if exists "inventory_items_delete" on public.inventory_items;
create policy "inventory_items_delete" on public.inventory_items
  for delete using (public.has_permission('edit_inventory'));

-- inventory_assignments SELECT: any signed-in user (schedule + class
-- detail + event editor all need to render assignments).
drop policy if exists "inventory_assignments_select" on public.inventory_assignments;
create policy "inventory_assignments_select" on public.inventory_assignments
  for select using (auth.uid() is not null);

drop policy if exists "inventory_assignments_insert" on public.inventory_assignments;
create policy "inventory_assignments_insert" on public.inventory_assignments
  for insert with check (public.has_permission('edit_inventory'));

drop policy if exists "inventory_assignments_update" on public.inventory_assignments;
create policy "inventory_assignments_update" on public.inventory_assignments
  for update using (public.has_permission('edit_inventory'))
  with check  (public.has_permission('edit_inventory'));

drop policy if exists "inventory_assignments_delete" on public.inventory_assignments;
create policy "inventory_assignments_delete" on public.inventory_assignments
  for delete using (public.has_permission('edit_inventory'));

/* ─── Storage bucket: inventory-photos (public read) ────────────────── */

-- Mirror the `infographics` pattern: public bucket, read open to all,
-- writes gated on edit_inventory.
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'inventory-photos') then
    insert into storage.buckets (id, name, public)
    values ('inventory-photos', 'inventory-photos', true);
  end if;
end$$;

drop policy if exists "inventory_photos_read"   on storage.objects;
create policy "inventory_photos_read" on storage.objects
  for select using (bucket_id = 'inventory-photos');

drop policy if exists "inventory_photos_insert" on storage.objects;
create policy "inventory_photos_insert" on storage.objects
  for insert with check (bucket_id = 'inventory-photos' and public.has_permission('edit_inventory'));

drop policy if exists "inventory_photos_update" on storage.objects;
create policy "inventory_photos_update" on storage.objects
  for update using (bucket_id = 'inventory-photos' and public.has_permission('edit_inventory'))
  with check  (bucket_id = 'inventory-photos' and public.has_permission('edit_inventory'));

drop policy if exists "inventory_photos_delete" on storage.objects;
create policy "inventory_photos_delete" on storage.objects
  for delete using (bucket_id = 'inventory-photos' and public.has_permission('edit_inventory'));

/* ─── Realtime publication ──────────────────────────────────────────── */

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_items'
  ) then
    execute 'alter publication supabase_realtime add table public.inventory_items';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_assignments'
  ) then
    execute 'alter publication supabase_realtime add table public.inventory_assignments';
  end if;
end$$;

commit;
