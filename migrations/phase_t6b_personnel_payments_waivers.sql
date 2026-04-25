-- ============================================================
-- Phase T6b: Personnel — payment details, documents, waivers.
-- ============================================================
--
-- Builds on phase_t6_teacher_personnel.sql (T6a), which added
-- basic personnel columns to `teachers`. This phase adds the
-- sensitive sub-records that don't belong on the main teachers
-- row, plus the document storage and the e-signed waiver flow.
--
-- New tables / buckets:
--   • teacher_payment_details          super_admin-only PII table
--                                        (routing/account, handle)
--   • liability_waivers                versioned waiver text
--   • liability_waiver_signatures      append-only signature audit
--   • teacher_documents                tax forms, certs (metadata)
--   • storage bucket `teacher-documents`  private, no public SELECT
--
-- New permissions (added to has_permission() bundles):
--   • manage_teacher_payments          super_admin + admin.
--                                        Gates teacher_payment_details
--                                        (bank/routing/account, payment
--                                        handles for digital wallets).
--   • manage_teacher_compliance        super_admin + admin.
--                                        Gates documents (tax/certs)
--                                        + waiver editing/signing on
--                                        a teacher's behalf.
--
-- Why two new permissions instead of reusing edit_teachers:
--   `edit_teachers` is granted to manager (per T1.5). Managers are
--   franchise mid-tier staff — they should NOT see SSNs on W-9s or
--   bank account numbers. Splitting the permission lets manager
--   keep editing classroom-relevant teacher fields while gating
--   PII to admin / super_admin. (See CLAUDE.md §4.5 — same pattern
--   as edit_classes / edit_curriculum split.)
--
-- Why two separate permissions for payments vs. compliance:
--   Both currently sit at admin+super_admin, but splitting the
--   permission name lets the franchise owner later revoke payments
--   from a specific admin (e.g. a non-bookkeeper ops admin) via
--   profiles.revoked_permissions without losing their compliance
--   access. Same for the inverse direction.
--
-- Storage:
--   teacher-documents bucket mirrors curriculum-assets (T5a §4.22):
--   private, no SELECT policy on storage.objects for the bucket.
--   Reads happen via signed URLs minted from the app using the
--   user's session — but ONLY because we DO add a SELECT policy
--   gated to is_admin(). Unlike curriculum-assets, there's no
--   per-row authorization story (admins can see everything; no
--   need for an Edge Function intermediary). If we ever want to
--   show teachers their own docs, that's a future tightening.
--
-- Waiver signing (the "lightweight (a)" path):
--   • liability_waivers stores versioned waiver text with one
--     active row at a time (partial unique index on is_active).
--   • The record_waiver_signature() RPC is the only insert path
--     for liability_waiver_signatures — it gates either on
--     (caller is the teacher being signed for, by email match)
--     OR (caller has manage_teacher_compliance, recording in
--     person). It also updates the boolean snapshot on
--     teachers (liability_waiver_signed/date) so existing UI
--     code that renders that flag keeps working.
--
-- Idempotent: every CREATE uses IF NOT EXISTS, every policy is
-- DROP+CREATE, has_permission() is wholesale-replaced (per the
-- T5a/b/c convention), the seed waiver is upserted by version.
--
-- Per CLAUDE.md §4.4: PERM_BUNDLES in app.js MUST mirror
-- has_permission() byte-for-byte. The companion app.js change
-- ships in the same commit as this migration.

begin;

-- 1. has_permission() ----------------------------------------
-- Wholesale replace. Preserves every prior permission and adds
-- T6b's two new ones (manage_teacher_payments,
-- manage_teacher_compliance). Source of truth for PERM_BUNDLES.

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

-- 2. teacher_payment_details ---------------------------------
-- One row per teacher. Owner-only PII. Routing/account stored
-- as plaintext behind strict RLS (Supabase encrypts at rest at
-- the storage layer). A future hardening pass could move these
-- to pgsodium-encrypted columns; the table shape would not
-- change.

