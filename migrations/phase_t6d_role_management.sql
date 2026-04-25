-- ============================================================
-- Phase T6d: Role-management UI + profiles.teacher_id link +
--            returning-user invitation redemption
-- ============================================================
--
-- Until now, role assignment outside the install-flow auto-promote
-- (par-identity-proxy) and the first-sign-in invitation redemption
-- (handle_new_user trigger) required raw SQL by Jason. T6d closes
-- the loop with three pieces:
--
--   1. profiles.teacher_id — explicit FK linking a DK profile to a
--      teachers row. Until now the teacher bento + clock-in helpers
--      matched on auth-email ↔ teachers.email, which is fragile when
--      a teacher has multiple emails or when the auth identity is a
--      personal email that doesn't match the teachers row. The new
--      column is the source of truth; the email match stays as a
--      fallback for unlinked profiles.
--
--   2. set_profile_role / set_profile_permissions / link_profile_to_teacher
--      RPCs — security-definer entry points the new Users tab calls
--      so admins can change roles, edit per-user grant/revoke lists,
--      and link/unlink a profile to a teacher row WITHOUT raw SQL.
--      The role_audit trigger from T0 fires automatically on each
--      profiles UPDATE so every change is logged.
--
--   3. redeem_invitation_for(email, profile_id) RPC — handles the
--      "returning user" case that handle_new_user doesn't cover.
--      handle_new_user only runs on auth.users INSERT (first sign-in
--      ever). If a user has already signed into DK before the
--      invitation was sent (e.g. they had a viewer role first, then
--      were invited as a teacher), the trigger never re-fires.
--      The new RPC lets an admin (or the user themselves) redeem the
--      pending invitation against an existing profile.
--
-- New SELECT policy on profiles for admin_or_above so the Users tab
-- can list everyone. Self-read remains in place for non-admins.
--
-- No new permissions added: super_admin and admin already hold
-- 'manage_users' from the T0 bundles, and this migration uses
-- public.is_admin_or_above() at the RPC entry points (which matches
-- both super_admin and admin per T0's redefined is_admin()).
--
-- Idempotent: every CREATE uses IF NOT EXISTS, every CREATE OR
-- REPLACE re-runs cleanly, every policy DROPs first.

begin;

-- 1. profiles.teacher_id column ------------------------------

alter table public.profiles
  add column if not exists teacher_id uuid
    references public.teachers(id) on delete set null;

-- Unique partial index: one teacher row maps to at most one profile.
-- Two profiles pointing at the same teachers row would silently
-- break the teacher bento ("which profile owns this teacher's
-- shift card?"); the partial index allows multiple NULLs while
-- guarding the meaningful values.
create unique index if not exists profiles_teacher_id_unique
  on public.profiles (teacher_id)
  where teacher_id is not null;

-- 2. profiles SELECT policy widening for admins --------------
-- Pre-T6d, the only SELECT policy on profiles was self-read (the
-- single profile_self_select created in the initial schema, set up
-- via the Supabase dashboard before this repo carried migrations).
-- The Users tab needs admins to see every row, so we add a parallel
-- permissive policy. Multiple permissive policies are OR'd: admins
-- see all, non-admins still see only their own row.

drop policy if exists "profiles_admin_read" on public.profiles;
create policy "profiles_admin_read"
  on public.profiles
  for select
  to authenticated
  using (public.is_admin_or_above());

-- 3. set_profile_role RPC -----------------------------------
-- Admins call this from the Users tab. Guards:
--   • Caller must be admin_or_above.
--   • Only super_admin can grant or revoke the super_admin role
--     (admins can manage admin/manager/teacher/viewer/null only).
--   • Refuses to demote the LAST super_admin so a franchise can't
--     accidentally lock itself out.
--
-- Writes profiles.role + role_granted_by + role_granted_at; the
-- T0 profiles_role_audit trigger writes the role_audit row.

create or replace function public.set_profile_role(
  p_profile_id uuid,
  p_new_role   text,
  p_reason     text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old   public.profiles%rowtype;
  v_new   public.profiles%rowtype;
  v_count integer;
begin
  if not public.is_admin_or_above() then
    raise exception 'Not authorized to change roles';
  end if;

  if p_new_role is not null
     and p_new_role not in ('super_admin','admin','manager','teacher','viewer') then
    raise exception 'Invalid role: %', p_new_role;
  end if;

  select * into v_old from public.profiles where id = p_profile_id;
  if not found then
    raise exception 'Profile not found: %', p_profile_id;
  end if;

  -- Super_admin gating: only super_admin can grant or revoke super_admin.
  if (p_new_role = 'super_admin' or v_old.role = 'super_admin')
     and not public.is_super_admin() then
    raise exception 'Only super_admin can grant or revoke the super_admin role';
  end if;

  -- Lockout protection: refuse to demote the last super_admin.
  if v_old.role = 'super_admin' and p_new_role is distinct from 'super_admin' then
    select count(*) into v_count
      from public.profiles
     where role = 'super_admin' and id <> p_profile_id;
    if v_count = 0 then
      raise exception 'Cannot demote the last super_admin';
    end if;
  end if;

  update public.profiles
     set role            = p_new_role,
         role_granted_by = auth.uid(),
         role_granted_at = now()
   where id = p_profile_id
   returning * into v_new;

  -- The T0 trigger (profiles_role_audit) fires on UPDATE and writes
  -- the role_audit row automatically. Reason text isn't part of the
  -- trigger's row shape today; if we need it visible in the audit,
  -- a future migration can widen role_audit to carry it. For now
  -- the reason is logged below for ad-hoc inspection.
  if p_reason is not null and length(trim(p_reason)) > 0 then
    raise notice 'set_profile_role(%, %): %', p_profile_id, p_new_role, p_reason;
  end if;

  return v_new;
end;
$$;

grant execute on function public.set_profile_role(uuid, text, text) to authenticated;

-- 4. set_profile_permissions RPC ----------------------------
-- Admin-managed per-user grant/revoke lists. The lists are TEXT[]
-- and aren't validated against PERM_BUNDLES — has_permission() is
-- the runtime gate, so an admin granting a typo'd permission name
-- silently grants nothing rather than erroring. UI shows the canon
-- list of permission names; this RPC trusts what the UI sends.

create or replace function public.set_profile_permissions(
  p_profile_id uuid,
  p_granted    text[],
  p_revoked    text[]
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.profiles%rowtype;
  v_new public.profiles%rowtype;
begin
  if not public.is_admin_or_above() then
    raise exception 'Not authorized to change permissions';
  end if;

  select * into v_old from public.profiles where id = p_profile_id;
  if not found then
    raise exception 'Profile not found: %', p_profile_id;
  end if;

  -- Same super_admin protection as set_profile_role: only a
  -- super_admin can edit the permission lists on a super_admin row.
  if v_old.role = 'super_admin' and not public.is_super_admin() then
    raise exception 'Only super_admin can edit a super_admin profile';
  end if;

  update public.profiles
     set granted_permissions = coalesce(p_granted, '{}'),
         revoked_permissions = coalesce(p_revoked, '{}')
   where id = p_profile_id
   returning * into v_new;

  return v_new;
end;
$$;

grant execute on function public.set_profile_permissions(uuid, text[], text[]) to authenticated;

-- 5. link_profile_to_teacher RPC ----------------------------
-- Admin links/unlinks a profile to a teachers row. NULL = unlink.
-- The unique partial index on profiles.teacher_id enforces the
-- one-profile-per-teacher invariant; this RPC just gates the write.

create or replace function public.link_profile_to_teacher(
  p_profile_id uuid,
  p_teacher_id uuid
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new public.profiles%rowtype;
begin
  if not public.is_admin_or_above() then
    raise exception 'Not authorized to link teacher records';
  end if;

  if p_teacher_id is not null
     and not exists (select 1 from public.teachers where id = p_teacher_id) then
    raise exception 'Teacher not found: %', p_teacher_id;
  end if;

  update public.profiles
     set teacher_id = p_teacher_id
   where id = p_profile_id
   returning * into v_new;

  if not found then
    raise exception 'Profile not found: %', p_profile_id;
  end if;

  return v_new;
end;
$$;

grant execute on function public.link_profile_to_teacher(uuid, uuid) to authenticated;

-- 6. redeem_invitation_for RPC -------------------------------
-- handle_new_user only fires on auth.users INSERT (first-ever
-- sign-in). If a user already has a DK profile when an admin
-- creates the invitation (e.g. they signed in once with a viewer
-- role, then were later invited as a teacher), nothing redeems
-- the invitation against their existing profile.
--
-- This RPC closes the gap. Two callers:
--   • Admin from the Users tab: "Redeem pending invitation"
--     button on a profile row. Caller must be admin_or_above.
--   • The user themselves: pass their own profile_id to redeem
--     an invitation addressed to their auth email.
--
-- Behavior:
--   • Looks up the most-recent pending non-expired invitation
--     whose lower(email) matches the target profile's auth email.
--   • Promotes profiles.role to invitation.dk_role.
--   • If invitation.teacher_id is set, links profile.teacher_id.
--   • Marks the invitation accepted_at = now().
--   • Returns the (updated) invitation row.

create or replace function public.redeem_invitation_for(
  p_profile_id uuid
)
returns public.teacher_invitations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email      text;
  v_invitation public.teacher_invitations%rowtype;
  v_is_self    boolean;
begin
  if p_profile_id is null then
    raise exception 'profile_id is required';
  end if;

  -- Resolve the target profile's auth email.
  select au.email
    into v_email
    from public.profiles p
    join auth.users au on au.id = p.id
   where p.id = p_profile_id;

  if v_email is null then
    raise exception 'Profile not found or has no auth email: %', p_profile_id;
  end if;

  v_is_self := (p_profile_id = auth.uid());

  -- Authorization: caller is the target user, OR an admin_or_above.
  if not (v_is_self or public.is_admin_or_above()) then
    raise exception 'Not authorized to redeem invitations for this user';
  end if;

  -- Most-recent pending non-expired invitation for this email.
  select *
    into v_invitation
    from public.teacher_invitations
   where lower(email) = lower(v_email)
     and accepted_at is null
     and (expires_at is null or expires_at > now())
   order by sent_at desc
   limit 1;

  if not found then
    raise exception 'No pending invitation found for %', v_email;
  end if;

  -- Promote the profile.
  update public.profiles
     set role            = v_invitation.dk_role,
         role_granted_by = coalesce(v_invitation.invited_by, auth.uid()),
         role_granted_at = now(),
         teacher_id      = coalesce(teacher_id, v_invitation.teacher_id)
   where id = p_profile_id;

  -- Backfill the teacher's email if the invitation was teacher-attached
  -- and the teachers row has no email yet (mirrors handle_new_user).
  if v_invitation.teacher_id is not null then
    update public.teachers
       set email = coalesce(email, v_email)
     where id = v_invitation.teacher_id;
  end if;

  -- Mark the invitation accepted.
  update public.teacher_invitations
     set accepted_at = now()
   where id = v_invitation.id
   returning * into v_invitation;

  return v_invitation;
end;
$$;

grant execute on function public.redeem_invitation_for(uuid) to authenticated;

-- 7. handle_new_user: also link teacher_id on first sign-in --
-- Extends T2's handle_new_user. Same logic, but now writes
-- profiles.teacher_id from the invitation alongside the role.
-- Idempotent: re-runs cleanly if T2 has been applied.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation public.teacher_invitations%rowtype;
  v_email text;
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data->>'full_name', null)
  on conflict (id) do nothing;

  v_email := new.email;
  if v_email is null then
    return new;
  end if;

  select *
    into v_invitation
    from public.teacher_invitations
   where lower(email) = lower(v_email)
     and accepted_at is null
     and (expires_at is null or expires_at > now())
   order by sent_at desc
   limit 1;

  if found then
    update public.profiles
       set role            = v_invitation.dk_role,
           role_granted_at = now(),
           role_granted_by = v_invitation.invited_by,
           teacher_id      = coalesce(teacher_id, v_invitation.teacher_id)
     where id = new.id;

    if v_invitation.teacher_id is not null then
      update public.teachers
         set email = coalesce(email, v_email)
       where id = v_invitation.teacher_id;
    end if;

    update public.teacher_invitations
       set accepted_at = now()
     where id = v_invitation.id;
  end if;

  return new;
end;
$$;

-- 8. Realtime: profiles is already in supabase_realtime
-- publication (added in the initial schema) so the Users tab
-- updates live when another admin makes a change. Defensive
-- add-if-missing in case a fresh project skipped that step.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime'
       and schemaname='public'
       and tablename='profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

commit;
