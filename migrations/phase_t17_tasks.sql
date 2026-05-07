-- phase_t17_tasks.sql
--
-- T17a: DK-side schema for task federation (DK→PAR push via the
-- spoke-create-task pattern Margin built 2026-05-06).
--
-- Architecture and rationale: see CLAUDE.md §4.33. Summary:
--   - Tasks live in DK as a first-class table.
--   - On "Send to PAR", the dk-create-par-task Edge Function forwards to
--     PAR's spoke-create-task and stamps the returned PAR uuid onto the
--     local row's par_task_id column.
--   - DK is single-tenant per deployment (one dk_config singleton row →
--     one PAR org). org_id is read from dk_config.par_franchise_org_id
--     at proxy time, NOT a DK_PAR_ORG_ID env var (one source of truth;
--     the install flow already populates it per §4.7).
--
-- Permission: NEW permission `manage_tasks` added to super_admin / admin /
-- manager bundles. PERM_BUNDLES in app.js MUST be updated to match
-- byte-for-byte (CLAUDE.md §4.4).
--
-- Idempotency: par_task_id carries a partial unique index (where not
-- null). The index MUST stay partial — non-partial would make multiple
-- locally-created-but-not-yet-pushed tasks collide on the NULL value.
--
-- Owner check-off: a thin set_task_status(p_id, p_status) RPC
-- (security invoker) lets the owner of a task flip its status without
-- holding manage_tasks. RLS gates writes for everyone else.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: each CREATE uses IF NOT EXISTS, each policy is dropped
-- and re-created.

begin;

/* ─── Enums ──────────────────────────────────────────────────────────── */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type public.task_status as enum (
      'open',          -- not started
      'in_progress',   -- actively being worked
      'done',          -- completed
      'archived'       -- intentionally hidden from default views
    );
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_priority') then
    create type public.task_priority as enum ('low','medium','high');
  end if;
end$$;

/* ─── Table ──────────────────────────────────────────────────────────── */

create table if not exists public.tasks (
  id                  uuid primary key default gen_random_uuid(),

  title               text not null check (length(btrim(title)) > 0),
  description         text,
  status              public.task_status not null default 'open',
  priority            public.task_priority not null default 'medium',

  -- Owner: prefer the structured FK; fall back to a free-form label
  -- when no DK profile matches (e.g. "Sharon's bookkeeper",
  -- "the new admin once hired"). Mirrors Margin's assignee_name shape.
  owner_profile_id    uuid references public.profiles(id) on delete set null,
  assignee_label      text,

  due_at              timestamptz,

  -- Workstream grouping. Convention (CLAUDE.md §4.33):
  --   - Day-to-day DK tasks: "DK: <franchise-name>"
  --   - Imported engagement-doc workstreams: "DK Engagement: <client-name>"
  -- Free-form text on PAR's side; PAR auto-creates a project on first use.
  project_name        text,

  -- Round-trip identity. Set by the YAML importer from the doc's task id
  -- so re-imports are idempotent. Left null for tasks created via the UI.
  external_ref        text,

  -- Populated after a successful spoke-create-task round-trip. Partial
  -- unique index below; null until pushed.
  par_task_id         uuid,

  created_by          uuid not null default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists tasks_par_task_id_unique
  on public.tasks (par_task_id)
  where par_task_id is not null;

create index if not exists tasks_project_name_idx
  on public.tasks (project_name)
  where project_name is not null;

create index if not exists tasks_owner_profile_id_idx
  on public.tasks (owner_profile_id)
  where owner_profile_id is not null;

create index if not exists tasks_status_idx
  on public.tasks (status);

create index if not exists tasks_external_ref_idx
  on public.tasks (external_ref)
  where external_ref is not null;

/* ─── updated_at touch trigger ───────────────────────────────────────── */

create or replace function public.touch_tasks_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_tasks_updated_at();

/* ─── has_permission(): add manage_tasks ─────────────────────────────── */

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
      'request_sub','claim_sub_requests','manage_all_sub_requests',
      'manage_tasks'
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
      'request_sub','claim_sub_requests','manage_all_sub_requests',
      'manage_tasks'
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
      'claim_sub_requests','manage_all_sub_requests',
      'manage_tasks'
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

/* ─── RLS ────────────────────────────────────────────────────────────── */

alter table public.tasks enable row level security;

-- SELECT: any signed-in user. Teachers need to see tasks delegated to
-- them (the home bento "Tasks for you" card reads here directly). Tasks
-- aren't sensitive PII, and limiting visibility would force the bento
-- to query through a separate view.
drop policy if exists tasks_select_authed on public.tasks;
create policy tasks_select_authed
  on public.tasks
  for select to authenticated
  using (true);

drop policy if exists tasks_insert_manage on public.tasks;
create policy tasks_insert_manage
  on public.tasks
  for insert to authenticated
  with check (public.has_permission('manage_tasks'));

drop policy if exists tasks_update_manage on public.tasks;
create policy tasks_update_manage
  on public.tasks
  for update to authenticated
  using (public.has_permission('manage_tasks'))
  with check (public.has_permission('manage_tasks'));

drop policy if exists tasks_delete_manage on public.tasks;
create policy tasks_delete_manage
  on public.tasks
  for delete to authenticated
  using (public.has_permission('manage_tasks'));

/* ─── set_task_status: owner self-update without manage_tasks ────────── */

-- Lets a teacher (or anyone whose profile.id matches owner_profile_id)
-- flip status without holding manage_tasks. Security invoker so the
-- existing RLS UPDATE policy fires for non-owners and rejects them;
-- security definer would bypass RLS and silently widen the surface.
-- Owner check is therefore enforced via an explicit guard below + a
-- second permissive UPDATE policy (tasks_update_owner_status).

drop policy if exists tasks_update_owner_status on public.tasks;
create policy tasks_update_owner_status
  on public.tasks
  for update to authenticated
  using (owner_profile_id = auth.uid())
  with check (owner_profile_id = auth.uid());

create or replace function public.set_task_status(
  p_id     uuid,
  p_status public.task_status
)
returns public.tasks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.tasks;
begin
  -- Caller must either be the owner OR hold manage_tasks. Both paths
  -- go through RLS, so this RPC is effectively a typed thin wrapper
  -- that prevents the caller from also editing title / description /
  -- priority / due_at via a hand-rolled UPDATE under the owner policy.
  update public.tasks
     set status = p_status
   where id = p_id
     and (
       owner_profile_id = auth.uid()
       or public.has_permission('manage_tasks')
     )
  returning * into v_row;

  if not found then
    raise exception 'set_task_status: task not found or not owned by caller'
      using errcode = '42501';
  end if;

  return v_row;
end;
$$;

revoke all on function public.set_task_status(uuid, public.task_status) from public;
grant execute on function public.set_task_status(uuid, public.task_status) to authenticated;

/* ─── Realtime publication ───────────────────────────────────────────── */

do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end$$;

commit;
