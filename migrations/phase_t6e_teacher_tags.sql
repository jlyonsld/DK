-- phase_t6e_teacher_tags.sql
--
-- Managed catalog of personnel tags + a many-to-many assignment to
-- teachers. Captures "what a teacher does or doesn't do" — e.g. Improv,
-- Stage combat, Lead teacher, Won't travel, No singing. Admins curate the
-- catalog (Manage tags modal) and assign tags per teacher in the personnel
-- modal. The Teachers tab then searches/filters by name OR tag.
--
-- Design mirrors phase_t6c_payment_methods.sql: a catalog table that is the
-- source of truth (no hardcoded enum), SELECT open to any authenticated user
-- so chips/search render everywhere, writes gated on has_permission(
-- 'edit_teachers') to match the existing teacher-edit story. The catalog is
-- portable/modular per the DK tooling convention — data lives in its own
-- tables, fully decoupled from the UI.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: every CREATE uses IF NOT EXISTS, each policy is dropped and
-- re-added, the seed is on (slug) conflict do nothing.

begin;

-- 1. teacher_tags catalog ------------------------------------

create table if not exists public.teacher_tags (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  label       text not null,
  -- optional chip color as a #rrggbb hex; null = default neutral chip.
  color       text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists teacher_tags_active_idx
  on public.teacher_tags (sort_order)
  where is_active;

create or replace function public.tg_teacher_tags_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists teacher_tags_touch on public.teacher_tags;
create trigger teacher_tags_touch
  before update on public.teacher_tags
  for each row execute function public.tg_teacher_tags_touch();

alter table public.teacher_tags enable row level security;

-- SELECT: any signed-in user (chips + search must render in every view).
drop policy if exists "tt_select" on public.teacher_tags;
create policy "tt_select"
  on public.teacher_tags
  for select
  to authenticated
  using (true);

-- Writes: anyone who can edit teachers (admin / super_admin via the
-- edit_teachers permission bundle).
drop policy if exists "tt_insert" on public.teacher_tags;
create policy "tt_insert"
  on public.teacher_tags
  for insert
  to authenticated
  with check (has_permission('edit_teachers'));

drop policy if exists "tt_update" on public.teacher_tags;
create policy "tt_update"
  on public.teacher_tags
  for update
  to authenticated
  using      (has_permission('edit_teachers'))
  with check (has_permission('edit_teachers'));

drop policy if exists "tt_delete" on public.teacher_tags;
create policy "tt_delete"
  on public.teacher_tags
  for delete
  to authenticated
  using (has_permission('edit_teachers'));

-- 2. teacher_tag_assignments join ----------------------------

create table if not exists public.teacher_tag_assignments (
  teacher_id  uuid not null references public.teachers(id)     on delete cascade,
  tag_id      uuid not null references public.teacher_tags(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (teacher_id, tag_id)
);

create index if not exists tta_tag_idx
  on public.teacher_tag_assignments (tag_id);
create index if not exists tta_teacher_idx
  on public.teacher_tag_assignments (teacher_id);

alter table public.teacher_tag_assignments enable row level security;

-- SELECT: open to any signed-in user — assignments are just tag links
-- (no PII) and drive the list chips + search for every role.
drop policy if exists "tta_select" on public.teacher_tag_assignments;
create policy "tta_select"
  on public.teacher_tag_assignments
  for select
  to authenticated
  using (true);

-- Assignments are insert/delete only (no update path).
drop policy if exists "tta_insert" on public.teacher_tag_assignments;
create policy "tta_insert"
  on public.teacher_tag_assignments
  for insert
  to authenticated
  with check (has_permission('edit_teachers'));

drop policy if exists "tta_delete" on public.teacher_tag_assignments;
create policy "tta_delete"
  on public.teacher_tag_assignments
  for delete
  to authenticated
  using (has_permission('edit_teachers'));

-- 3. Seed a few starter tags ---------------------------------
-- Removable/renamable through the UI. The "won't / can't" tags use a red
-- chip so they read as exclusions at a glance.

insert into public.teacher_tags (slug, label, color, sort_order)
values
  ('improv',          'Improv',           '#6366f1', 10),
  ('musical-theater', 'Musical theater',  '#ec4899', 20),
  ('stage-combat',    'Stage combat',     '#f59e0b', 30),
  ('lead-teacher',    'Lead teacher',     '#10b981', 40),
  ('assistant',       'Assistant',        '#0ea5e9', 50),
  ('camp-only',       'Camp only',        '#84cc16', 60),
  ('no-travel',       'Won''t travel',    '#ef4444', 70),
  ('no-singing',      'No singing',       '#ef4444', 80)
on conflict (slug) do nothing;

-- 4. Realtime ------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime' and schemaname='public'
       and tablename='teacher_tags'
  ) then
    alter publication supabase_realtime add table public.teacher_tags;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime' and schemaname='public'
       and tablename='teacher_tag_assignments'
  ) then
    alter publication supabase_realtime add table public.teacher_tag_assignments;
  end if;
end $$;

commit;
