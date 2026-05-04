-- ============================================================
-- Phase T13: Per-school closures
-- ============================================================
--
-- Until now, the `closures` table held holidays / non-class days
-- with a single `date` + `label` and applied globally — a closure
-- on Mar 14 flagged EVERY class on the schedule grid that day,
-- regardless of which school each class belonged to. Fine for
-- single-location franchises; wrong for multi-school franchises
-- where (e.g.) Mt Pleasant ES is closed but West Ashley ES isn't.
--
-- T13 adds a nullable `school_id` FK:
--
--   • NULL  → global closure (preserves the full pre-T13 semantic
--             for every existing row; no backfill required).
--   • UUID  → scoped to that one school. Classes whose
--             `classes.school_id` matches are flagged; classes
--             with a different school_id (or NULL school_id +
--             only `classes.location` set) are unaffected.
--
-- Rendering rule (CLAUDE.md §5): only **global** closures
-- (`school_id is null`) trigger the cell-level red hatch on
-- Month view and the "🗓 closed" pill on Day/Week. Per-school
-- closures render as per-class muting on just the affected
-- class blocks. The day pill still lists ALL closures (with
-- school name in parens for non-global) so admins can read the
-- full picture.
--
-- No new permission, no RLS change. The existing
-- `closures_write_admin` (or whichever name T1.5 settled on —
-- the policy gates writes on `has_permission('edit_closures')`)
-- already covers school-scoped rows.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`)
-- once. Idempotent.

begin;

alter table public.closures
  add column if not exists school_id uuid
    references public.schools(id) on delete cascade;

create index if not exists closures_date_school_idx
  on public.closures (date, school_id);

commit;
