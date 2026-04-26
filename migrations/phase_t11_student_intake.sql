-- ═════════════════════════════════════════════════════════════════════════
-- Phase T11: Student intake — parent self-fill form
-- ═════════════════════════════════════════════════════════════════════════
--
-- Adds:
--   1. PII columns on students (medical, emergency contact, school/grade,
--      pickup, photo permission). Parent name/email/phone arrays already
--      exist (parent_names / parent_emails / parent_phones).
--   2. student_intake_requests table — token-gated form requests to a
--      parent's email. Admin clicks "Send form to parent", a token is
--      minted (raw token returned in URL, sha256 hash persisted), parent
--      submits the public form, the dk-submit-intake-form Edge Function
--      verifies the token + inserts the student + enrollment in a single
--      transaction.
--
-- Design notes:
--   - We persist sha256(raw_token) only. A DB leak does NOT expose live
--     intake tokens. Verification: re-hash the URL token and lookup.
--   - No new permission name. SELECT/manage gates on the existing
--     edit_students permission (manager+).
--   - Both Edge Functions (dk-send-intake-form, dk-submit-intake-form)
--     use service-role for writes — there are no INSERT/UPDATE/DELETE
--     policies on student_intake_requests by design. The parent has no
--     auth session; the token IS the auth.
--   - Realtime publication: included so admin sees pending intakes light
--     up live when a parent completes the form.

-- ──── 1. PII columns on students ────────────────────────────────────────
alter table public.students
  add column if not exists allergies text,
  add column if not exists medical_notes text,
  add column if not exists photo_permission boolean,
  add column if not exists emergency_contact_name text,
  add column if not exists emergency_contact_phone text,
  add column if not exists emergency_contact_relationship text,
  add column if not exists school_name text,
  add column if not exists grade text,
  add column if not exists authorized_pickup text;

comment on column public.students.allergies is
  'Free-form list of allergies (food / environmental / medication). Parent-fillable via T11 intake form.';
comment on column public.students.medical_notes is
  'Free-form medical conditions, accommodations, behavioral notes. Parent-fillable.';
comment on column public.students.photo_permission is
  'Whether the parent grants permission to use the student''s likeness in marketing/social. Tri-state: true = yes, false = no, null = not asked.';
comment on column public.students.emergency_contact_name is
  'Person to contact in an emergency if no parent reachable. Distinct from parent_names[].';
comment on column public.students.school_name is
  'Day school the student attends. Used for outreach + scheduling proximity.';
comment on column public.students.grade is
  'Free-form grade level (e.g. "K", "1st", "Pre-K3").';
comment on column public.students.authorized_pickup is
  'Free-form list of additional people authorized to pick up the student. Distinct from emergency contact.';


-- ──── 2. student_intake_requests table ──────────────────────────────────
create table if not exists public.student_intake_requests (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  parent_email text not null
    check (parent_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  -- Optional pre-fill fields the admin may know already
  initial_first_name text,
  initial_last_name text,
  -- sha256(raw_token_hex) — never stores the raw token
  token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'cancelled', 'expired')),
  sent_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Filled in by dk-submit-intake-form on completion
  completed_at timestamptz,
  resulting_student_id uuid references public.students(id) on delete set null,
  resulting_enrollment_id uuid references public.enrollments(id) on delete set null,
  submitted_payload jsonb,
  -- Email send audit (incremented on resend)
  last_email_status text,
  last_email_error text,
  email_sent_count int not null default 0,
  notes text
);

create index if not exists student_intake_requests_class_idx
  on public.student_intake_requests(class_id);
create index if not exists student_intake_requests_status_idx
  on public.student_intake_requests(status);
create index if not exists student_intake_requests_email_idx
  on public.student_intake_requests(lower(parent_email));
create index if not exists student_intake_requests_pending_idx
  on public.student_intake_requests(class_id, sent_at desc)
  where status = 'pending';

comment on table public.student_intake_requests is
  'T11: Parent self-fill student intake. Token-gated; raw token lives only in the URL emailed to the parent. Service-role writes only.';
comment on column public.student_intake_requests.token_hash is
  'sha256(raw_token_hex). Defends against a DB leak — a leaked row cannot be used to forge an intake submission.';
comment on column public.student_intake_requests.submitted_payload is
  'jsonb snapshot of what the parent submitted. Audit trail; the canonical data lives on the resulting student row.';


-- ──── 3. RLS ────────────────────────────────────────────────────────────
alter table public.student_intake_requests enable row level security;

-- Admins / managers (edit_students) see all intake requests for any class.
drop policy if exists "intake_requests_select_admin" on public.student_intake_requests;
create policy "intake_requests_select_admin"
  on public.student_intake_requests for select to authenticated
  using (public.has_permission('edit_students'));

-- Teachers assigned to the class see pending/completed intakes for that
-- class, so they know what's outstanding for their roster.
-- Email-match pattern per CLAUDE.md §5 (never reference auth.users).
drop policy if exists "intake_requests_select_teacher" on public.student_intake_requests;
create policy "intake_requests_select_teacher"
  on public.student_intake_requests for select to authenticated
  using (
    exists (
      select 1
      from public.class_teachers ct
      join public.teachers t on t.id = ct.teacher_id
      where ct.class_id = student_intake_requests.class_id
        and lower(t.email) = lower(auth.jwt() ->> 'email')
    )
  );

-- No INSERT/UPDATE/DELETE policies — service-role only via
-- dk-send-intake-form (insert) and dk-submit-intake-form (update on
-- completion). Admins managing the request lifecycle (cancel / resend)
-- also go through Edge Functions to keep the audit fields consistent.


-- ──── 4. Realtime ──────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'student_intake_requests'
  ) then
    execute 'alter publication supabase_realtime add table public.student_intake_requests';
  end if;
end$$;


-- ──── 5. Helper RPC: cancel_student_intake ──────────────────────────────
-- Admin-side cancel surface. Marks the row cancelled; the token remains
-- but is unusable because dk-submit-intake-form refuses non-pending rows.
create or replace function public.cancel_student_intake(p_intake_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_permission('edit_students') then
    raise exception 'Not authorized to cancel intake requests';
  end if;
  update public.student_intake_requests
     set status = 'cancelled'
   where id = p_intake_id
     and status = 'pending';
  if not found then
    raise exception 'Intake request not found or not pending';
  end if;
end;
$$;

revoke all on function public.cancel_student_intake(uuid) from public;
grant execute on function public.cancel_student_intake(uuid) to authenticated;
