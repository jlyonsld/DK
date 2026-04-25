-- ============================================================
-- Phase T5a: Curriculum library (admin-curated content)
-- ============================================================
--
-- T5 ships in three slices:
--   T5a (this file): library schema + admin/manager CRUD.
--                    No teacher visibility yet, no assignments,
--                    no viewer.
--   T5b (next):      curriculum_assignments table (per-teacher
--                    per-class), assignment UI, locked-card view
--                    on teacher home.
--   T5c (final):     curriculum_access_log + Edge Function
--                    `curriculum-fetch` (signed-URL gate +
--                    audit logging) + viewer with watermark.
--
-- Why three permissions, not one:
--   • edit_curriculum   — write the library. Admin / super_admin /
--                         manager (per Sharon's guidance — managers
--                         curate the library day-to-day).
--   • assign_curriculum — assign items to a teacher+class. Lands
--                         in T5b's RLS but the bundle is set here
--                         so PERM_BUNDLES doesn't churn twice.
--                         super_admin / admin / manager.
--   • view_own_curriculum — already in teacher bundle from T0;
--                         left untouched. T5b uses it to gate
--                         the teacher's library card.
--
-- Storage:
--   Private bucket `curriculum-assets`. No public read. Direct
--   client read is denied. T5c's `curriculum-fetch` Edge Function
--   uses the service-role key to mint short-TTL signed URLs *after*
--   verifying the caller has an active assignment with a passed
--   lead-window. The bucket is created here so T5a's upload UI
--   can write to it (admins-only via storage RLS).
--
-- Idempotency: every CREATE uses IF NOT EXISTS; every policy is
-- DROP + CREATE. has_permission() is wholesale-replaced.
--
-- Per CLAUDE.md §4.4: PERM_BUNDLES in app.js MUST mirror
-- has_permission() byte-for-byte. The companion app.js change
-- ships in the same commit as this migration.

begin;

-- 1. has_permission() ---------------------------------------
-- Wholesale replace. Preserves every T0/T1.5/T3/T4 permission and
-- adds T5a's two new ones (edit_curriculum, assign_curriculum).
-- view_own_curriculum already lived in the teacher bundle.

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
      'view_pay_rates','view_billing_status','view_parent_contact',
      'run_jackrabbit_sync','respond_to_leads',
      'reconcile_students',
      'request_sub','claim_sub_requests','manage_all_sub_requests'
    ]::text[]
    when 'manager' then array[
      'edit_templates','edit_categories','edit_infographics',
      'edit_classes','edit_teachers','edit_closures',
      'edit_curriculum','assign_curriculum',
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

-- 2. curriculum_items ---------------------------------------
-- The library. Five asset types so we have headroom:
--   pdf     — uploaded to curriculum-assets bucket (storage_path)
--   video   — uploaded to bucket OR external_url (Vimeo unlisted, etc.)
--   image   — uploaded to bucket
--   script  — inline rich text in script_content (no file)
--   link    — external_url only (e.g. corporate Google Doc)
--
-- dk_approved is a soft badge. The strategy doc keeps approval
-- workflow as a future Phase T5d concern; for now any admin can
-- toggle it. UI just renders a badge.

create table if not exists public.curriculum_items (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  description       text,
  asset_type        text not null check (asset_type in ('pdf','video','image','script','link')),
  storage_path      text,        -- bucket key when asset is uploaded
  external_url      text,        -- for type='link' or hosted video
  script_content    text,        -- rich text body for type='script'
  default_lead_days integer not null default 7 check (default_lead_days >= 0 and default_lead_days <= 60),
  dk_approved       boolean not null default false,
  is_archived       boolean not null default false,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists curriculum_items_asset_type_idx
  on public.curriculum_items (asset_type)
  where is_archived = false;

create index if not exists curriculum_items_created_at_idx
  on public.curriculum_items (created_at desc);

-- updated_at trigger
create or replace function public.tg_curriculum_items_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists curriculum_items_touch on public.curriculum_items;
create trigger curriculum_items_touch
  before update on public.curriculum_items
  for each row execute function public.tg_curriculum_items_touch();

alter table public.curriculum_items enable row level security;

-- SELECT: gated. T5a ships with admin/manager visibility ONLY
-- (anyone with edit_curriculum or assign_curriculum). Teachers
-- get their own SELECT path in T5b once curriculum_assignments
-- exists. Viewers stay blind.
drop policy if exists "curriculum_items_select_admin" on public.curriculum_items;
create policy "curriculum_items_select_admin"
  on public.curriculum_items
  for select
  to authenticated
  using (
    public.has_permission('edit_curriculum')
    or public.has_permission('assign_curriculum')
  );

drop policy if exists "curriculum_items_insert" on public.curriculum_items;
create policy "curriculum_items_insert"
  on public.curriculum_items
  for insert
  to authenticated
  with check (public.has_permission('edit_curriculum'));

drop policy if exists "curriculum_items_update" on public.curriculum_items;
create policy "curriculum_items_update"
  on public.curriculum_items
  for update
  to authenticated
  using      (public.has_permission('edit_curriculum'))
  with check (public.has_permission('edit_curriculum'));

drop policy if exists "curriculum_items_delete" on public.curriculum_items;
create policy "curriculum_items_delete"
  on public.curriculum_items
  for delete
  to authenticated
  using (public.has_permission('edit_curriculum'));

-- 3. Storage bucket -----------------------------------------
-- Private bucket. Storage RLS:
--   • INSERT (upload):  edit_curriculum
--   • UPDATE/DELETE:    edit_curriculum
--   • SELECT (read):    BLOCKED for everyone. Reads happen
--                       exclusively via T5c's curriculum-fetch
--                       Edge Function using service-role key.
--                       This is the corporate-sensitivity spine.

insert into storage.buckets (id, name, public)
  values ('curriculum-assets','curriculum-assets', false)
  on conflict (id) do nothing;

drop policy if exists "curriculum_assets_admin_insert" on storage.objects;
create policy "curriculum_assets_admin_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'curriculum-assets'
    and public.has_permission('edit_curriculum')
  );

drop policy if exists "curriculum_assets_admin_update" on storage.objects;
create policy "curriculum_assets_admin_update"
  on storage.objects
  for update
  to authenticated
  using      (bucket_id = 'curriculum-assets' and public.has_permission('edit_curriculum'))
  with check (bucket_id = 'curriculum-assets' and public.has_permission('edit_curriculum'));

drop policy if exists "curriculum_assets_admin_delete" on storage.objects;
create policy "curriculum_assets_admin_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'curriculum-assets'
    and public.has_permission('edit_curriculum')
  );

-- Intentionally NO select policy on curriculum-assets bucket.
-- (Other buckets like infographics have their own select
-- policies; this one is service-role-only by design.)

-- 4. Realtime -----------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'curriculum_items'
  ) then
    alter publication supabase_realtime add table public.curriculum_items;
  end if;
end $$;

commit;
