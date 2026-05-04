# T12 — Mailchimp sync (one-way DK → MC + MC webhooks back) plan

**Status:** Spec only — not yet implemented. Awaiting Sharon's Mailchimp API key + audience id + merge-field setup before we build.

**Scope decision (locked):**
1. **Per-franchise audience.** Each PAR DK install points at its own Mailchimp account. No shared audience across franchises. Sharon owns her list.
2. **Trigger granularity:** every `students` INSERT/UPDATE (no JR-vs-dk_local gating). One outbox row per (student, parent_email) pair.
3. **Mailchimp Classic only.** No Mailchimp Transactional / Mandrill in v1.

DK is the system of record for student / enrollment / class data. Mailchimp is the marketing-email send engine. Sync key is `lower(parent_email)`.

---

## 1. What we're NOT syncing

These columns are operational / medical / financial and MUST NEVER ship to Mailchimp. Encode as a `MC_NEVER_SYNC` constant in the Edge Function source so anyone touching the payload can't add them by accident.

- `students.allergies`
- `students.medical_notes`
- `students.authorized_pickup`
- `students.emergency_contact_name`
- `students.emergency_contact_phone`
- `students.emergency_contact_relationship`
- `students.dob`
- Anything from `teacher_payment_details`
- Anything from `liability_waivers` / `liability_waiver_signatures`
- Anything from `teacher_documents`

What MC DOES get: parent first name, parent last name, parent email, child first name, class name, school name, enrollment status (`active` / `lead` / `alumni`), and tags.

---

## 2. Migration: `phase_t12_mailchimp_sync.sql`

```sql
-- Per-franchise MC credentials on the singleton config row.
-- All four are nullable; if mailchimp_api_key is null, the entire feature
-- no-ops gracefully (drain function bails, triggers still enqueue but
-- nothing reads the queue).
alter table dk_config
  add column if not exists mailchimp_api_key text,
  add column if not exists mailchimp_server_prefix text,         -- "us21"
  add column if not exists mailchimp_audience_id text,
  add column if not exists mailchimp_webhook_secret text;        -- random 32-char

-- Subscription state on students. Only the MC webhook writes this column.
-- Default 'pending' matches MC's status_if_new on first upsert.
alter table students
  add column if not exists marketing_status text
    check (marketing_status in ('subscribed','unsubscribed','cleaned','pending'))
    default 'pending',
  add column if not exists marketing_status_updated_at timestamptz;

-- Outbox queue. One row per (student, parent_email). Drained by pg_cron
-- every 60s via dk-mailchimp-drain. Append-only from triggers; the drain
-- function stamps completed_at / attempts / last_error.
create table if not exists mailchimp_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students(id) on delete cascade,
  parent_email citext not null,
  op text not null check (op in ('upsert','archive')),
  enqueued_at timestamptz not null default now(),
  attempted_at timestamptz,
  attempts int not null default 0,
  last_error text,
  completed_at timestamptz
);
create index if not exists mailchimp_sync_outbox_pending_idx
  on mailchimp_sync_outbox (enqueued_at)
  where completed_at is null;

-- Append-only audit. Mirrors sync_log pattern.
create table if not exists mailchimp_sync_log (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('outbound','inbound')),
  event text not null,
  parent_email citext,
  student_id uuid,
  status int,
  payload jsonb,
  error text,
  created_at timestamptz not null default now()
);

-- Trigger: on students INSERT or UPDATE of identity-relevant cols,
-- enqueue one upsert per parent_email.
create or replace function enqueue_mailchimp_sync_for_student() returns trigger
language plpgsql security definer as $$
declare e text;
begin
  if new.parent_emails is null then return new; end if;
  foreach e in array new.parent_emails loop
    if e is null or btrim(e) = '' then continue; end if;
    insert into mailchimp_sync_outbox (student_id, parent_email, op)
      values (new.id, lower(btrim(e)), 'upsert');
  end loop;
  return new;
end$$;

drop trigger if exists students_mc_sync on students;
create trigger students_mc_sync
  after insert or update of first_name, last_name, parent_emails,
                            parent_names, status
  on students for each row
  execute function enqueue_mailchimp_sync_for_student();

-- Trigger: enrollment changes also re-tag the parent (class + status drift).
create or replace function enqueue_mailchimp_sync_for_enrollment() returns trigger
language plpgsql security definer as $$
declare s record; e text;
begin
  select * into s from students where id = coalesce(new.student_id, old.student_id);
  if s.id is null or s.parent_emails is null then return coalesce(new, old); end if;
  foreach e in array s.parent_emails loop
    if e is null or btrim(e) = '' then continue; end if;
    insert into mailchimp_sync_outbox (student_id, parent_email, op)
      values (s.id, lower(btrim(e)), 'upsert');
  end loop;
  return coalesce(new, old);
end$$;

drop trigger if exists enrollments_mc_sync on enrollments;
create trigger enrollments_mc_sync
  after insert or update or delete on enrollments
  for each row execute function enqueue_mailchimp_sync_for_enrollment();

-- pg_cron schedule (idempotent install).
select cron.schedule(
  'dk-mailchimp-drain',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://ybolygqdbjqowfoqvnsz.supabase.co/functions/v1/dk-mailchimp-drain',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || current_setting('app.cron_secret', true),
         'Content-Type', 'application/json'
       )
     ); $$
);
```

