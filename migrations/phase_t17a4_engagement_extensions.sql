-- phase_t17a4_engagement_extensions.sql
--
-- T17a-4: Lift decisions + weight_ledger_entries from "silently
-- ignored by the YAML importer" to first-class DK surfaces. The
-- engagement-doc YAML format documented in CLAUDE.md §4.33 has three
-- structural sections beyond `workstreams[].tasks[]` — decisions,
-- weight_ledger, patterns — and T17a only landed tasks. T17a-4 lands
-- decisions + weight_ledger; patterns stay informal (they live in
-- prose / repo docs, not as DB rows).
--
-- Permission: REUSES the existing `manage_tasks` permission (T17a).
-- No new permission name. SELECT is open to any signed-in user
-- (same model as `tasks`); writes gated on manage_tasks.
--
-- Both tables added to supabase_realtime so the Tasks tab + "Off your
-- plate" Reports entry update live within the 300ms debounce when an
-- importer run lands new rows from a peer admin.
--
-- No federation: these tables are explicitly local-only per §4.33
-- ("decisions don't push to PAR ... weight_ledger entries are local-only
-- too. PAR has no canonical 'weight ledger' surface yet.").
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent — every CREATE uses IF NOT EXISTS, every policy is dropped
-- and recreated.

begin;

/* ─── decisions ──────────────────────────────────────────────────────── */

create table if not exists public.decisions (
  id              uuid primary key default gen_random_uuid(),

  -- Same convention as tasks.project_name. The YAML importer will
  -- write "DK Engagement: <slug>" so decisions group with their
  -- workstream tasks.
  project_name    text,

  title           text not null check (length(btrim(title)) > 0),
  description     text,

  -- "not before" — earliest the decision can be made. The YAML uses
  -- a date; we store as date so date pickers + the import flow stay
  -- direct.
  not_before      date,

  -- Inputs: workstream / task external_refs that must precede this.
  -- Free-form text array; we don't enforce FKs because workstream ids
  -- don't have their own table (they only exist in YAML), and task
  -- external_refs may not exist locally yet (e.g. on first import).
  inputs          text[] not null default '{}',

  -- Status lifecycle: pending → decided | cancelled.
  status          text not null default 'pending'
                    check (status in ('pending','decided','cancelled')),
  decided_at      timestamptz,
  decided_by      uuid references public.profiles(id) on delete set null,
  decided_outcome text,

  -- Round-trip identity for idempotent re-imports. Mirror the tasks
  -- pattern (CLAUDE.md §4.33).
  external_ref    text,

  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists decisions_project_name_idx
  on public.decisions (project_name)
  where project_name is not null;

create index if not exists decisions_status_idx
  on public.decisions (status);

create index if not exists decisions_external_ref_idx
  on public.decisions (external_ref)
  where external_ref is not null;

create or replace function public.touch_decisions_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists decisions_touch_updated_at on public.decisions;
create trigger decisions_touch_updated_at
  before update on public.decisions
  for each row execute function public.touch_decisions_updated_at();

alter table public.decisions enable row level security;

drop policy if exists decisions_select_authed on public.decisions;
create policy decisions_select_authed
  on public.decisions
  for select to authenticated
  using (true);

drop policy if exists decisions_insert_manage on public.decisions;
create policy decisions_insert_manage
  on public.decisions
  for insert to authenticated
  with check (public.has_permission('manage_tasks'));

drop policy if exists decisions_update_manage on public.decisions;
create policy decisions_update_manage
  on public.decisions
  for update to authenticated
  using (public.has_permission('manage_tasks'))
  with check (public.has_permission('manage_tasks'));

drop policy if exists decisions_delete_manage on public.decisions;
create policy decisions_delete_manage
  on public.decisions
  for delete to authenticated
  using (public.has_permission('manage_tasks'));

/* ─── weight_ledger_entries ──────────────────────────────────────────── */

create table if not exists public.weight_ledger_entries (
  id             uuid primary key default gen_random_uuid(),

  project_name   text,

  -- The day the work came off the plate. The YAML uses a `date` — we
  -- store as date for consistency. The "Off your plate" Reports entry
  -- merges these with done-tasks (sorted by either dated_at or
  -- updated_at) into one chronological surface.
  dated_at       date not null default current_date,

  item           text not null check (length(btrim(item)) > 0),
  moved_to       text not null check (length(btrim(moved_to)) > 0),
  notes          text,

  -- Optional FK back to a task whose closure produced this entry. NULL
  -- for standalone entries (e.g. "Sharon decided to stop chasing royalty
  -- bookkeeping personally" — no specific task closed, the weight
  -- shifted via decision).
  source_task_id uuid references public.tasks(id) on delete set null,

  external_ref   text,
  created_by     uuid not null default auth.uid(),
  created_at     timestamptz not null default now()
);

create index if not exists weight_ledger_entries_dated_at_idx
  on public.weight_ledger_entries (dated_at desc);

create index if not exists weight_ledger_entries_project_name_idx
  on public.weight_ledger_entries (project_name)
  where project_name is not null;

create index if not exists weight_ledger_entries_external_ref_idx
  on public.weight_ledger_entries (external_ref)
  where external_ref is not null;

alter table public.weight_ledger_entries enable row level security;

drop policy if exists weight_ledger_select_authed on public.weight_ledger_entries;
create policy weight_ledger_select_authed
  on public.weight_ledger_entries
  for select to authenticated
  using (true);

drop policy if exists weight_ledger_insert_manage on public.weight_ledger_entries;
create policy weight_ledger_insert_manage
  on public.weight_ledger_entries
  for insert to authenticated
  with check (public.has_permission('manage_tasks'));

drop policy if exists weight_ledger_update_manage on public.weight_ledger_entries;
create policy weight_ledger_update_manage
  on public.weight_ledger_entries
  for update to authenticated
  using (public.has_permission('manage_tasks'))
  with check (public.has_permission('manage_tasks'));

drop policy if exists weight_ledger_delete_manage on public.weight_ledger_entries;
create policy weight_ledger_delete_manage
  on public.weight_ledger_entries
  for delete to authenticated
  using (public.has_permission('manage_tasks'));

/* ─── Realtime publication ───────────────────────────────────────────── */

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'decisions'
  ) then
    alter publication supabase_realtime add table public.decisions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'weight_ledger_entries'
  ) then
    alter publication supabase_realtime add table public.weight_ledger_entries;
  end if;
end$$;

commit;
