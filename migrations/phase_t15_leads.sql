-- phase_t15_leads.sql
--
-- T15: Meta Lead Ads → DK staging inbox.
--
-- Lands inbound leads from Meta's Lead Ads webhook into a `leads` staging
-- table. Admin reviews in a new "Leads" tab and either (a) replies via the
-- existing template + infographics machinery, (b) promotes the lead to a
-- `students` row + fires a T11 student_intake_request to the parent for
-- the rest, (c) marks junk, or (d) archives. Mailchimp sync continues to
-- run in parallel via Mailchimp's native FB Lead Ads connector — the
-- `leads` table is DK's own copy so the franchise isn't dependent on MC
-- to see new leads.
--
-- Why a staging table instead of `students.source = 'meta_lead'`: Meta
-- payloads are messy (test submissions, fat-fingered phones, no class
-- selection). Promoting to a real student should be an explicit admin
-- action, not automatic. The schema mirrors the
-- `student_intake_requests` pattern (T11) — durable inbox row + audit
-- fields tracking what eventually became of it.
--
-- Permission: REUSES the existing `respond_to_leads` permission (already
-- in super_admin/admin/manager bundles from earlier phases — see T10's
-- has_permission() definition). No new permission name. Following CLAUDE
-- §4.5: consolidate first, split later if franchise needs a separate
-- "manage_leads" role for someone who archives but doesn't respond.
--
-- Idempotency: `meta_lead_id` carries a unique constraint. Meta retries
-- the same leadgen webhook on non-2xx responses; the Edge Function does
-- an `INSERT ... ON CONFLICT DO NOTHING` on this column.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: each CREATE uses IF NOT EXISTS, each policy is dropped and
-- re-created.

begin;

/* ─── Enum ───────────────────────────────────────────────────────────── */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_status') then
    create type public.lead_status as enum (
      'new',         -- just landed from webhook
      'contacted',   -- admin sent a reply (template / mailto / manual)
      'promoted',    -- promoted to a students row
      'junk',        -- marked junk by admin
      'archived'     -- intentionally hidden from default inbox view
    );
  end if;
end$$;

/* ─── Table ──────────────────────────────────────────────────────────── */

