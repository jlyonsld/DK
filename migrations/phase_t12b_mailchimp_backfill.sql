-- T12b — Mailchimp backfill RPC.
--
-- The T12 outbox triggers fire on students INSERT/UPDATE and enrollments
-- any-change. They do NOT fire on a no-op — so a franchise that connects
-- Mailchimp for the first time gets nothing pushed for any pre-existing
-- student. CLAUDE.md §4.29 calls this out: "bulk backfill of existing
-- students into MC on first connect (admin can `update students set
-- parent_emails = parent_emails` after connect to retrigger every row,
-- but it's not a button)."
--
-- This is the button. One RPC, super_admin gated, enqueues one outbox row
-- per (student, parent_email) pair across the whole roster. The drain
-- function picks them up on its next 60s tick and processes per existing
-- rate-limit / dedup logic — so kicking this once on a 5,000-student
-- roster is safe; MC's API tolerates ~10 req/s and the drain caps at
-- 50 rows/min.
--
-- Idempotent in the sense that re-running enqueues again (creates redundant
-- upsert ops at MC), but MC upserts are themselves idempotent so the only
-- cost is API call budget. Future tightening could check for an existing
-- pending outbox row per (student, parent_email) and skip — not worth it
-- for the one-time-per-franchise use case.

create or replace function public.enqueue_mailchimp_backfill()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enqueued int := 0;
  v_students int := 0;
begin
  if not public.is_super_admin() then
    raise exception 'super_admin only' using errcode = '42501';
  end if;

  -- Bail early if MC isn't configured. The drain itself no-ops when
  -- mailchimp_api_key is null, but a backfill that produces 5,000 outbox
  -- rows that all skip is wasteful and confusing in the sync log.
  if not exists (
    select 1 from public.dk_config
     where mailchimp_api_key is not null
       and mailchimp_audience_id is not null
  ) then
    raise exception 'Mailchimp is not configured (api_key + audience_id required)'
      using errcode = '22023';
  end if;

  with src as (
    select s.id as student_id, lower(btrim(e)) as parent_email
      from public.students s
      cross join lateral unnest(coalesce(s.parent_emails, '{}'::text[])) as e
     where e is not null
       and btrim(e) <> ''
  ),
  ins as (
    insert into public.mailchimp_sync_outbox (student_id, parent_email, op)
    select student_id, parent_email, 'upsert' from src
    returning 1
  )
  select count(*) into v_enqueued from ins;

  select count(distinct s.id) into v_students
    from public.students s
   where coalesce(array_length(s.parent_emails, 1), 0) > 0;

  return jsonb_build_object(
    'enqueued',         v_enqueued,
    'students_covered', v_students,
    'enqueued_at',      now()
  );
end;
$$;

comment on function public.enqueue_mailchimp_backfill() is
  'T12b: super_admin-only one-shot to enqueue every student×parent_email into mailchimp_sync_outbox. Used after first MC connect to seed the audience from the existing roster. Drain processes at 50 rows/min.';

revoke all on function public.enqueue_mailchimp_backfill() from public, anon;
grant execute on function public.enqueue_mailchimp_backfill() to authenticated;
