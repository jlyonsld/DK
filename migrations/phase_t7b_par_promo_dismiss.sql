-- ============================================================
-- Phase T7b: PAR promotion dismiss UX — self-read for own events
-- ============================================================
--
-- T7a (par_promotion_events) shipped with admin-only SELECT under
-- the rationale that "per-user reads aren't useful — the surface
-- is a personal prompt, not a shared resource."
--
-- T7b changes that calculus: the dismiss UX needs the client to
-- check "did I dismiss this variant in the last 7 days?" so the
-- resolver can fall back to the base variant. Without self-SELECT,
-- a user-side dismiss is invisible across reloads.
--
-- This migration adds a parallel permissive SELECT policy gated
-- on profile_id = auth.uid(). Multiple permissive policies are
-- OR'd, so admins continue to see every row via the existing
-- par_promo_events_admin_read policy; users now also see their
-- own rows. Cross-user reads stay denied.
--
-- No new permission name. No table changes. No new indexes —
-- the existing par_promo_events_profile_created_idx already
-- covers the (profile_id, created_at) lookup the dismiss check
-- and per-user funnel queries need.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`)
-- once. Idempotent: DROP POLICY IF EXISTS first.

begin;

drop policy if exists "par_promo_events_self_read" on public.par_promotion_events;
create policy "par_promo_events_self_read"
  on public.par_promotion_events
  for select
  to authenticated
  using (profile_id = auth.uid());

commit;