create table if not exists public.leads (
  id                    uuid primary key default gen_random_uuid(),

  -- Parent / child fields populated by the Edge Function from the Meta
  -- field_data array. Leave nullable — Meta's lead form composition is
  -- per-franchise and we don't want a strict NOT NULL constraint to
  -- reject a lead because the form didn't ask for child_name.
  parent_name           text,
  parent_email          text,
  parent_phone          text,
  child_name            text,
  child_dob             date,
  school_of_interest    text,        -- if the form has a "which school?" question

  -- Meta provenance.
  meta_lead_id          text unique, -- leadgen_id; carries unique idempotency
  meta_form_id          text,
  meta_page_id          text,
  meta_ad_id            text,
  raw_meta_payload      jsonb,       -- full webhook + fetched field_data, for audit

  source                text not null default 'meta_lead_ad',
  status                public.lead_status not null default 'new',
  notes                 text,        -- admin scratchpad

  -- Promotion audit (set when admin promotes to a students row).
  promoted_student_id   uuid references public.students(id) on delete set null,
  promoted_at           timestamptz,
  promoted_by           uuid references auth.users(id) on delete set null,

  -- Reply audit (stamped when admin uses the template-reply path).
  contacted_at          timestamptz,
  contacted_by          uuid references auth.users(id) on delete set null,

  -- Fetch error from the Edge Function — non-null means the row landed
  -- with only the leadgen pointer (no field_data) because the page
  -- access token wasn't set or Meta's GET failed. Admin can re-trigger
  -- the fetch manually.
  last_fetch_error      text,

  received_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists leads_status_idx     on public.leads (status);
create index if not exists leads_received_idx   on public.leads (received_at desc);
create index if not exists leads_parent_email   on public.leads (lower(parent_email));
create index if not exists leads_school_idx     on public.leads (school_of_interest);

create or replace function public.touch_leads_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

drop trigger if exists trg_leads_touch on public.leads;
create trigger trg_leads_touch
  before update on public.leads
  for each row execute function public.touch_leads_updated_at();

/* ─── RLS ────────────────────────────────────────────────────────────── */

alter table public.leads enable row level security;

-- SELECT / INSERT / UPDATE / DELETE all gated on respond_to_leads.
-- The Edge Function uses service-role and bypasses RLS — these
-- policies are for in-app reads + admin actions only.
drop policy if exists "leads_select" on public.leads;
create policy "leads_select" on public.leads
  for select using (public.has_permission('respond_to_leads'));

drop policy if exists "leads_insert" on public.leads;
create policy "leads_insert" on public.leads
  for insert with check (public.has_permission('respond_to_leads'));

drop policy if exists "leads_update" on public.leads;
create policy "leads_update" on public.leads
  for update using (public.has_permission('respond_to_leads'))
  with check  (public.has_permission('respond_to_leads'));

drop policy if exists "leads_delete" on public.leads;
create policy "leads_delete" on public.leads
  for delete using (public.has_permission('respond_to_leads'));

/* ─── Promote-to-student RPC ─────────────────────────────────────────── */

-- Atomic promotion: insert students row from lead, mark lead promoted,
-- return the new student_id so the UI can immediately open the Add
-- Student modal (or fire a T11 intake request). Class assignment is
-- DELIBERATELY left to the caller — Meta forms don't pick a class, so
-- the admin chooses one before calling this RPC OR after, via the
-- standard enrollments flow.
--
-- Caller must hold respond_to_leads + edit_students. Both are already
-- co-located in admin/manager bundles, so a typical caller has both.
create or replace function public.promote_lead_to_student(
  p_lead_id   uuid,
  p_first     text,
  p_last      text,
  p_dob       date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead         public.leads%rowtype;
  v_student_id   uuid;
  v_caller       uuid := auth.uid();
begin
  if not public.has_permission('respond_to_leads') then
    raise exception 'permission denied: respond_to_leads' using errcode = '42501';
  end if;
  if not public.has_permission('edit_students') then
    raise exception 'permission denied: edit_students' using errcode = '42501';
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if v_lead.status = 'promoted' then
    raise exception 'lead already promoted' using errcode = '23505';
  end if;
  if coalesce(trim(p_first), '') = '' or coalesce(trim(p_last), '') = '' then
    raise exception 'first_name and last_name are required' using errcode = '23502';
  end if;

  v_student_id := gen_random_uuid();

  insert into public.students (
    id, first_name, last_name, dob,
    parent_names, parent_emails, parent_phones,
    source
  )
  values (
    v_student_id, trim(p_first), trim(p_last), coalesce(p_dob, v_lead.child_dob),
    case when coalesce(trim(v_lead.parent_name), '') = '' then '{}'::text[]
         else array[v_lead.parent_name] end,
    case when coalesce(trim(v_lead.parent_email), '') = '' then '{}'::text[]
         else array[lower(trim(v_lead.parent_email))] end,
    case when coalesce(trim(v_lead.parent_phone), '') = '' then '{}'::text[]
         else array[v_lead.parent_phone] end,
    'dk_local'
  );

  update public.leads
     set status              = 'promoted',
         promoted_student_id = v_student_id,
         promoted_at         = now(),
         promoted_by         = v_caller
   where id = p_lead_id;

  return v_student_id;
end;
$$;

revoke all on function public.promote_lead_to_student(uuid, text, text, date) from public;
grant execute on function public.promote_lead_to_student(uuid, text, text, date) to authenticated;

/* ─── Mark-contacted helper ──────────────────────────────────────────── */

-- Stamps contacted_at + contacted_by + status='contacted' atomically.
-- Called from the template-picker modal after admin clicks "Copy &
-- mark contacted". Doesn't move a lead out of 'new' if the admin
-- bailed mid-modal; only fires on explicit confirmation.
create or replace function public.mark_lead_contacted(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('respond_to_leads') then
    raise exception 'permission denied: respond_to_leads' using errcode = '42501';
  end if;

  update public.leads
     set status        = case when status = 'new' then 'contacted' else status end,
         contacted_at  = now(),
         contacted_by  = auth.uid()
   where id = p_lead_id;
end;
$$;

revoke all on function public.mark_lead_contacted(uuid) from public;
grant execute on function public.mark_lead_contacted(uuid) to authenticated;

/* ─── Realtime publication ──────────────────────────────────────────── */

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'leads'
  ) then
    execute 'alter publication supabase_realtime add table public.leads';
  end if;
end$$;

commit;
