-- ============================================================
-- Phase T5c: Curriculum access log (audit) + watermarked viewer
-- ============================================================
--
-- Slice 3 (final) of T5 (see CLAUDE.md §4.22).
--
-- This migration ships exactly one schema object: the
-- `curriculum_access_log` table. Everything else for T5c is
-- code:
--   • Edge Function `curriculum-fetch` (verify_jwt: true) is
--     the only path that mints signed URLs against the private
--     `curriculum-assets` bucket. It runs the lead-window
--     check server-side and inserts a row here on every
--     successful read. Source lives in the parent folder per
--     CLAUDE.md §3 — at edge-functions/curriculum-fetch/.
--   • Watermarked viewer in app.js renders the signed URL
--     wrapped in a CSS-tiled overlay with the teacher's
--     identity + timestamp, with copy/save/print suppression.
--
-- Why the log lives in the database (not just Edge Function
-- logs): admin/manager need to query "who saw what when" for
-- corporate-sensitivity audits. Edge Function logs are
-- ephemeral + project-admin-only.
--
-- INSERT happens only via the Edge Function using the
-- service-role key, which bypasses RLS. There is intentionally
-- no INSERT policy. SELECT is gated by assign_curriculum so
-- Sharon and her admin/manager can review access. There is no
-- UPDATE or DELETE policy — append-only by design.
--
-- Per CLAUDE.md §5: never reference auth.users from RLS. All
-- caller-identity checks use auth.jwt() ->> 'email' — but here
-- only SELECT is exposed to authenticated users, and the gate
-- is permission-based, not identity-based.
--
-- Lead-window enforcement remains layered (see §4.22 / §5):
--   1. Client UX shows lock chips + countdown.
--   2. Edge Function refuses to mint a signed URL when locked.
--   3. The audit log records what actually got fetched.
-- RLS is NOT one of the layers. We deliberately do not encode
-- the rolling per-session date math in SQL.

begin;

-- 1. curriculum_access_log -----------------------------------
-- One row per successful (or attempted-but-permitted) read of
-- a bucket-stored item. The Edge Function inserts via service-
-- role; nothing else writes here.
--
-- access_kind:
--   'view'    — teacher fetching an assigned item
--   'preview' — admin/curator previewing from the edit modal
--               (CLAUDE.md §4.22). Logged so curators are
--               auditable too — corporate asks for a complete
--               trail, not just teacher-side reads.
--
-- curriculum_assignment_id is nullable: preview reads from the
-- edit modal happen before any assignment exists.
--
-- client_ip + user_agent are best-effort context. Edge Function
-- pulls them from the X-Forwarded-For + User-Agent headers. If
-- the request is server-to-server or headers are stripped, both
-- can be null — the log row still records the access.

create table if not exists public.curriculum_access_log (
  id                       uuid primary key default gen_random_uuid(),
  curriculum_item_id       uuid not null references public.curriculum_items(id)       on delete cascade,
  curriculum_assignment_id uuid          references public.curriculum_assignments(id) on delete set null,
  teacher_id               uuid          references public.teachers(id)               on delete set null,
  user_id                  uuid          references public.profiles(id)               on delete set null,
  access_kind              text not null check (access_kind in ('view','preview')),
  storage_path             text,           -- which bucket key was minted
  signed_url_ttl_seconds   integer,        -- ttl actually issued
  client_ip                text,
  user_agent               text,
  accessed_at              timestamptz not null default now()
);

create index if not exists curriculum_access_log_item_idx
  on public.curriculum_access_log (curriculum_item_id);
create index if not exists curriculum_access_log_assignment_idx
  on public.curriculum_access_log (curriculum_assignment_id);
create index if not exists curriculum_access_log_teacher_idx
  on public.curriculum_access_log (teacher_id);
create index if not exists curriculum_access_log_accessed_at_idx
  on public.curriculum_access_log (accessed_at desc);

alter table public.curriculum_access_log enable row level security;

-- SELECT: admin/manager (anyone with assign_curriculum or
-- edit_curriculum) can read the log. Teachers cannot — they
-- shouldn't be auditing each other.
drop policy if exists "curriculum_access_log_select_admin" on public.curriculum_access_log;
create policy "curriculum_access_log_select_admin"
  on public.curriculum_access_log
  for select
  to authenticated
  using (
    public.has_permission('assign_curriculum')
    or public.has_permission('edit_curriculum')
  );

-- Intentionally NO insert/update/delete policies. Writes only
-- happen via service-role in the curriculum-fetch Edge Function;
-- service-role bypasses RLS.

-- 2. Realtime -----------------------------------------------
-- So Sharon (or a logged-in admin tab) sees access events live
-- if she chooses to surface them in a future report.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'curriculum_access_log'
  ) then
    alter publication supabase_realtime add table public.curriculum_access_log;
  end if;
end $$;

commit;