create table if not exists public.teacher_payment_details (
  teacher_id          uuid primary key references public.teachers(id) on delete cascade,
  bank_name           text,
  account_type        text check (account_type is null or account_type in ('checking','savings')),
  routing_number      text,
  account_number      text,
  -- For digital wallets (PayPal/Venmo/Zelle): handle is the email or phone.
  payment_handle      text,
  -- Free-form notes the bookkeeper might want (e.g. "use Zelle until Oct").
  notes               text,
  updated_by          uuid references public.profiles(id) on delete set null,
  updated_at          timestamptz not null default now()
);

create or replace function public.tg_teacher_payment_details_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists teacher_payment_details_touch on public.teacher_payment_details;
create trigger teacher_payment_details_touch
  before insert or update on public.teacher_payment_details
  for each row execute function public.tg_teacher_payment_details_touch();

alter table public.teacher_payment_details enable row level security;

drop policy if exists "tpd_select" on public.teacher_payment_details;
create policy "tpd_select"
  on public.teacher_payment_details
  for select
  to authenticated
  using (public.has_permission('manage_teacher_payments'));

drop policy if exists "tpd_insert" on public.teacher_payment_details;
create policy "tpd_insert"
  on public.teacher_payment_details
  for insert
  to authenticated
  with check (public.has_permission('manage_teacher_payments'));

drop policy if exists "tpd_update" on public.teacher_payment_details;
create policy "tpd_update"
  on public.teacher_payment_details
  for update
  to authenticated
  using      (public.has_permission('manage_teacher_payments'))
  with check (public.has_permission('manage_teacher_payments'));

drop policy if exists "tpd_delete" on public.teacher_payment_details;
create policy "tpd_delete"
  on public.teacher_payment_details
  for delete
  to authenticated
  using (public.has_permission('manage_teacher_payments'));

-- 3. liability_waivers ---------------------------------------
-- Versioned waiver text. Exactly one row may have is_active=true
-- at a time, enforced by a partial unique index. Archive an old
-- version by flipping is_active to false before activating a
-- new one (or the activation insert fails the unique). The
-- signing RPC reads the current active row.

