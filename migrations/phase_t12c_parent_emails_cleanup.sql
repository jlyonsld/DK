-- T12c — Normalize students.parent_emails for Mailchimp sync.
--
-- Problem: the Zapier enrollment import (zapier-enrollment-webhook) stored two
-- parents in a SINGLE parent_emails array element, comma-joined
-- (e.g. ["brentmason@gmail.com,elysiadyan@gmail.com"], and the duplicate-self
-- form ["a@x.com,a@x.com"]). The MC enqueue triggers iterate the array verbatim,
-- so the drain handed Mailchimp "a@x.com,b@y.com" as one email and every row
-- failed with `400 Invalid Resource — Please provide a valid email address`,
-- then went stuck after 5 attempts. Nothing has synced since 2026-05-15.
--
-- Fix, in layers:
--   1. dk_normalize_emails(text[]) — split on comma/semicolon, trim, lowercase,
--      drop empties, dedupe. Reusable.
--   2. Both MC enqueue triggers + the backfill RPC normalize BEFORE enqueue, so
--      a comma-joined value from ANY path (intake form, manual add, a future
--      import bug) can never reach the drain again (defense-in-depth).
--   3. One-shot cleanup of existing students.parent_emails.
--   4. Purge the stale/stuck outbox rows and re-enqueue exactly one clean row
--      per (student, email) so the next drain tick flushes everyone.
--
-- Idempotent: safe to re-run. The data UPDATE only touches rows that change;
-- re-running re-purges + re-enqueues the (already clean) queue.

begin;

-- 1. Reusable normalizer ----------------------------------------------------
create or replace function public.dk_normalize_emails(arr text[])
returns text[]
language sql
immutable
set search_path to 'public'
as $func$
  select coalesce(array_agg(distinct piece order by piece), '{}'::text[])
  from (
    select lower(btrim(p)) as piece
    from unnest(coalesce(arr, '{}'::text[])) as elem,
         lateral regexp_split_to_table(elem, '[,;]') as p
    where btrim(p) <> ''
  ) s
$func$;

-- 2a. students trigger ------------------------------------------------------
create or replace function public.enqueue_mailchimp_sync_for_student()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare e text;
begin
  foreach e in array public.dk_normalize_emails(new.parent_emails) loop
    insert into mailchimp_sync_outbox (student_id, parent_email, op)
      values (new.id, e, 'upsert');
  end loop;
  return new;
end$function$;

-- 2b. enrollments trigger ---------------------------------------------------
create or replace function public.enqueue_mailchimp_sync_for_enrollment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare s_id uuid; s_emails text[]; e text;
begin
  s_id := coalesce(new.student_id, old.student_id);
  if s_id is null then return coalesce(new, old); end if;
  select parent_emails into s_emails from students where id = s_id;
  foreach e in array public.dk_normalize_emails(s_emails) loop
    insert into mailchimp_sync_outbox (student_id, parent_email, op)
      values (s_id, e, 'upsert');
  end loop;
  return coalesce(new, old);
end$function$;

-- 2c. backfill RPC (super_admin "Resync all students") ----------------------
create or replace function public.enqueue_mailchimp_backfill()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_enqueued int := 0; v_students int := 0;
begin
  if not public.is_super_admin() then
    raise exception 'super_admin only' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.dk_config
     where mailchimp_api_key is not null and mailchimp_audience_id is not null
  ) then
    raise exception 'Mailchimp is not configured (api_key + audience_id required)'
      using errcode = '22023';
  end if;

  with src as (
    select s.id as student_id, e as parent_email
      from public.students s
      cross join lateral unnest(public.dk_normalize_emails(s.parent_emails)) as e
  ),
  ins as (
    insert into public.mailchimp_sync_outbox (student_id, parent_email, op)
    select student_id, parent_email, 'upsert' from src
    returning 1
  )
  select count(*) into v_enqueued from ins;

  select count(distinct s.id) into v_students
    from public.students s
   where coalesce(array_length(public.dk_normalize_emails(s.parent_emails), 1), 0) > 0;

  return jsonb_build_object(
    'enqueued', v_enqueued,
    'students_covered', v_students,
    'enqueued_at', now()
  );
end;
$function$;

-- 3. Data cleanup -----------------------------------------------------------
-- Disable the MC trigger during the bulk UPDATE so it doesn't enqueue rows
-- we're about to purge-and-recreate in step 4 anyway.
alter table public.students disable trigger students_mc_sync;

update public.students
   set parent_emails = public.dk_normalize_emails(parent_emails)
 where parent_emails is not null
   and parent_emails is distinct from public.dk_normalize_emails(parent_emails);

alter table public.students enable trigger students_mc_sync;

-- 4. Requeue ----------------------------------------------------------------
-- Drop the stuck/pending rows (comma-joined garbage) and re-enqueue one clean
-- row per (student, email). marketing_status unsubscribed/cleaned rows are
-- skipped harmlessly by the drain.
delete from public.mailchimp_sync_outbox where completed_at is null;

insert into public.mailchimp_sync_outbox (student_id, parent_email, op)
select s.id, e, 'upsert'
  from public.students s
  cross join lateral unnest(public.dk_normalize_emails(s.parent_emails)) as e;

commit;