**RLS:** outbox + log are admin-read only; no writes from clients (triggers + service-role only). Add policies gated on `is_admin()` for SELECT, no policies for INSERT/UPDATE/DELETE — service-role bypasses RLS in the Edge Function.

---

## 3. Edge Function: `dk-mailchimp-drain`

- **`verify_jwt: false`** — invoked by pg_cron with `X-Cron-Secret` header, not a user JWT (same pattern as `jackrabbit-sync`).
- Read `dk_config` for credentials. If `mailchimp_api_key` is null → return 200 with `{ skipped: 'not_configured' }`.
- Read up to 50 outbox rows where `completed_at is null and attempts < 5` ordered by `enqueued_at`.
- For each row:
  1. Stamp `attempted_at = now()`, `attempts = attempts + 1`.
  2. Resolve student + active enrollment + class + school for tags + merge fields.
  3. Build allow-listed payload (see §4).
  4. `PUT https://<server>.api.mailchimp.com/3.0/lists/<audience>/members/<md5(lower(email))>` with `status_if_new: 'pending'` so MC's existing opt-in flow stays in charge.
  5. `POST .../tags` with `{ tags: [{ name: 'dk-active', status: 'active' }, ...] }` — MC's tag API replaces, not merges, so always send the full set.
  6. On success: `completed_at = now()`. Insert `mailchimp_sync_log` row with status 200.
  7. On failure: write `last_error`, leave `completed_at` null, log inbound `mailchimp_sync_log` row with the error.
- Return summary: `{ processed: N, ok: M, failed: K, skipped: 0 }`.
- **Backoff:** rows with `attempts >= 5` are not retried by the drain. The admin sync-status pill surfaces them as "stuck — review."

### Tags applied per parent

```
dk-<status>                  e.g. dk-active, dk-lead, dk-alumni
class:<slug>                 e.g. class:wando-tk-fri-3pm
school:<slug>                e.g. school:wando-elementary
```

Tag slugs: `lower(replace(replace(name, ' ', '-'), '/', '-'))`. Cap at 60 chars.

---

## 4. Outbound payload (allow-list — exactly these fields, nothing else)

```json
{
  "email_address": "<lowercased parent email>",
  "status_if_new": "pending",
  "merge_fields": {
    "FNAME": "<parent first name>",
    "LNAME": "<parent last name>",
    "STUDENT": "<child first name>",
    "CLASS": "<class name or empty string>",
    "SCHOOL": "<school name or empty string>",
    "STATUS": "active|lead|alumni"
  }
}
```

**`status_if_new: 'pending'`** is the v1 default — MC sends its own confirmation email; we never auto-subscribe. Sharon can flip this to `'subscribed'` later via a `dk_config.mailchimp_double_opt_in` boolean if her MC audience permission is set accordingly.

