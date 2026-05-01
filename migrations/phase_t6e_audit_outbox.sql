-- phase_t6e_audit_outbox.sql
-- T7b — Outbox + replay for DK→PAR role_audit mirroring.
--
-- Replaces the synchronous fire-and-forget call inside
-- role_audit_emit_to_par() with a transactional outbox row. A pg_cron
-- worker (every minute) drains the outbox: fires pending rows via pg_net,
-- polls net._http_response for in-flight rows, applies exponential backoff
-- on retryable errors, and gives up after max_attempts (default 6).
--
-- Idempotency: payload sets metadata.spoke_audit_id = role_audit.id; PAR's
-- spoke-emit-audit Edge Function dedupes via the unique partial index over
-- (metadata->>'spoke_audit_id'). Multi-send is safe.

-- ── 1. Outbox table ─────────────────────────────────────────────────────────
create table if not exists public.role_audit_outbox (
  id                uuid primary key default gen_random_uuid(),
  role_audit_id     uuid not null references public.role_audit(id) on delete cascade,
  payload           jsonb not null,
  status            text not null default 'pending'
                      check (status in ('pending','in_flight','delivered','failed')),
  attempts          int not null default 0,
  max_attempts      int not null default 6,
  next_attempt_at   timestamptz not null default now(),
  last_attempted_at timestamptz,
  last_request_id   bigint,
  last_status_code  int,
  last_error        text,
  created_at        timestamptz not null default now(),
  delivered_at      timestamptz,
  unique (role_audit_id)
);

-- Worker scans ready pending rows and stale in_flight rows by this index.
create index if not exists role_audit_outbox_due_idx
  on public.role_audit_outbox (status, next_attempt_at)
  where status in ('pending','in_flight');

comment on table public.role_audit_outbox is
  'T7b: outbox for DK→PAR role_audit mirroring. Drained by process_role_audit_outbox() on a 1-min cron. RLS-locked; access via SECURITY DEFINER worker only.';

-- ── 2. Replace the trigger function ─────────────────────────────────────────
-- Previous body called net.http_post() directly inside the trigger and
-- discarded the request_id. New body writes a row to role_audit_outbox and
-- returns — transactional with the role_audit insert, atomically all-or-nothing.
create or replace function public.role_audit_emit_to_par()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id        uuid;
  v_actor_email   text;
  v_target_email  text;
  v_payload       jsonb;
begin
  select par_franchise_org_id into v_org_id
    from public.dk_config limit 1;

  -- Without an org id configured we have nowhere to mirror to. Silent skip
  -- matches the pre-T7b behaviour and avoids breaking role_audit inserts on
  -- unconfigured / new DK installs.
  if v_org_id is null then return new; end if;

  select email into v_actor_email
    from auth.users where id = new.granted_by;

  select coalesce(p.par_primary_email, u.email) into v_target_email
    from public.profiles p
    left join auth.users u on u.id = p.id
    where p.id = new.subject_user_id;

  v_payload := jsonb_build_object(
    'spoke_slug',   'par-dk',
    'org_id',       v_org_id,
    'action',       'par-dk.role.changed',
    'actor_email',  v_actor_email,
    'target_email', v_target_email,
    'occurred_at',  new.created_at,
    'metadata', jsonb_build_object(
      'spoke_audit_id',             new.id,
      'subject_user_id',            new.subject_user_id,
      'prior_role',                 new.prior_role,
      'new_role',                   new.new_role,
      'prior_granted_permissions',  new.prior_granted_permissions,
      'new_granted_permissions',    new.new_granted_permissions,
      'prior_revoked_permissions',  new.prior_revoked_permissions,
      'new_revoked_permissions',    new.new_revoked_permissions,
      'reason',                     new.reason
    )
  );

  insert into public.role_audit_outbox (role_audit_id, payload)
    values (new.id, v_payload)
    on conflict (role_audit_id) do nothing;

  return new;
end;
$$;

-- ── 3. Backoff helper ───────────────────────────────────────────────────────
-- attempts 1→1m, 2→5m, 3→15m, 4→1h, 5→6h, 6+→24h.
create or replace function public.role_audit_outbox_backoff(p_attempts int)
returns interval
language sql
immutable
as $$
  select case
    when p_attempts <= 1 then interval '1 minute'
    when p_attempts =  2 then interval '5 minutes'
    when p_attempts =  3 then interval '15 minutes'
    when p_attempts =  4 then interval '1 hour'
    when p_attempts =  5 then interval '6 hours'
    else                      interval '24 hours'
  end;
$$;

