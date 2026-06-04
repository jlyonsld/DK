-- phase_t20_class_pay_basis.sql
--
-- Per-class pay basis: whether teaching a given class is paid BY THE HOUR
-- or BY THE CLASS (a flat per-session amount). Set at the super_admin level
-- (the class editor only exposes the control to super_admin; RLS on
-- `classes` still gates writes on edit_classes, matching how the other
-- super_admin-only controls — e.g. payment_methods — are gated client-side).
--
-- Null = unset; the payroll report treats unset/anything-not-'per_class' as
-- hourly so existing Jackrabbit-synced classes keep today's behavior until a
-- super_admin marks them per-class.
--
-- The dollar amounts / Gusto column mapping are deliberately NOT modeled yet
-- — that waits on Sharon nailing down Gusto's import fields. This migration
-- only adds the basis flag so the capability exists.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent. `classes` is already in the realtime publication.

begin;

alter table public.classes
  add column if not exists pay_basis text;

alter table public.classes
  drop constraint if exists classes_pay_basis_check;
alter table public.classes
  add constraint classes_pay_basis_check
  check (pay_basis is null or pay_basis in ('hourly','per_class'));

commit;