create table if not exists public.liability_waivers (
  id          uuid primary key default gen_random_uuid(),
  version     integer not null unique,
  title       text not null,
  body_html   text not null,
  is_active   boolean not null default false,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create unique index if not exists liability_waivers_one_active
  on public.liability_waivers ((true))
  where is_active;

alter table public.liability_waivers enable row level security;

-- Anyone signed in can read waivers (teachers need to see the
-- text to sign it). Only admin/super_admin can write.
drop policy if exists "lw_select" on public.liability_waivers;
create policy "lw_select"
  on public.liability_waivers
  for select
  to authenticated
  using (true);

drop policy if exists "lw_insert" on public.liability_waivers;
create policy "lw_insert"
  on public.liability_waivers
  for insert
  to authenticated
  with check (public.has_permission('manage_teacher_compliance'));

drop policy if exists "lw_update" on public.liability_waivers;
create policy "lw_update"
  on public.liability_waivers
  for update
  to authenticated
  using      (public.has_permission('manage_teacher_compliance'))
  with check (public.has_permission('manage_teacher_compliance'));

drop policy if exists "lw_delete" on public.liability_waivers;
create policy "lw_delete"
  on public.liability_waivers
  for delete
  to authenticated
  using (public.has_permission('manage_teacher_compliance'));

-- 4. liability_waiver_signatures -----------------------------
-- Append-only audit. INSERT only happens via the
-- record_waiver_signature() RPC, which security-definer-checks
-- the caller. No UPDATE / DELETE policies (audit integrity).

create table if not exists public.liability_waiver_signatures (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references public.teachers(id) on delete cascade,
  waiver_id   uuid not null references public.liability_waivers(id) on delete restrict,
  typed_name  text not null,
  signed_at   timestamptz not null default now(),
  signer_ip   inet,
  user_agent  text,
  signed_by_self    boolean not null default false,
  recorded_by_user  uuid references public.profiles(id) on delete set null
);

create index if not exists lws_teacher_idx
  on public.liability_waiver_signatures (teacher_id, signed_at desc);

create index if not exists lws_waiver_idx
  on public.liability_waiver_signatures (waiver_id);

alter table public.liability_waiver_signatures enable row level security;

-- SELECT: admin/super_admin all; teacher own (matched by email).
drop policy if exists "lws_select_admin" on public.liability_waiver_signatures;
create policy "lws_select_admin"
  on public.liability_waiver_signatures
  for select
  to authenticated
  using (public.has_permission('manage_teacher_compliance'));

drop policy if exists "lws_select_self" on public.liability_waiver_signatures;
create policy "lws_select_self"
  on public.liability_waiver_signatures
  for select
  to authenticated
  using (
    teacher_id in (
      select id from public.teachers
       where lower(email) = lower(auth.jwt() ->> 'email')
    )
  );

-- No INSERT / UPDATE / DELETE policies. The RPC is the only writer.

-- 5. record_waiver_signature() RPC ---------------------------
-- The only path that inserts a signature row. Verifies the
-- caller is either:
--   (a) the teacher whose waiver this is (email match), OR
--   (b) holds manage_teacher_compliance (admin/super_admin
--       recording on the teacher's behalf, e.g. signed in
--       person at onboarding).
-- Side-effect: updates teachers.liability_waiver_signed +
-- liability_waiver_date snapshot so the existing personnel
-- modal flag keeps reading correctly.

create or replace function public.record_waiver_signature(
  p_teacher_id uuid,
  p_waiver_id  uuid,
  p_typed_name text,
  p_signer_ip  inet default null,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_email text;
  v_teacher_email text;
  v_self boolean;
  v_signature_id uuid;
begin
  if p_typed_name is null or btrim(p_typed_name) = '' then
    raise exception 'typed_name is required';
  end if;

  select lower(email) into v_teacher_email
    from public.teachers
   where id = p_teacher_id;

  if v_teacher_email is null then
    raise exception 'teacher not found';
  end if;

  v_caller_email := lower(auth.jwt() ->> 'email');
  v_self := (v_caller_email is not null and v_caller_email = v_teacher_email);

  if not (v_self or public.has_permission('manage_teacher_compliance')) then
    raise exception 'not authorized to sign on behalf of this teacher';
  end if;

  insert into public.liability_waiver_signatures (
    teacher_id, waiver_id, typed_name, signer_ip, user_agent,
    signed_by_self, recorded_by_user
  ) values (
    p_teacher_id, p_waiver_id, btrim(p_typed_name), p_signer_ip, p_user_agent,
    v_self, auth.uid()
  )
  returning id into v_signature_id;

  -- Snapshot onto the teachers row for back-compat with the
  -- existing personnel-modal flag.
  update public.teachers
     set liability_waiver_signed = true,
         liability_waiver_date   = current_date
   where id = p_teacher_id;

  return v_signature_id;
end;
$$;

revoke all on function public.record_waiver_signature(uuid, uuid, text, inet, text) from public;
grant execute on function public.record_waiver_signature(uuid, uuid, text, inet, text) to authenticated;

-- 6. teacher_documents ---------------------------------------
-- Metadata for files in the teacher-documents bucket. The kind
-- enum keeps tax / certification / other distinct so the UI can
-- group them. expires_on is for certifications (CPR, first aid)
-- so the UI can flag expiring/expired ones.

create table if not exists public.teacher_documents (
  id            uuid primary key default gen_random_uuid(),
  teacher_id    uuid not null references public.teachers(id) on delete cascade,
  kind          text not null check (kind in (
                  'tax_w9','tax_w4','tax_1099',
                  'certification_cpr','certification_first_aid','certification_background','certification_other',
                  'other'
                )),
  label         text,
  storage_path  text not null,
  mime_type     text,
  size_bytes    integer,
  expires_on    date,
  uploaded_by   uuid references public.profiles(id) on delete set null,
  uploaded_at   timestamptz not null default now()
);

create index if not exists teacher_documents_teacher_idx
  on public.teacher_documents (teacher_id, uploaded_at desc);

alter table public.teacher_documents enable row level security;

drop policy if exists "td_select" on public.teacher_documents;
create policy "td_select"
  on public.teacher_documents
  for select
  to authenticated
  using (public.has_permission('manage_teacher_compliance'));

drop policy if exists "td_insert" on public.teacher_documents;
create policy "td_insert"
  on public.teacher_documents
  for insert
  to authenticated
  with check (public.has_permission('manage_teacher_compliance'));

drop policy if exists "td_update" on public.teacher_documents;
create policy "td_update"
  on public.teacher_documents
  for update
  to authenticated
  using      (public.has_permission('manage_teacher_compliance'))
  with check (public.has_permission('manage_teacher_compliance'));

drop policy if exists "td_delete" on public.teacher_documents;
create policy "td_delete"
  on public.teacher_documents
  for delete
  to authenticated
  using (public.has_permission('manage_teacher_compliance'));

-- 7. Storage bucket: teacher-documents -----------------------
-- Private bucket. Unlike curriculum-assets (which has NO
-- SELECT policy because reads go through an Edge Function
-- intermediary), teacher-documents DOES expose SELECT to
-- authenticated callers who hold manage_teacher_compliance.
-- The metadata table already restricts visibility to those
-- callers, so adding a parallel storage SELECT policy is
-- consistent — no per-row authorization story is needed
-- here, just role-gating.

insert into storage.buckets (id, name, public)
  values ('teacher-documents','teacher-documents', false)
  on conflict (id) do nothing;

drop policy if exists "tdocs_admin_select" on storage.objects;
create policy "tdocs_admin_select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'teacher-documents'
    and public.has_permission('manage_teacher_compliance')
  );

drop policy if exists "tdocs_admin_insert" on storage.objects;
create policy "tdocs_admin_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'teacher-documents'
    and public.has_permission('manage_teacher_compliance')
  );