-- ── 4. Worker — invoked every minute by cron ────────────────────────────────
create or replace function public.process_role_audit_outbox(p_batch int default 50)
returns table(processed int, delivered int, failed int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_url  text;
  v_bearer    text;
  v_processed int := 0;
  v_delivered int := 0;
  v_failed    int := 0;
  r           record;
  v_resp      record;
  v_req_id    bigint;
begin
  select coalesce(par_base_url, 'https://get-on-par.com')
    into v_base_url
    from public.dk_config limit 1;

  select decrypted_secret into v_bearer
    from vault.decrypted_secrets
    where name = 'par_spoke_api_key' limit 1;

  -- Without the bearer, no point firing. Don't burn attempt budget on a known
  -- config error — operator must restore the vault secret.
  if v_bearer is null then
    raise warning '[outbox] par_spoke_api_key not in vault; nothing to do';
    return query select 0,0,0;
    return;
  end if;

  -- 4a. Reconcile in_flight rows by polling net._http_response.
  for r in
    select * from public.role_audit_outbox
     where status = 'in_flight'
       and last_request_id is not null
     for update skip locked
  loop
    select * into v_resp from net._http_response where id = r.last_request_id;

    if v_resp.id is null then
      -- pg_net hasn't recorded a response. If older than 5 minutes, assume
      -- the response was reaped or never arrived; treat as timeout.
      if r.last_attempted_at < now() - interval '5 minutes' then
        if r.attempts >= r.max_attempts then
          update public.role_audit_outbox
             set status = 'failed',
                 last_error = 'no response from pg_net after 5min (max attempts exceeded)'
           where id = r.id;
          v_failed := v_failed + 1;
        else
          update public.role_audit_outbox
             set status = 'pending',
                 next_attempt_at = now() + role_audit_outbox_backoff(r.attempts),
                 last_error = 'no response from pg_net'
           where id = r.id;
        end if;
      end if;
      continue;
    end if;

    if v_resp.status_code = 200 then
      update public.role_audit_outbox
         set status = 'delivered',
             delivered_at = now(),
             last_status_code = v_resp.status_code,
             last_error = null
       where id = r.id;
      v_delivered := v_delivered + 1;
    elsif v_resp.status_code in (400, 403) then
      -- Non-retryable: spoke_not_installed, action_format_invalid, etc.
      update public.role_audit_outbox
         set status = 'failed',
             last_status_code = v_resp.status_code,
             last_error = coalesce(v_resp.content, v_resp.error_msg, 'http ' || v_resp.status_code)
       where id = r.id;
      v_failed := v_failed + 1;
    else
      -- Retryable: 5xx, 408, 429, network errors.
      if r.attempts >= r.max_attempts then
        update public.role_audit_outbox
           set status = 'failed',
               last_status_code = v_resp.status_code,
               last_error = coalesce(v_resp.content, v_resp.error_msg, 'http ' || v_resp.status_code) ||
                            ' (max attempts exceeded)'
         where id = r.id;
        v_failed := v_failed + 1;
      else
        update public.role_audit_outbox
           set status = 'pending',
               next_attempt_at = now() + role_audit_outbox_backoff(r.attempts),
               last_status_code = v_resp.status_code,
               last_error = coalesce(v_resp.content, v_resp.error_msg, 'http ' || v_resp.status_code)
         where id = r.id;
      end if;
    end if;
  end loop;

  -- 4b. Fire pending rows whose next_attempt_at has come due.
  for r in
    select * from public.role_audit_outbox
     where status = 'pending'
       and next_attempt_at <= now()
     order by next_attempt_at
     limit p_batch
     for update skip locked
  loop
    v_req_id := net.http_post(
      url     := v_base_url || '/functions/v1/spoke-emit-audit',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || v_bearer
                 ),
      body    := r.payload
    );
    update public.role_audit_outbox
       set status = 'in_flight',
           attempts = attempts + 1,
           last_request_id = v_req_id,
           last_attempted_at = now()
     where id = r.id;
    v_processed := v_processed + 1;
  end loop;

  return query select v_processed, v_delivered, v_failed;
end;
$$;

-- ── 5. Cron schedule (idempotent re-run) ────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'role-audit-outbox') then
    perform cron.unschedule('role-audit-outbox');
  end if;
  perform cron.schedule(
    'role-audit-outbox',
    '* * * * *',
    'select public.process_role_audit_outbox()'
  );
end $$;

-- ── 6. Observability view ───────────────────────────────────────────────────
create or replace view public.role_audit_outbox_summary as
select
  status,
  count(*)        as rows,
  min(created_at) as oldest,
  max(attempts)   as max_attempts_seen,
  count(*) filter (where attempts >= max_attempts) as exhausted
from public.role_audit_outbox
group by status;

-- ── 7. RLS — service-role only ──────────────────────────────────────────────
alter table public.role_audit_outbox enable row level security;
-- No policies: deny by default. The worker is SECURITY DEFINER so RLS doesn't
-- apply to it. If a future admin UI needs to read backlog, expose via a
-- SECURITY DEFINER RPC gated by is_admin_or_above().