For multi-parent students, one PUT per parent. Each parent gets their own merge fields (so STUDENT correctly maps to the child the parent is connected to even if both parents share an audience).

---

## 5. Edge Function: `mailchimp-webhook`

- **`verify_jwt: false`** — public; auth is the `?secret=<token>` query param, compared constant-time against `dk_config.mailchimp_webhook_secret`.
- MC POSTs `application/x-www-form-urlencoded`. The relevant `type` values:
  - `subscribe` → `marketing_status = 'subscribed'`
  - `unsubscribe` → `marketing_status = 'unsubscribed'`
  - `cleaned` → `marketing_status = 'cleaned'` (hard bounce / spam complaint)
  - `profile` → no status change, just refresh `marketing_status_updated_at`
  - `upemail` → email change. Update `students.parent_emails` array element by replacing `data[old_email]` with `data[new_email]`. Then enqueue an upsert at the new email.
- Lookup: `update students set marketing_status = ?, marketing_status_updated_at = now() where parent_emails @> array[lower(<email>)]::citext[]`.
- Insert `mailchimp_sync_log` with `direction='inbound'`.
- **Always return 200**, even on lookup failure. MC retries on non-2xx and we don't want stuck queues for a parent who isn't in DK yet (e.g. someone signed up via a Mailchimp form first).

---

## 6. UI surface

