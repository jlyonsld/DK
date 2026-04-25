-- phase_t8_schools.sql
--
-- Promotes the free-form `classes.location` text into a first-class
-- `schools` table with primary + daily contacts, and adds a
-- `class_cancellations` table so admins can cancel a single session
-- (distinct from a full-day closures row).
--
-- Migration strategy:
--   1. Create schools table.
--   2. Auto-create one schools row per distinct non-empty `classes.location`,
--      slug = slugified location.
--   3. Add `classes.school_id` and backfill from the matching schools.id.
--   4. KEEP `classes.location` populated — JR's nightly sync writes the
--      location string; we don't want to fight that. The app reads
--      school_id when present and falls back to location otherwise.
--   5. Create `class_cancellations` table for single-session cancellations.
--   6. Hook both tables into RLS + the realtime publication.
--
-- Permissions: writes to schools and class_cancellations are gated on the
-- existing `edit_classes` permission — no new permission name needed.
-- Anyone signed in can SELECT schools (the app needs the names + contacts
-- to render class cards). class_cancellations SELECT is unrestricted for
-- signed-in users so the schedule can mark cancelled sessions for everyone.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: each CREATE uses IF NOT EXISTS, each policy / function is
-- dropped and re-created.

begin;

/* ─── Tables ─────────────────────────────────────────────────────────── */

create table if not exists public.schools (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  slug                        text not null unique,
  address_line1               text,
  address_line2               text,
  city                        text,
  state                       text,
  postal_code                 text,
  primary_contact_name        text,
  primary_contact_role        text,   -- e.g. "Principal", "Activities Director"
  primary_contact_email       text,
  primary_contact_phone       text,
  daily_contact_name          text,
  daily_contact_role          text,   -- e.g. "Front Desk", "After-care Coordinator"
  daily_contact_email         text,
  daily_contact_phone         text,
  notes                       text,
  active                      boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists schools_active_idx on public.schools (active);

create or replace function public.touch_schools_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

drop trigger if exists trg_schools_touch on public.schools;
create trigger trg_schools_touch
  before update on public.schools
  for each row execute function public.touch_schools_updated_at();

-- Backfill: one schools row per distinct non-empty classes.location.
-- Uses a deterministic slug so re-running the migration is a no-op.
do $$
declare
  loc_row record;
  computed_slug text;
  collision int;
begin
  for loc_row in
    select distinct trim(location) as loc
      from public.classes
      where location is not null
        and trim(location) <> ''
  loop
    -- Slugify the location: lowercase, alphanumerics → hyphens, trim.
    computed_slug := regexp_replace(lower(loc_row.loc), '[^a-z0-9]+', '-', 'g');
    computed_slug := regexp_replace(computed_slug, '(^-|-$)', '', 'g');
    if computed_slug = '' then computed_slug := 'school'; end if;

    -- If a school with this slug already exists (idempotent re-run), skip.
    select count(*) into collision from public.schools where slug = computed_slug;
    if collision = 0 then
      insert into public.schools (name, slug)
        values (loc_row.loc, computed_slug);
    end if;
  end loop;
end$$;

-- Add the FK column. Note: NOT NULL would force the JR sync to know about
-- schools, which it doesn't yet — leaving nullable + falling back to
-- classes.location string in the UI keeps the sync compatible.
alter table public.classes
  add column if not exists school_id uuid references public.schools(id) on delete set null;

create index if not exists classes_school_id_idx on public.classes (school_id);

-- Backfill classes.school_id by matching against the schools we just created.
-- Match by case-insensitive trimmed name; only updates rows where school_id
-- is currently null so a re-run doesn't clobber manual overrides.
update public.classes c
   set school_id = s.id
  from public.schools s
  where c.school_id is null
    and c.location is not null
    and lower(trim(c.location)) = lower(trim(s.name));

-- Single-session class cancellations. Distinct from `closures` (which are
-- whole-day, all-classes-at-a-school events). Used when one specific class
-- on one specific day is cancelled — e.g. teacher out and no sub.
create table if not exists public.class_cancellations (
  id                       uuid primary key default gen_random_uuid(),
  class_id                 uuid not null references public.classes(id) on delete cascade,
  session_date             date not null,
  reason                   text,
  cancelled_at             timestamptz not null default now(),
  cancelled_by_user_id     uuid references auth.users(id) on delete set null,
  notified_at              timestamptz,   -- set when admin clicks "Notify daily contact"
  unique (class_id, session_date)
);

create index if not exists class_cancellations_class_idx on public.class_cancellations (class_id);
create index if not exists class_cancellations_date_idx  on public.class_cancellations (session_date);

/* ─── RLS ───────────────────────────────────────────────────────────── */

alter table public.schools enable row level security;
alter table public.class_cancellations enable row level security;

-- schools SELECT: any signed-in role. Class cards across the app need
-- school name + contacts to render correctly.
drop policy if exists "schools_select" on public.schools;
create policy "schools_select" on public.schools
  for select using (auth.uid() is not null);

drop policy if exists "schools_insert" on public.schools;
create policy "schools_insert" on public.schools
  for insert with check (has_permission('edit_classes'));

drop policy if exists "schools_update" on public.schools;
create policy "schools_update" on public.schools
  for update using (has_permission('edit_classes'))
  with check (has_permission('edit_classes'));

drop policy if exists "schools_delete" on public.schools;
create policy "schools_delete" on public.schools
  for delete using (has_permission('edit_classes'));

-- class_cancellations SELECT: any signed-in role. Schedule blocks need to
-- be marked cancelled for every viewer, not just admins.
drop policy if exists "class_cancellations_select" on public.class_cancellations;
create policy "class_cancellations_select" on public.class_cancellations
  for select using (auth.uid() is not null);

drop policy if exists "class_cancellations_insert" on public.class_cancellations;
create policy "class_cancellations_insert" on public.class_cancellations
  for insert with check (has_permission('edit_classes'));

drop policy if exists "class_cancellations_update" on public.class_cancellations;
create policy "class_cancellations_update" on public.class_cancellations
  for update using (has_permission('edit_classes'))
  with check (has_permission('edit_classes'));

drop policy if exists "class_cancellations_delete" on public.class_cancellations;
create policy "class_cancellations_delete" on public.class_cancellations
  for delete using (has_permission('edit_classes'));

/* ─── RPCs ──────────────────────────────────────────────────────────── */

-- mark_class_cancellation_notified: stamp `notified_at` after the admin
-- clicks "Notify daily contact" in the cancellation modal. Idempotent
-- (no-op if already stamped).
create or replace function public.mark_class_cancellation_notified(
  p_cancellation_id uuid
) returns public.class_cancellations
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.class_cancellations;
begin
  if not has_permission('edit_classes') then
    raise exception 'Permission denied: edit_classes';
  end if;
  if p_cancellation_id is null then
    raise exception 'cancellation_id is required';
  end if;

  update public.class_cancellations
     set notified_at = coalesce(notified_at, now())
   where id = p_cancellation_id
   returning * into v_row;

  if v_row.id is null then
    raise exception 'Class cancellation not found';
  end if;
  return v_row;
end$$;

/* ─── Realtime publication ──────────────────────────────────────────── */

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'schools'
  ) then
    execute 'alter publication supabase_realtime add table public.schools';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'class_cancellations'
  ) then
    execute 'alter publication supabase_realtime add table public.class_cancellations';
  end if;
end$$;

commit;