drop policy if exists "tdocs_admin_update" on storage.objects;
create policy "tdocs_admin_update"
  on storage.objects
  for update
  to authenticated
  using      (bucket_id = 'teacher-documents' and public.has_permission('manage_teacher_compliance'))
  with check (bucket_id = 'teacher-documents' and public.has_permission('manage_teacher_compliance'));

drop policy if exists "tdocs_admin_delete" on storage.objects;
create policy "tdocs_admin_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'teacher-documents'
    and public.has_permission('manage_teacher_compliance')
  );

-- 8. Seed: one active waiver --------------------------------
-- Sharon will edit this through the UI before launch. The seed
-- exists so the personnel modal has something to render on day
-- one. Idempotent on (version).

insert into public.liability_waivers (version, title, body_html, is_active)
values (
  1,
  'PAR DK Drama Kids — Teacher Liability Waiver',
  '<h2>PAR DK Drama Kids — Teacher Liability Waiver</h2>'
  '<p><strong>This is a placeholder waiver text.</strong> Sharon will replace this with the franchise''s actual liability and code-of-conduct language before launch.</p>'
  '<p>By signing below, I acknowledge that I have read and agree to the terms of employment, conduct, and safety expectations as outlined by the franchise owner. I understand that I am responsible for the safety of students under my care during scheduled class times.</p>'
  '<p>I agree to follow all background-check, mandatory-reporter, and child-safety policies of PAR DK Drama Kids and of the schools at which I teach.</p>'
  '<p>By typing my full name and clicking Sign, I am providing my electronic signature, which has the same legal force as a hand-written signature.</p>',
  true
)
on conflict (version) do nothing;

-- 9. Realtime publication -----------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='teacher_payment_details') then
    alter publication supabase_realtime add table public.teacher_payment_details;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='liability_waivers') then
    alter publication supabase_realtime add table public.liability_waivers;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='liability_waiver_signatures') then
    alter publication supabase_realtime add table public.liability_waiver_signatures;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='teacher_documents') then
    alter publication supabase_realtime add table public.teacher_documents;
  end if;
end $$;

commit;