**Admin-only `⚙ Mailchimp` button on the Templates tab head** (next to `⚙ Manage categories` and `🖼 Manage infographics`). Visible only to `super_admin` (writes to `dk_config` need RLS gating to super_admin; admin / manager don't see the button).

Modal: `#mailchimpOverlay`

- **Connect section**
  - API key input (paste full key like `abc123-us21`; we parse the suffix on save into `mailchimp_server_prefix`).
  - "Test connection" button → calls a new minimal helper Edge Function `dk-mailchimp-ping` that does `GET /3.0/ping` and returns the audience list.
  - Audience picker (dropdown populated from the ping response).
  - "Save" persists to `dk_config` and rotates `mailchimp_webhook_secret` if it doesn't exist yet.

- **Webhook section**
  - Display the URL for copy: `https://<supabase-ref>.supabase.co/functions/v1/mailchimp-webhook?secret=<value>`.
  - Instructions: "In Mailchimp → Audience → Settings → Webhooks, paste this URL and check all event types."

- **Merge-fields checklist**
  - On modal open, GET `/3.0/lists/{id}/merge-fields`. Compare against the required set: `FNAME`, `LNAME`, `STUDENT`, `CLASS`, `SCHOOL`, `STATUS`.
  - Missing ones render with a "Create" button → POST `/3.0/lists/{id}/merge-fields`.

- **Sync status pill (live)**
  - Rolls up `mailchimp_sync_outbox`: total pending (`completed_at is null and attempts < 5`), failed (`attempts >= 5`), processed in last 24h (`completed_at >= now() - interval '24h'`).
  - "Retry stuck" button → resets `attempts = 0` for the failed rows.

**No new top-level tab.** The integration is a setup-once-then-forget surface; living inside the Templates tab matches the "tools sidebar" mental model.

**Per-template MC sync (Phase 2):** add a "↗ Sync to Mailchimp" button per template card later. Out of scope for v1.

---

## 7. PERM_BUNDLES + has_permission()

**No new permission.** Writes to `dk_config` already gate on `is_super_admin()`. Reading `mailchimp_sync_outbox` / `mailchimp_sync_log` for the status pill gates on `is_admin()`.

If a future split wants to delegate Mailchimp ops to a non-super-admin (e.g. a marketing assistant), introduce `manage_mailchimp` and add it to the bundle — the migration above doesn't preclude that.

---

## 8. Edge cases

- **MC not configured:** triggers still enqueue. Drain returns `{ skipped: 'not_configured' }`. Outbox grows but does no harm. As soon as Sharon connects, the next drain run flushes the backlog.
- **MC API down / 429:** rows retry up to 5 times. After 5, the status pill surfaces them. No automated alerting in v1 — Sharon checks the pill.
- **Parent email change in DK:** UPDATE on `students.parent_emails` enqueues an upsert at the new email. The OLD email remains in MC. Phase 2 may add an `archive` op for emails dropped from the array; v1 leaves them.
- **Parent email change in MC:** `upemail` webhook event. We update the `students.parent_emails` array element to the new value, then enqueue an upsert.
- **Multi-parent families:** one outbox row per parent. Each parent in MC gets their own merge fields (correctly attributed to the child each parent is linked to).
- **Unsubscribed parent re-enrolled:** `marketing_status='unsubscribed'`. Drain checks status before sending and skips (MC would honor it anyway, but skipping saves API calls). When MC sends the subscribe webhook later, status flips back and next drain re-syncs.
- **Student deleted in DK:** `on delete cascade` clears outbox rows. The MC member remains until Sharon archives manually (we don't auto-delete from MC — too easy to lose data Sharon wanted).
- **Webhook secret leaked:** rotate via the Mailchimp settings modal. Old webhook URL stops working immediately.

---

## 9. Out of scope for v1 (deliberate)

- Template push to MC templates API (Phase 2 button per template card; uses MC's `/3.0/templates`).
- Campaign creation from DK ("Send to class" UI; would need `/3.0/campaigns` + audience segment by tag).
- Mailchimp Transactional / Mandrill (paid, separate product).
- Per-class sub-audiences (one audience, tags handle segmentation).
- Inbound lead capture from MC sign-up forms → DK student row (this is the natural extension once Meta→Mailchimp lead-intake is wired).
- Bulk backfill of existing students into MC on first connect (admin can `update students set parent_emails = parent_emails` after connect to retrigger every row, but this isn't surfaced as a button v1).

---

## 10. What we need from Sharon when she's back

- [ ] **Mailchimp API key.** Generate at `https://<server>.admin.mailchimp.com/account/api/`. Paste full key (it embeds the server prefix).
- [ ] **Audience ID.** We surface a picker; she picks her existing DK audience.
- [ ] **Merge fields configured in MC** (the checklist + create-button handles this — but flag it to her so she's not surprised when MC's audience editor shows new fields).
- [ ] **Webhook configured in MC** (Audience → Settings → Webhooks → paste URL, check all event types).
- [ ] **Decide on double opt-in.** v1 sketch uses `pending` (MC sends confirmation). If she wants instant adds, change to `subscribed` and confirm her audience permission allows it.

---

## 11. Build order (when ready)

1. Migration `phase_t12_mailchimp_sync.sql` (schema only — no triggers fire yet because outbox just accumulates).
2. Edge Functions `dk-mailchimp-drain`, `mailchimp-webhook`, `dk-mailchimp-ping`. All three deployed but `drain` no-ops without credentials.
3. UI: `⚙ Mailchimp` button + modal + sync-status pill.
4. Sharon connects (paste API key, pick audience, paste webhook URL, create merge fields, save).
5. First drain run flushes the accumulated backlog from steps 1–4. Watch `mailchimp_sync_log` for errors.
6. Manual smoke test: add a test student in DK with a real parent email, verify MC member appears within 60s with correct tags + merge fields. Subscribe / unsubscribe via MC's UI, verify `students.marketing_status` flips within seconds via the webhook.

---

## 12. Files this will touch

- `migrations/phase_t12_mailchimp_sync.sql` — new
- `edge-functions/dk-mailchimp-drain/index.ts` — new (lives in parent `DK Optimization/edge-functions/` per existing convention OR colocated in repo per T11; pick one before scoping)
- `edge-functions/mailchimp-webhook/index.ts` — new
- `edge-functions/dk-mailchimp-ping/index.ts` — new
- `index.html` — add `#mailchimpOverlay` modal markup
- `app.js` — `state.mailchimpStatus`, `wireMailchimpModal()`, `renderMailchimpStatusPill()`, the connect / save / merge-field-create handlers, plus an `⚙ Mailchimp` button in the Templates tab head with `applyRoleVisibility()` super_admin gating
- `styles.css` — `.mc-pill` (pending / failed / ok variants), modal layout

Estimate: ~2 sessions of work once API key is in hand. Migration + Edge Functions in session 1, UI + status pill + smoke test in session 2.
