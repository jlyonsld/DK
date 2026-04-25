-- ============================================================
-- Phase T5b: Curriculum assignments + teacher visibility
-- ============================================================
--
-- Slice 2 of T5 (see CLAUDE.md §4.22).
--
--   curriculum_assignments — keys (curriculum_item_id, class_id,
--                            teacher_id). lead_days_override is
--                            optional; null = inherit from
--                            curriculum_items.default_lead_days.
--                            teacher_notes is the teacher's
--                            personal scratchpad on this item-in-
--                            this-class — written via the
--                            set_curriculum_assignment_notes RPC,
--                            never via raw UPDATE.
--
-- Teacher visibility on curriculum_items widens here. T5a only
-- granted SELECT to edit_curriculum / assign_curriculum holders;
-- T5b adds a teacher-path policy: a teacher can SELECT a
-- curriculum_items row IFF they have at least one assignment for
-- that item AND the item is not archived.
--
-- Lead-window enforcement still lives client-side + (in T5c) in
-- the curriculum-fetch Edge Function. RLS only verifies "an
-- assignment exists" — encoding rolling per-session date math in
-- SQL would be brittle and slow against the days/times string
-- columns. See CLAUDE.md §4.22.
--
-- No new permissions. assign_curriculum and view_own_curriculum
-- already exist from T5a and T0 respectively. has_permission()
-- is NOT replaced.
--
-- Per CLAUDE.md §5: never reference auth.users from RLS policies.
-- All teacher-self checks use auth.jwt() ->> 'email' and join
-- through public.teachers.

begin;

-- 1. curriculum_assignments ---------------------------------

create table if not exists public.curriculum_assignments (
  id                       uuid primary key default gen_random_uuid(),
  curriculum_item_id       uuid not null references public.curriculum_items(id) on delete cascade,
  class_id                 uuid not null references public.classes(id)          on delete cascade,
  teacher_id               uuid not null references public.teachers(id)         on delete cascade,
  lead_days_override       integer check (lead_days_override is null or (lead_days_override >= 0 and lead_days_override <= 60)),
  notes                    text,                          -- admin/curator note (visible to teacher too)
  teacher_notes            text,                          -- teacher's private scratchpad
  teacher_notes_updated_at timestamptz,
  assigned_by              uuid references public.profiles(id) on delete set null,
  assigned_at              timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (curriculum_item_id, class_id, teacher_id)
);

create index if not exists curriculum_assignments_item_idx
  on public.curriculum_assignments (curriculum_item_id);
create index if not exists curriculum_assignments_class_idx
  on public.curriculum_assignments (class_id);
create index if not exists curriculum_assignments_teacher_idx
  on public.curriculum_assignments (teacher_id);

create or replace function public.tg_curriculum_assignments_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists curriculum_assignments_touch on public.curriculum_assignments;
create trigger curriculum_assignments_touch
  before update on public.curriculum_assignments
  for each row execute function public.tg_curriculum_assignments_touch();

alter table public.curriculum_assignments enable row level security;

-- SELECT — two paths (permissive policies are OR'd):
--   • admin/manager: anyone with assign_curriculum or edit_curriculum.
--   • teacher: rows whose teacher_id matches their teachers.email row.
drop policy if exists "curriculum_assignments_select_admin" on public.curriculum_assignments;
create policy "curriculum_assignments_select_admin"
  on public.curriculum_assignments
  for select
  to authenticated
  using (
    public.has_permission('assign_curriculum')
    or public.has_permission('edit_curriculum')
  );

drop policy if exists "curriculum_assignments_select_teacher" on public.curriculum_assignments;
create policy "curriculum_assignments_select_teacher"
  on public.curriculum_assignments
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.teachers t
       where t.id = curriculum_assignments.teacher_id
         and lower(t.email) = lower(auth.jwt() ->> 'email')
    )
  );

-- INSERT / UPDATE / DELETE — assign_curriculum only.
-- Teacher-side writes to teacher_notes go through the
-- set_curriculum_assignment_notes RPC (security definer) below,
-- which bypasses these policies after verifying identity.
drop policy if exists "curriculum_assignments_insert" on public.curriculum_assignments;
create policy "curriculum_assignments_insert"
  on public.curriculum_assignments
  for insert
  to authenticated
  with check (public.has_permission('assign_curriculum'));

drop policy if exists "curriculum_assignments_update" on public.curriculum_assignments;
create policy "curriculum_assignments_update"
  on public.curriculum_assignments
  for update
  to authenticated
  using      (public.has_permission('assign_curriculum'))
  with check (public.has_permission('assign_curriculum'));

drop policy if exists "curriculum_assignments_delete" on public.curriculum_assignments;
create policy "curriculum_assignments_delete"
  on public.curriculum_assignments
  for delete
  to authenticated
  using (public.has_permission('assign_curriculum'));

-- 2. Widen curriculum_items SELECT --------------------------
-- T5a's policy stays. We add a second permissive policy so a
-- teacher can SELECT exactly the items they're assigned to.

drop policy if exists "curriculum_items_select_teacher" on public.curriculum_items;
create policy "curriculum_items_select_teacher"
  on public.curriculum_items
  for select
  to authenticated
  using (
    is_archived = false
    and exists (
      select 1
        from public.curriculum_assignments ca
        join public.teachers t on t.id = ca.teacher_id
       where ca.curriculum_item_id = curriculum_items.id
         and lower(t.email) = lower(auth.jwt() ->> 'email')
    )
  );

-- 3. Teacher-notes RPC --------------------------------------
-- Teachers can only mutate `teacher_notes` on their own
-- assignment row. We use security definer so the function bypasses
-- the assign_curriculum-gated UPDATE policy, then verify identity
-- inside. Returns the updated row's teacher_notes_updated_at so
-- the UI can show a "saved at HH:MM" hint without a re-fetch.

create or replace function public.set_curriculum_assignment_notes(
  p_assignment_id uuid,
  p_notes         text
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignment_teacher_id uuid;
  v_caller_teacher_id     uuid;
  v_caller_email          text;
  v_now                   timestamptz;
begin
  v_caller_email := lower(auth.jwt() ->> 'email');
  if v_caller_email is null or v_caller_email = '' then
    raise exception 'Not authenticated';
  end if;

  select teacher_id
    into v_assignment_teacher_id
    from public.curriculum_assignments
   where id = p_assignment_id;

  if v_assignment_teacher_id is null then
    raise exception 'Assignment not found';
  end if;

  select id
    into v_caller_teacher_id
    from public.teachers
   where lower(email) = v_caller_email
   limit 1;

  if v_caller_teacher_id is null then
    raise exception 'No teacher record matches your email';
  end if;

  if v_caller_teacher_id <> v_assignment_teacher_id then
    raise exception 'You can only edit your own assignment notes';
  end if;

  v_now := now();
  update public.curriculum_assignments
     set teacher_notes            = p_notes,
         teacher_notes_updated_at = v_now
   where id = p_assignment_id;

  return v_now;
end;
$$;

revoke all on function public.set_curriculum_assignment_notes(uuid, text) from public;
grant  execute on function public.set_curriculum_assignment_notes(uuid, text) to authenticated;

-- 4. Realtime -----------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'curriculum_assignments'
  ) then
    alter publication supabase_realtime add table public.curriculum_assignments;
  end if;
end $$;

commit;
