# T17 Verification — task federation (DK → PAR via spoke-create-task)

> Mirrors Margin's PAR task federation pattern (built 2026-05-06). DK
> reads `org_id` from `dk_config.par_franchise_org_id` instead of an env
> var; otherwise verbatim Margin shape. See CLAUDE.md §4.33.

## 0. Prereqs

- `migrations/phase_t17_tasks.sql` applied to DK (`ybolygqdbjqowfoqvnsz`).
- `edge-functions/dk-create-par-task/index.ts` deployed to DK.
- Hard reload after deploy so the new `app.js` / `styles.css` are loaded.

The PAR side (Margin already built it):

- `spoke-create-task` Edge Function exists on PAR.
- Spoke `dk` registered in `public.spokes`.
- API key in `public.spoke_api_keys` (raw key pasted into DK's
  `DK_SPOKE_API_KEY` Edge Function secret; PAR keeps only the SHA-256 hash).
- Install row in `public.spoke_installations` for Charleston's org with
  `installed_by` = your PAR user uuid.
- **Capability row in `public.spoke_capabilities`** for
  `(spoke_slug='dk', endpoint='spoke-create-task')` — separate gate beyond
  install. Without it, `spoke-create-task` returns `403 capability_missing`.

**Why direct INSERTs (not `admin_install_spoke()`):** the RPC reads
`auth.uid()` and rejects SQL Editor calls (`auth_required` — service-role
context has null uid). Either invoke from PAR's signed-in admin UI OR
INSERT directly into `spoke_installations`. See CLAUDE.md §4.33 "T17b
lessons learned".

## 1. Migration spot-checks

```sql
-- New table
select count(*) as cnt from information_schema.tables
 where table_schema = 'public' and table_name = 'tasks';
-- Expect: 1.

-- Status + priority enums
select typname from pg_type where typname in ('task_status','task_priority');
-- Expect: 2 rows.

-- Partial unique index on par_task_id
select indexdef from pg_indexes
 where tablename = 'tasks' and indexname = 'tasks_par_task_id_unique';
-- Expect: index includes "WHERE par_task_id IS NOT NULL"

-- manage_tasks now lives in the bundles
select public.has_permission('manage_tasks');
-- Expect (signed-in as super_admin / admin / manager): true
-- Expect (signed-in as teacher / viewer): false
```

## 2. Permission + role gating (UI)

Sign in as each role and confirm:

| Role        | Top tab "Tasks" visible? | Can click "+ New task"? | Bento "Tasks for you" appears when assigned? |
|-------------|--------------------------|-------------------------|----------------------------------------------|
| super_admin | yes                      | yes                     | yes                                          |
| admin       | yes                      | yes                     | yes                                          |
| manager     | yes                      | yes                     | yes                                          |
| teacher     | **no top tab**           | n/a                     | yes (read-only except status flip)           |
| viewer      | **no top tab**           | n/a                     | yes (read-only except status flip)           |

Teacher / viewer see assigned tasks via the home bento card (RLS
SELECT is open to all authenticated). They can flip status via the
inline select (the `set_task_status` RPC permits owner-self updates
even without `manage_tasks`).

## 3. Local CRUD round-trip (no PAR yet)

Sign in as super_admin:

1. **Tasks tab → "+ New task"** → fill title "Test billing emails",
   project "DK: Charleston", priority Med, status Open, owner = your
   own profile, due = tomorrow.
2. Save. Card appears under group "DK: Charleston" with the open
   chip + "Send to PAR" button.
3. Refresh another browser window — card appears live (realtime
   publication confirmed).
4. Click Edit on the card → change priority to High → Save → chip
   updates.
5. Inline status select → flip to "In progress" → realtime updates
   the other window.
6. Delete → confirm → row removed locally; (PAR copy untouched if
   sent).

## 4. Owner self-flip via `set_task_status` (teacher path)

```sql
-- Set up: assign a task to a teacher's profile id
insert into public.tasks (title, project_name, owner_profile_id, status)
values ('Confirm Wando schedule', 'DK: Charleston',
        (select id from public.profiles where role = 'teacher' limit 1),
        'open');
```

Sign in as that teacher → home bento → "Tasks for you" card lists the
row → flip status to "Done". Refresh — status persists. Confirm via
SQL:

```sql
select id, status from public.tasks where title = 'Confirm Wando schedule';
-- Expect: status = 'done'
```

Negative case: sign in as a *different* teacher (not the owner). The
home bento "Tasks for you" card should NOT show this task. Direct
attempt at flipping should fail RLS — the row exists in `state.tasks`
because SELECT is open, but no inline select renders for non-owners
in the bento (the editor is hidden). Calling the RPC manually:

```js
await sb.rpc("set_task_status", { p_id: "<the-task-uuid>", p_status: "done" });
// Expect: error 42501 "task not found or not owned by caller"
```

## 5. 501 fallback (PAR not wired)

