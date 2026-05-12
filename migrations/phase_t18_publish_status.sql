-- phase_t18_publish_status.sql
--
-- T18: Draft / published / archived workflow for templates and infographics.
--
-- Rationale (CLAUDE.md §4.34): templates and infographics share an identical
-- review workflow — Sharon (or any manager) curates a draft, blesses it as
-- published when reviewed, optionally archives it later. Drafts and archived
-- rows are HIDDEN ENTIRELY from the response-console picker contexts (Leads
-- reply modal template select, Leads reply infographic attach strip, Templates
-- tab infographics sidebar). The Templates tab card grid and the Manage
-- infographics modal show ALL statuses with filter chips so admins can review.
--
-- Backfill: ALL existing rows → 'draft'. Forces an explicit "I've reviewed
-- this" before a row reaches the response-console. A super_admin-only
-- "Publish all drafts" button in each manage surface short-circuits the
-- review if a franchise wants to opt-in en masse.
--
-- Permissions: REUSED, not new. `edit_templates` / `edit_infographics`
-- already cover write access; the publish/unpublish toggle is just another
-- UPDATE on the same row. Same §4.5 pattern as T15 reusing
-- `respond_to_leads` — granular split is a future one-line gate change.
--
-- Enum shape: ONE shared `content_status` enum (`draft`, `published`,
-- `archived`) used by both tables. Same review workflow → same type. Leaves
-- room for additional values via `ALTER TYPE ADD VALUE` without a new
-- migration.
--
-- Apply against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) once.
-- Idempotent: each ADD COLUMN uses IF NOT EXISTS; the enum CREATE is wrapped
-- in a `do$$` guard.

begin;

/* ─── Enum ───────────────────────────────────────────────────────────── */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'content_status') then
    create type public.content_status as enum (
      'draft',      -- not yet reviewed; hidden from picker contexts
      'published',  -- reviewed and visible in response-console
      'archived'    -- intentionally hidden from default views; un-archive to restore
    );
  end if;
end$$;

/* ─── templates ──────────────────────────────────────────────────────── */

alter table public.templates
  add column if not exists status        public.content_status not null default 'draft',
  add column if not exists published_at  timestamptz,
  add column if not exists published_by  uuid references public.profiles(id) on delete set null;

create index if not exists templates_status_idx on public.templates (status);

/* ─── infographics ───────────────────────────────────────────────────── */

alter table public.infographics
  add column if not exists status        public.content_status not null default 'draft',
  add column if not exists published_at  timestamptz,
  add column if not exists published_by  uuid references public.profiles(id) on delete set null;

create index if not exists infographics_status_idx on public.infographics (status);

/* ─── Backfill ───────────────────────────────────────────────────────── */
--
-- All existing rows land as 'draft'. The default above only fires for NEW
-- rows; existing rows already have NULL after ADD COLUMN with a default,
-- but only ON THE FIRST run of this migration (Postgres backfills via
-- pg_attribute.atthasmissing). Idempotent UPDATE below covers re-runs and
-- any rows that somehow ended up NULL.

update public.templates
   set status = 'draft'
 where status is null;

update public.infographics
   set status = 'draft'
 where status is null;

/* ─── Realtime ───────────────────────────────────────────────────────── */
--
-- Both tables are already in `supabase_realtime` from prior phases; no add
-- needed. Status changes flow live across browsers within the 300ms debounce.

commit;
