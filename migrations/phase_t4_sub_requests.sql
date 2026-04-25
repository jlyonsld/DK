-- phase_t4_sub_requests.sql
--
-- Sub-request / shift-trade flow.
--
--   sub_requests  — a teacher (or admin on a teacher's behalf) flags a
--                   specific class session they can't cover. One row per
--                   (class_id, session_date) while open or filled; cancelled
--                   rows can re-coexist if a fresh request is opened later.
--   sub_claims    — other teachers offer to cover an open request. An
--                   admin/manager picks one to fill; non-chosen claims for
--                   the same request flip to 'declined' automatically.
--
-- RPCs (all `security invoker` — RLS fires per row, gated by has_permission()):
--   create_sub_request(p_class_id, p_session_date, p_reason)
--   claim_sub_request(p_sub_request_id, p_note)
--   withdraw_sub_claim(p_claim_id)
--   fill_sub_request(p_sub_request_id, p_teacher_id) — admin/manager only
--   cancel_sub_request(p_sub_request_id, p_reason)
--
-- Two new permissions added to has_permission():
--   claim_sub_requests        — teacher, manager, admin, super_admin
--   manage_all_sub_requests   — manager, admin, super_admin
--
-- `request_sub` was already in the teacher bundle from Phase T0 — we honor
-- it here (RLS lets a teacher INSERT a request scoped to a class they
-- teach). Admins/managers can create on a teacher's behalf via
-- manage_all_sub_requests.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: each CREATE uses IF NOT EXISTS, each policy / function /
-- trigger is dropped and re-created.

begin;

/* ─── Tables ─────────────────────────────────────────────────────────── */

create table if not exists public.sub_requests (
  id                       uuid primary key default gen_random_uuid(),
  class_id                 uuid not null references public.classes(id) on delete cascade,
  session_date             date not null,
  requested_by_teacher_id  uuid references public.teachers(id) on delete set null,
  created_by_user_id       uuid references auth.users(id)     on delete set null,
  reason                   text,
  notes                    text,
  status                   text not null default 'open'
    check (status in ('open','filled','cancelled')),
  filled_by_teacher_id     uuid references public.teachers(id) on delete set null,
  filled_at                timestamptz,
  cancelled_at             timestamptz,
  cancellation_reason      text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One non-cancelled request per (class, session_date). A cancelled request
-- doesn't block opening a fresh one for the same session.
create unique index if not exists sub_requests_one_open_per_session
  on public.sub_requests (class_id, session_date)
  where status <> 'cancelled';

create index if not exists sub_requests_status_idx       on public.sub_requests (status);
create index if not exists sub_requests_session_date_idx on public.sub_requests (session_date);
create index if not exists sub_requests_class_idx        on public.sub_requests (class_id);
create index if not exists sub_requests_requester_idx    on public.sub_requests (requested_by_teacher_id);

create table if not exists public.sub_claims (
  id                      uuid primary key default gen_random_uuid(),
  sub_request_id          uuid not null references public.sub_requests(id) on delete cascade,
  claimed_by_teacher_id   uuid not null references public.teachers(id) on delete cascade,
  claimed_by_user_id      uuid references auth.users(id) on delete set null,
  status                  text not null default 'pending'
    check (status in ('pending','accepted','declined','withdrawn')),
  note                    text,
  created_at              timestamptz not null default now(),
  decided_at              timestamptz,
  decided_by_user_id      uuid references auth.users(id) on delete set null,
  unique (sub_request_id, claimed_by_teacher_id)
);

create index if not exists sub_claims_request_idx on public.sub_claims (sub_request_id);
create index if not exists sub_claims_teacher_idx on public.sub_claims (claimed_by_teacher_id);
create index if not exists sub_claims_status_idx  on public.sub_claims (status);

-- updated_at trigger for sub_requests (mirrors patterns elsewhere).
create or replace function public.touch_sub_request_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists trg_sub_requests_touch on public.sub_requests;
create trigger trg_sub_requests_touch
  before update on public.sub_requests
  for each row execute function public.touch_sub_request_updated_at();

/* ─── Permissions ────────────────────────────────────────────────────── */

-- Extend has_permission(): two new perms layered on top of existing role
-- bundles. The function is replaced wholesale so the additions are visible
-- to every RLS policy that consults it. Pre-existing perms are preserved.
create or replace function public.has_permission(perm text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r          text;
  granted    text[];
  revoked    text[];
  bundle     text[];
begin
  select role, granted_permissions, revoked_permissions
    into r, granted, revoked
    from public.profiles
    where id = auth.uid();

  if r is null then return false; end if;

  if revoked is not null and perm = any(revoked) then return false; end if;
  if granted is not null and perm = any(granted) then return true;  end if;

  bundle := case r
    when 'super_admin' then array[
      'manage_billing','manage_super_admins','manage_admins',
      'manage_org','hard_delete','manage_users',
      'edit_classes','edit_teachers','edit_students','edit_enrollments','edit_attendance',
      'edit_templates','edit_categories','edit_infographics','edit_closures',
      'view_pay_rates','view_billing_status','view_parent_contact',
      'run_jackrabbit_sync','respond_to_leads',
      'reconcile_students',
      'request_sub','claim_sub_requests','manage_all_sub_requests'
    ]
    when 'admin' then array[
      'manage_users',
      'edit_classes','edit_teachers','edit_students','edit_enrollments','edit_attendance',
      'edit_templates','edit_categories','edit_infographics','edit_closures',
      'view_pay_rates','view_billing_status','view_parent_contact',
      'run_jackrabbit_sync','respond_to_leads',
      'reconcile_students',
      'request_sub','claim_sub_requests','manage_all_sub_requests'
    ]
    when 'manager' then array[
      'edit_templates','edit_categories','edit_infographics',
      'edit_classes','edit_teachers','edit_closures',
      'respond_to_leads',
      'view_classes_readonly','view_teachers_readonly',
      'view_students_readonly','view_enrollments_readonly',
      'claim_sub_requests','manage_all_sub_requests'
    ]
    when 'teacher' then array[
      'view_own_schedule','take_own_attendance','clock_in_out',
      'view_own_curriculum','view_own_pay_history','request_sub',
      'view_own_roster','manage_own_roster_students','manage_own_enrollments',
      'claim_sub_requests'
    ]
    when 'viewer' then array[
      'view_classes_readonly','view_teachers_readonly','view_students_readonly',
      'view_enrollments_readonly','view_attendance_readonly','view_billing_status_readonly'
    ]
    else array[]::text[]
  end;

  return perm = any(bundle);
end$$;

/* ─── RLS ───────────────────────────────────────────────────────────── */

alter table public.sub_requests enable row level security;
alter table public.sub_claims   enable row level security;

-- sub_requests SELECT: admins/managers see all; teachers see all open
-- requests (so they can shop for shifts) plus any request they created
-- or filled themselves.
drop policy if exists "sub_requests_select" on public.sub_requests;
create policy "sub_requests_select" on public.sub_requests
  for select using (
    has_permission('manage_all_sub_requests')
    or status = 'open'
    or requested_by_teacher_id in (
      select id from public.teachers
      where lower(coalesce(email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
    or filled_by_teacher_id in (
      select id from public.teachers
      where lower(coalesce(email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
  );

-- sub_requests INSERT goes through the create_sub_request RPC, but we
-- still allow direct INSERT for admins/managers (one-off scripts, dashboard
-- fixes). Teachers must use the RPC — the policy here would let them
-- insert a row on their own behalf for a class they teach, but the RPC
-- is the supported path.
drop policy if exists "sub_requests_insert_admin" on public.sub_requests;
create policy "sub_requests_insert_admin" on public.sub_requests
  for insert with check (has_permission('manage_all_sub_requests'));

drop policy if exists "sub_requests_insert_teacher" on public.sub_requests;
create policy "sub_requests_insert_teacher" on public.sub_requests
  for insert with check (
    has_permission('request_sub')
    and requested_by_teacher_id in (
      select t.id from public.teachers t
      where lower(coalesce(t.email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
    and exists (
      select 1 from public.class_teachers ct
      join public.teachers t on t.id = ct.teacher_id
      where ct.class_id = sub_requests.class_id
        and lower(coalesce(t.email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
  );

-- UPDATE: only admins/managers (RPCs do the heavy lifting). Teachers can't
-- mutate a request directly — they go through cancel_sub_request when
-- the requester wants to retract.
drop policy if exists "sub_requests_update_admin" on public.sub_requests;
create policy "sub_requests_update_admin" on public.sub_requests
  for update using (has_permission('manage_all_sub_requests'))
  with check (has_permission('manage_all_sub_requests'));

drop policy if exists "sub_requests_delete_admin" on public.sub_requests;
create policy "sub_requests_delete_admin" on public.sub_requests
  for delete using (has_permission('manage_all_sub_requests'));

-- sub_claims SELECT: admins/managers see all; teachers see claims attached
-- to a request they can already see (their own or open requests they could
-- compete for) — implemented as: visible if you own the claim OR the
-- parent request is visible to you.
drop policy if exists "sub_claims_select" on public.sub_claims;
create policy "sub_claims_select" on public.sub_claims
  for select using (
    has_permission('manage_all_sub_requests')
    or claimed_by_teacher_id in (
      select id from public.teachers
      where lower(coalesce(email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
    or sub_request_id in (
      select id from public.sub_requests
      where status = 'open'
         or requested_by_teacher_id in (
           select id from public.teachers
           where lower(coalesce(email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
         )
    )
  );

-- INSERT via claim_sub_request RPC; direct INSERT also allowed for the
-- claimer's own teacher row.
drop policy if exists "sub_claims_insert" on public.sub_claims;
create policy "sub_claims_insert" on public.sub_claims
  for insert with check (
    has_permission('claim_sub_requests')
    and claimed_by_teacher_id in (
      select t.id from public.teachers t
      where lower(coalesce(t.email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
  );

-- UPDATE: claimer can withdraw their own; admins/managers can decide
-- (accept/decline) any.
drop policy if exists "sub_claims_update" on public.sub_claims;
create policy "sub_claims_update" on public.sub_claims
  for update using (
    has_permission('manage_all_sub_requests')
    or claimed_by_teacher_id in (
      select t.id from public.teachers t
      where lower(coalesce(t.email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
  ) with check (
    has_permission('manage_all_sub_requests')
    or claimed_by_teacher_id in (
      select t.id from public.teachers t
      where lower(coalesce(t.email,'')) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
  );

drop policy if exists "sub_claims_delete_admin" on public.sub_claims;
create policy "sub_claims_delete_admin" on public.sub_claims
  for delete using (has_permission('manage_all_sub_requests'));

/* ─── RPCs ──────────────────────────────────────────────────────────── */

-- create_sub_request: opens a request for a class+session, anchored to the
-- caller's teacher row (resolved via auth.jwt() email match). Admins use the
-- two-arg overload below to file on a teacher's behalf.
create or replace function public.create_sub_request(
  p_class_id uuid,
  p_session_date date,
  p_reason text default null
) returns public.sub_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_teacher_id uuid;
  v_email      text;
  v_row        public.sub_requests;
begin
  if p_class_id is null or p_session_date is null then
    raise exception 'class_id and session_date are required';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  select id into v_teacher_id
    from public.teachers
    where lower(coalesce(email,'')) = v_email
    limit 1;

  -- Admins/managers without a teacher row can still file (requested_by left null).
  if v_teacher_id is null and not has_permission('manage_all_sub_requests') then
    raise exception 'No teacher row found for the signed-in user; ask an admin to create one';
  end if;

  insert into public.sub_requests (
    class_id, session_date, requested_by_teacher_id,
    created_by_user_id, reason, status
  ) values (
    p_class_id, p_session_date, v_teacher_id,
    auth.uid(), nullif(trim(coalesce(p_reason,'')),''), 'open'
  )
  returning * into v_row;

  return v_row;
end$$;

-- create_sub_request_for: admin/manager-only; files on behalf of a specific
-- teacher (for cases where the teacher isn't comfortable with the app).
create or replace function public.create_sub_request_for(
  p_class_id uuid,
  p_session_date date,
  p_teacher_id uuid,
  p_reason text default null
) returns public.sub_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.sub_requests;
begin
  if not has_permission('manage_all_sub_requests') then
    raise exception 'Permission denied: manage_all_sub_requests';
  end if;
  if p_class_id is null or p_session_date is null then
    raise exception 'class_id and session_date are required';
  end if;

  insert into public.sub_requests (
    class_id, session_date, requested_by_teacher_id,
    created_by_user_id, reason, status
  ) values (
    p_class_id, p_session_date, p_teacher_id,
    auth.uid(), nullif(trim(coalesce(p_reason,'')),''), 'open'
  )
  returning * into v_row;

  return v_row;
end$$;

-- claim_sub_request: any teacher with the claim_sub_requests permission can
-- offer to cover. Idempotent — re-claiming with a new note updates the
-- existing pending claim. Re-opens a withdrawn claim.
create or replace function public.claim_sub_request(
  p_sub_request_id uuid,
  p_note text default null
) returns public.sub_claims
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_email      text;
  v_teacher_id uuid;
  v_status     text;
  v_row        public.sub_claims;
begin
  if p_sub_request_id is null then
    raise exception 'sub_request_id is required';
  end if;
  if not has_permission('claim_sub_requests') then
    raise exception 'Permission denied: claim_sub_requests';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  select id into v_teacher_id
    from public.teachers
    where lower(coalesce(email,'')) = v_email
    limit 1;
  if v_teacher_id is null then
    raise exception 'No teacher row matches your email; ask an admin to create one';
  end if;

  select status into v_status from public.sub_requests where id = p_sub_request_id;
  if v_status is null then
    raise exception 'Sub request not found';
  end if;
  if v_status <> 'open' then
    raise exception 'This sub request is no longer open';
  end if;

  insert into public.sub_claims (
    sub_request_id, claimed_by_teacher_id, claimed_by_user_id, status, note
  ) values (
    p_sub_request_id, v_teacher_id, auth.uid(), 'pending',
    nullif(trim(coalesce(p_note,'')),'')
  )
  on conflict (sub_request_id, claimed_by_teacher_id) do update
    set status     = 'pending',
        note       = excluded.note,
        decided_at = null,
        decided_by_user_id = null
  returning * into v_row;

  return v_row;
end$$;

-- withdraw_sub_claim: claimer rescinds their own pending offer.
create or replace function public.withdraw_sub_claim(
  p_claim_id uuid
) returns public.sub_claims
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_email      text;
  v_teacher_id uuid;
  v_row        public.sub_claims;
begin
  if p_claim_id is null then raise exception 'claim_id is required'; end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  select id into v_teacher_id
    from public.teachers
    where lower(coalesce(email,'')) = v_email
    limit 1;

  update public.sub_claims
     set status = 'withdrawn',
         decided_at = now(),
         decided_by_user_id = auth.uid()
   where id = p_claim_id
     and (
       has_permission('manage_all_sub_requests')
       or claimed_by_teacher_id = v_teacher_id
     )
   returning * into v_row;

  if v_row.id is null then
    raise exception 'Claim not found or not yours to withdraw';
  end if;
  return v_row;
end$$;

-- fill_sub_request: admin/manager picks a teacher (typically a claimer, but
-- any teacher can be assigned — direct fill without a claim is fine).
-- If a matching pending claim exists it's marked accepted; sibling pending
-- claims for the same request flip to declined.
create or replace function public.fill_sub_request(
  p_sub_request_id uuid,
  p_teacher_id uuid
) returns public.sub_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.sub_requests;
begin
  if not has_permission('manage_all_sub_requests') then
    raise exception 'Permission denied: manage_all_sub_requests';
  end if;
  if p_sub_request_id is null or p_teacher_id is null then
    raise exception 'sub_request_id and teacher_id are required';
  end if;

  update public.sub_requests
     set status = 'filled',
         filled_by_teacher_id = p_teacher_id,
         filled_at = now(),
         cancelled_at = null,
         cancellation_reason = null
   where id = p_sub_request_id
     and status <> 'cancelled'
   returning * into v_row;

  if v_row.id is null then
    raise exception 'Sub request not found or already cancelled';
  end if;

  -- Mark the chosen claim accepted (if it exists), and any other pending claims declined.
  update public.sub_claims
     set status = 'accepted',
         decided_at = now(),
         decided_by_user_id = auth.uid()
   where sub_request_id = p_sub_request_id
     and claimed_by_teacher_id = p_teacher_id
     and status = 'pending';

  update public.sub_claims
     set status = 'declined',
         decided_at = now(),
         decided_by_user_id = auth.uid()
   where sub_request_id = p_sub_request_id
     and claimed_by_teacher_id <> p_teacher_id
     and status = 'pending';

  return v_row;
end$$;

-- cancel_sub_request: admin/manager always; the original requester can
-- cancel their own open request.
create or replace function public.cancel_sub_request(
  p_sub_request_id uuid,
  p_reason text default null
) returns public.sub_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_email      text;
  v_teacher_id uuid;
  v_row        public.sub_requests;
begin
  if p_sub_request_id is null then raise exception 'sub_request_id is required'; end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  select id into v_teacher_id
    from public.teachers
    where lower(coalesce(email,'')) = v_email
    limit 1;

  update public.sub_requests
     set status = 'cancelled',
         cancelled_at = now(),
         cancellation_reason = nullif(trim(coalesce(p_reason,'')),'')
   where id = p_sub_request_id
     and (
       has_permission('manage_all_sub_requests')
       or (status = 'open' and requested_by_teacher_id = v_teacher_id)
     )
   returning * into v_row;

  if v_row.id is null then
    raise exception 'Sub request not found, not yours to cancel, or already filled';
  end if;

  -- Any still-pending claims are now moot.
  update public.sub_claims
     set status = 'declined',
         decided_at = now(),
         decided_by_user_id = auth.uid()
   where sub_request_id = p_sub_request_id
     and status = 'pending';

  return v_row;
end$$;

/* ─── Realtime publication ──────────────────────────────────────────── */

-- Add the new tables to the realtime publication so the front-end channel
-- (already subscribed in app.js) lights up live without extra wiring.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sub_requests'
  ) then
    execute 'alter publication supabase_realtime add table public.sub_requests';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sub_claims'
  ) then
    execute 'alter publication supabase_realtime add table public.sub_claims';
  end if;
end$$;

commit;