Before setting `DK_SPOKE_API_KEY` on the DK Edge Function:

1. Tasks tab → click "Send to PAR" on any task.
2. Toast shows: "PAR not wired — missing env: DK_SPOKE_API_KEY. Set
   DK_SPOKE_API_KEY on DK + INSERT the four PAR-side rows."
3. Task's "Send to PAR" button stays available (the local row is
   unchanged; `par_task_id` is still null).

If `dk_config.par_franchise_org_id` is null (only true for a brand-new
DK install pre-handshake), the toast also lists `config:
dk_config.par_franchise_org_id`.

## 6. End-to-end PAR push (after T17b)

After `DK_SPOKE_API_KEY` is set on DK + the four PAR-side rows exist
(`spokes`, `spoke_api_keys`, `spoke_installations`, `spoke_capabilities`
— see Prereqs § 0):

1. Tasks tab → "Send to PAR" on a task that hasn't been sent.
2. Toast: "Sent to PAR".
3. Card replaces the button with "→ PAR ✓" badge.
4. SQL spot-check on DK:

   ```sql
   select id, par_task_id from public.tasks where par_task_id is not null;
   -- par_task_id is a uuid pointing at PAR's public.tasks row
   ```

5. SQL spot-check on PAR (use PAR project's SQL editor):

   ```sql
   select id, title, project_name, external_ref
   from public.tasks
   where external_ref = '<dk-task-id>';
   -- Expect: 1 row, title matches, project_name = "DK: Charleston" or "DK Engagement: …",
   -- external_ref is the DK uuid.
   ```

6. Idempotency: click "Send to PAR" again on the *same* task. The button
   is already gone (replaced by the badge), but exercising the function
   directly:

   ```js
   await sb.functions.invoke("dk-create-par-task", { body: { task_id: "<dk-task-id>", title: "..." } });
   // Expect: 200 with { par_task_id, idempotent: true }
   // PAR is NOT called again.
   ```

## 7. Engagement-doc YAML import

Tasks tab → "📥 Import engagement doc" → paste:

```yaml
---
engagement: sharon-test
review_date: 2026-05-07
weight_pain: 5
---
workstreams:
  - id: hire-admin
    title: Hire first part-time admin
    rationale: Spine of the engagement
    owner: Sharon
    tasks:
      - { id: jd-draft, title: "Draft JD", due: 2026-05-14 }
      - { id: jd-post, title: "Post role", due: 2026-05-21 }
  - id: turn-on-tools
    title: Connect Meta + Mailchimp
    tasks:
      - { id: meta-app, title: "Create Meta App + set 3 env vars", due: 2026-05-14 }
      - { id: mc-connect, title: "Paste Mailchimp API key", due: 2026-05-14 }
```

Click Import. Expect status: "Imported: 4 new, 0 updated."

Tasks tab now shows a "DK Engagement: sharon-test" group with 4 tasks.
Each task's `external_ref` matches its YAML `id`.

**Re-import (idempotency)**: change one of the titles in the YAML, click
Import again. Expect: "Imported: 0 new, 4 updated." The task with the
edited title now reflects the new title; a new row was NOT created.

## 8. Realtime + concurrent admin

In two browser windows side by side:

1. Window A creates a new task.
2. Window B sees the row appear within ~300ms (the realtime debounce).
3. Window B flips status; Window A's bento updates.
4. Window A clicks "Send to PAR"; Window B's card flips to the
   "→ PAR ✓" badge.

## 9. Known follow-ups (NOT in T17a)

- **T17c — status round-trip.** PAR webhook → DK endpoint keyed on
  `external_ref`. When PAR closes a task, DK auto-marks done. Same
  open question Margin punted on.
- **YAML decisions + weight_ledger.** The importer parses
  `workstreams[].tasks[]` only. Documents with `decisions:` or
  `weight_ledger:` sections are silently ignored (no schema for them
  yet). If you want either as a first-class surface (Decisions section
  in Tasks tab; "Off your plate" Reports entry per CLAUDE.md §4.33
  "Out of scope for v1"), open a T17a-4 phase with their own tables.
- **Owner profile dropdown for teachers.** `state.profiles` is loaded
  via SELECT which is widened to admins+managers via T6d's
  `profiles_admin_read`. A teacher creating a task locally (they can't,
  no top tab) wouldn't see other profiles in the dropdown. Not a v1
  problem since teachers don't reach the editor.

## 10. Rollback

The migration is additive — no destructive changes to existing
tables. Rolling back is one drop:

```sql
begin;
drop table if exists public.tasks cascade;
drop type if exists public.task_status;
drop type if exists public.task_priority;
drop function if exists public.set_task_status(uuid, public.task_status);
-- has_permission() needs manual restoration: re-apply
-- migrations/phase_t10_inventory.sql which contains the previous
-- (pre-manage_tasks) version of the function.
commit;
```

Then revert the three T17 commits on `main`.
