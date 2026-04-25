-- ============================================================
-- Phase T7a: PAR promotion events (impressions + clicks)
-- ============================================================
--
-- Foundation slice for the freemium-conversion work. Logs every
-- impression / click / dismiss of a PAR promotional surface inside
-- DK so we can compute funnel metrics (which copy converts, which
-- audience converts, which surface converts) once we have a week
-- of data.
--
-- T7b will layer usage-based triggers ("you've taken attendance N
-- times — try PAR for your family schedule") on top of this same
-- table by adding new variant_keys and reading the impression
-- history to gate retriggers.
--
-- Design choices:
--
--   • variant_key is text, not enum, so the front end can A/B new
--     copy lines without a schema migration. The set of valid keys
--     lives in app.js (resolveParVariant + the variant copy table).
--
--   • event_kind IS an enum — impression/click/dismiss is the
--     entire dimension we ever expect to log against, and locking
--     it down keeps funnel queries unambiguous.
--
--   • metadata is jsonb so future variants can carry context
--     (usage threshold values, copy-test variant ids, etc.) without
--     reshaping the table. Anything we want to filter on for funnel
--     math at scale should be promoted to its own column later.
--
--   • Append-only by design — no UPDATE/DELETE policies (mirrors
--     curriculum_access_log + liability_waiver_signatures). If a
--     row was logged, it happened.
--
--   • Self-INSERT (auth.uid() = profile_id), admin SELECT only.
--     Per-user reads aren't useful — the surface is a personal
--     prompt, not a shared resource — and exposing read access
--     would let any teacher see how often other teachers were
--     pitched, which has no UX benefit.
--
--   • No new permission name. Logging is universal (any
--     authenticated user can record their own); reading uses
--     is_admin_or_above() (T6d) at the policy boundary.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`)
-- once. Idempotent: every CREATE uses IF NOT EXISTS, every policy
-- DROPs first.

begin;

/* ─── event_kind enum ──────────────────────────────────────── */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'par_promo_event_kind') then
    create type public.par_promo_event_kind as enum ('impression','click','dismiss');
  end if;
end$$;

/* ─── par_promotion_events table ───────────────────────────── */

create table if not exists public.par_promotion_events (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  variant_key  text not null,
  event_kind   public.par_promo_event_kind not null,
  surface      text not null default 'home_bento_par_card',
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- Funnel queries: filter by variant + kind, order by time.
create index if not exists par_promo_events_variant_kind_created_idx
  on public.par_promotion_events (variant_key, event_kind, created_at desc);

-- Per-user history (for T7b retrigger gating + per-user funnel).
create index if not exists par_promo_events_profile_created_idx
  on public.par_promotion_events (profile_id, created_at desc);

/* ─── RLS ──────────────────────────────────────────────────── */

alter table public.par_promotion_events enable row level security;

-- INSERT: any authenticated user can log their own events.
-- The check pins profile_id = auth.uid(), so a user can't
-- backfill events under another profile's id.
drop policy if exists "par_promo_events_self_insert" on public.par_promotion_events;
create policy "par_promo_events_self_insert"
  on public.par_promotion_events
  for insert
  to authenticated
  with check (profile_id = auth.uid());

-- SELECT: admin_or_above only. Funnel analysis is an
-- admin-tab concern; per-user reads have no UX role.
drop policy if exists "par_promo_events_admin_read" on public.par_promotion_events;
create policy "par_promo_events_admin_read"
  on public.par_promotion_events
  for select
  to authenticated
  using (public.is_admin_or_above());

-- No UPDATE / DELETE policies: append-only audit.

/* ─── Realtime publication ─────────────────────────────────── */
-- Not strictly required (no UI re-renders on someone-else logging
-- an impression), but consistent with the rest of the schema and
-- cheap. If aggregate-counter cards land in T7b, they'll get live
-- updates "for free."
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'par_promotion_events'
  ) then
    execute 'alter publication supabase_realtime add table public.par_promotion_events';
  end if;
end$$;

commit;
