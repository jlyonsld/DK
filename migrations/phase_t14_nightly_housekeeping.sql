-- T14 — nightly housekeeping purge.
--
-- Three tables grow unbounded if left alone (CLAUDE.md §5/§6 rough edges):
--
--   install_nonces            — one row per consumed install token, never deleted
--   closures                  — date-stamped non-class days, never deleted
--   student_intake_requests   — token-gated parent-fill rows, never deleted
--
-- Volume is small per franchise (low hundreds per year) but every spoke install
-- carries the same housekeeping debt, so a single nightly worker is cheaper to
-- ship once than to revisit per-franchise once volume bites.
--
-- Retention windows (kept conservative — these tables are useful audit trail):
--   install_nonces           : 30 days post-consumption (replay-window long over)
--   closures                 : 90 days post-date         (last quarter visible)
--   student_intake_requests  : 90 days post-sent_at, status in (expired,cancelled)
--                              (completed rows STAY — they're the audit trail
--                              for who self-filled what; FK to students is the
--                              canonical record but the submitted_payload jsonb
--                              is the only place the original parent submission
--                              survives reconciliation/edits)
--
-- One housekeeping function does all three plus a pre-step that flips
-- pending-but-expired intake requests to status='expired' so the purge
-- catches them on the same run instead of one cycle later.

create or replace function public.nightly_housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intake_expired_now int;
  v_install_purged     int;
  v_closures_purged    int;
  v_intake_purged      int;
begin
  -- Step 1: flip pending-but-expired intake rows to 'expired' so the purge
  -- below can collect them. Without this, a row whose expires_at passed but
  -- which was never resent or cancelled would linger forever.
  update public.student_intake_requests
     set status = 'expired'
   where status = 'pending'
     and expires_at < now();
  get diagnostics v_intake_expired_now = row_count;

  -- Step 2: install_nonces — consumed_at is the only timestamp on this table
  -- (the column doubles as both "consumed" flag and "when"). Replay-protection
  -- window is the 5-minute token expiry, so 30 days is many orders of magnitude
  -- past any legitimate replay risk.
  delete from public.install_nonces
   where consumed_at < now() - interval '30 days';
  get diagnostics v_install_purged = row_count;

  -- Step 3: closures older than 90 days. Schedule views never look back that
  -- far; if an admin wants historical record, the closure was emailed/posted
  -- in real time. Per-school + global closures both purge identically.
  delete from public.closures
   where date < current_date - interval '90 days';
  get diagnostics v_closures_purged = row_count;

  -- Step 4: student_intake_requests in terminal failure states older than
  -- 90 days. Completed rows are NOT purged — submitted_payload is the only
  -- record of what the parent originally typed (canonical student row may
  -- have been edited / reconciled since).
  delete from public.student_intake_requests
   where status in ('expired','cancelled')
     and sent_at < now() - interval '90 days';
  get diagnostics v_intake_purged = row_count;

  return jsonb_build_object(
    'ran_at',                  now(),
    'intake_marked_expired',   v_intake_expired_now,
    'install_nonces_purged',   v_install_purged,
    'closures_purged',         v_closures_purged,
    'intake_requests_purged',  v_intake_purged
  );
end;
$$;

comment on function public.nightly_housekeeping() is
  'T14: scheduled by pg_cron job `nightly-housekeeping` at 03:30 UTC. Marks expired-pending intake rows, then purges install_nonces > 30d, closures > 90d, and terminal intake_requests > 90d. Returns a jsonb summary for cron.job_run_details inspection.';

-- Lock down. Cron runs as the postgres superuser; nothing else needs it.
revoke all on function public.nightly_housekeeping() from public, anon, authenticated;

-- Schedule daily at 03:30 UTC (~10:30/11:30pm ET). Idempotent re-run.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'nightly-housekeeping') then
    perform cron.unschedule('nightly-housekeeping');
  end if;
  perform cron.schedule(
    'nightly-housekeeping',
    '30 3 * * *',
    $cmd$select public.nightly_housekeeping()$cmd$
  );
end $$;
