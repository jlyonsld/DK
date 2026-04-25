# Phase T5c — Watermarked viewer + signed-URL Edge Function + audit log — verification

End-to-end test plan for the curriculum-watermarking + audit feature shipped
in:

- `migrations/phase_t5c_curriculum_audit.sql` (in-repo)
- `edge-functions/curriculum-fetch/index.ts` (parent folder, deployed via
  the Supabase MCP `deploy_edge_function` or
  `npx supabase functions deploy curriculum-fetch --project-ref
  ybolygqdbjqowfoqvnsz`)
- `app.js` `openCurriculumWatermarkedViewer` + `renderPdfIntoContainer` +
  `installCurriculumViewerSuppression` + `openCurriculumPreview`
- `index.html` PDF.js script tag + `cu_previewBtn` + viewer modal stage
- `styles.css` `.cur-viewer-stage` + `.cur-viewer-watermark*`

Run against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) and the live
Vercel deploy (`https://dk-green.vercel.app`) after applying the migration
and deploying the function.

This doc assumes you already have:

- A super_admin DK profile (the curator).
- At least one teacher with a DK profile and a matching `teachers.email` row.
- A T5b assignment between a curriculum item and that teacher in a
  recurring class (so `nextSessionDateForClass` returns a real date).
- At least one bucket-stored curriculum item of each type you want to test:
  one `pdf`, one `image`, ideally one `video`. (Skip a type if you don't
  have that asset on hand — the test plan is per-type independent.)

---

## 1. Migration spot-check

Apply via Supabase MCP `apply_migration` or paste the contents of
`migrations/phase_t5c_curriculum_audit.sql` into the SQL editor.

```sql
-- Table exists, RLS enabled.
select tablename, rowsecurity
  from pg_tables
  where schemaname = 'public' and tablename = 'curriculum_access_log';
-- Expect: rowsecurity = true.

-- Indexes
select indexname from pg_indexes
  where schemaname = 'public' and tablename = 'curriculum_access_log'
  order by indexname;
-- Expect: pkey, item_idx, assignment_idx, teacher_idx, accessed_at_idx.

-- Exactly ONE policy exists, and it's a SELECT (no insert/update/delete).
select polname, polcmd
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'curriculum_access_log';
-- Expect 1 row: curriculum_access_log_select_admin / r.

-- Realtime publication includes the new table.
select tablename from pg_publication_tables
  where pubname    = 'supabase_realtime'
    and schemaname = 'public'
    and tablename  = 'curriculum_access_log';
-- Expect 1 row.
```

---

## 2. Edge Function deploy + smoke test

Either deploy via the Supabase MCP `deploy_edge_function` (already done as
part of T5c) or:

```bash
cd "/Users/jasonlyonsdesign/Documents/Claude/Projects/DK Optimization/edge-functions"
npx supabase functions deploy curriculum-fetch --project-ref ybolygqdbjqowfoqvnsz
```

Note: if the local `supabase` CLI complains about `supabase/functions/...`,
the MCP path is the simpler route. The function's source-of-truth is
`edge-functions/curriculum-fetch/index.ts` in the parent folder per
CLAUDE.md §3.

### 2a. Curl from a teacher session

In the browser console while signed in as the assigned teacher, grab the
JWT:

```js
const { data: { session } } = await window.__dk_supabase.auth.getSession();
copy(session.access_token);
```

Then in a terminal:

```bash
JWT='<paste>'
ASSIGN='<assignment_id_for_a_pdf_item_with_a_passed_lead_window>'

curl -sS -X POST \
  https://ybolygqdbjqowfoqvnsz.supabase.co/functions/v1/curriculum-fetch \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "{\"assignment_id\":\"$ASSIGN\",\"kind\":\"view\"}" | jq
```

Expect a JSON response:

```json
{
  "url": "https://...supabase.co/storage/v1/object/sign/curriculum-assets/pdf/...",
  "expires_at": "2026-...",
  "item_meta": { "id": "...", "title": "...", "asset_type": "pdf", "dk_approved": ..., "description": ... }
}
```

The `url` should resolve to the actual file with `curl -I` (HTTP 200).

### 2b. Locked-assignment refusal (the layered check)

Pick an assignment whose lead window has NOT elapsed yet (or set
`lead_days_override = 0` and confirm the next session is at least 1 day
out). Same curl:

```bash
curl -sS -X POST .../curriculum-fetch ... -d "{\"assignment_id\":\"$LOCKED\",\"kind\":\"view\"}" | jq
```

Expect HTTP 403 with body like:

```json
{ "error": "Locked — unlocks in 6d (next session 2026-05-04)",
  "lead_days": 7, "next_session": "2026-05-04", "days_until_unlock": 6 }
```

This is the second layer of the lead-window enforcement (CLAUDE.md §4.22)
— the client UI is the first; the audit log is the third.

### 2c. Wrong-teacher refusal

As a different teacher (or admin who is NOT the assignment's teacher),
curl with a peer teacher's `assignment_id`. Expect HTTP 403:

```json
{ "error": "This assignment is not yours" }
```

### 2d. Admin preview

As super_admin, grab a JWT and POST `kind: "preview"` with an `item_id`
of a bucket-stored item:

```bash
curl -sS -X POST .../curriculum-fetch ... -d "{\"item_id\":\"$ITEM\",\"kind\":\"preview\"}" | jq
```

Expect 200 with the same shape as 2a. As a teacher (who lacks
`edit_curriculum`/`assign_curriculum`), the same call returns 403.

---

## 3. Audit log append-check

Each successful call from §2 must have inserted a `curriculum_access_log`
row. As super_admin in the SQL editor:

```sql
select id, access_kind, curriculum_item_id, curriculum_assignment_id,
       teacher_id, user_id, storage_path, signed_url_ttl_seconds,
       client_ip, user_agent, accessed_at
  from curriculum_access_log
  order by accessed_at desc
  limit 10;
```

Expect:

- `access_kind = 'view'` for the §2a call, with `curriculum_assignment_id`
  populated and `teacher_id` matching the assignment's teacher.
- `access_kind = 'preview'` for the §2d call, with
  `curriculum_assignment_id = null`.
- `signed_url_ttl_seconds = 300`.
- `user_agent` populated (curl's User-Agent or the browser's, depending on
  source).
- `client_ip` populated when the request went through the Supabase edge.
- The 403 calls (§2b / §2c) should have NOT inserted rows — only successful
  signed-URL mints log.

**Permission check:** sign in as the teacher and run the same
`select … from curriculum_access_log …`. Expect 0 rows (RLS blocks SELECT
for non-admin).

---

## 4. Watermarked viewer (browser)

### 4a. Teacher view path

Sign in as the assigned teacher (T5b's "Your curriculum" card visible on
Home). Click **View** on an unlocked PDF item.

Expect:

- The viewer modal opens with title = item title.
- The PDF renders page-by-page in a scrollable dark-background canvas
  region. Try scrolling — every page should be visible.
- A diagonal (-22°) tiled watermark overlays the entire viewer at low
  opacity, repeating the user's name + email + ISO timestamp + class
  name. The text should be legible if you stare at it but recede when
  reading the PDF.
- **Watermark must NOT capture pointer events** — scrolling the PDF
  region works, the Done button works, the overlay click-to-close (if
  configured) still works.
- Right-click anywhere in the modal: nothing happens (no context menu).
- Try to select text: blocked.
- Cmd/Ctrl-C: blocked.
- Cmd/Ctrl-S: browser save dialog should NOT appear inside the modal.
- Cmd/Ctrl-P: blocked.

Repeat for an `image` item — expect the image rendered centered, with the
watermark tiled across.

Repeat for a `video` item — expect a native `<video>` with controls but
**no download / picture-in-picture** button (controlsList honored), with
the watermark tiled across the video frame.

### 4b. Suppression cleanup

Close the viewer (Done button or ✕ or backdrop click). Then anywhere
else on the page:

- Right-click: context menu should appear normally.
- Cmd/Ctrl-C: copy works (e.g., a bit of selected text in the bento).
- Try to select text: works.

If any of these stay blocked, the suppression handlers leaked — check
that `removeCurriculumViewerSuppression` ran in `closeCurriculumViewer`.

### 4c. Locked item from the UI

Pick an assignment whose lock chip says "🔒 Unlocks in Nd". The View
button should not appear. If you bypass via console
(`openCurriculumViewer('<id>')`), the function's 403 should land in the
modal stage as "Locked — unlocks in Nd …" text. (The client also
short-circuits before calling the function, so the 403 path only fires
when client and server disagree.)

---

## 5. Admin preview path

Sign in as super_admin. Open the **Curriculum** tab → click **Edit** on
any saved bucket-stored item (pdf/video/image with a real upload).

Expect:

- The edit modal shows a new **Preview (watermarked)** button between
  Archive and Cancel.
- Click it. The viewer modal opens with the same watermarked rendering
  as the teacher path. Watermark text reads
  `<curator name> · <curator email> · <timestamp> · Curator preview · audit-logged`.
- The audit log gains a row with `access_kind = 'preview'` and
  `curriculum_assignment_id = null`. The `user_id` is the curator's
  profile id; `teacher_id` is null unless the curator also has a
  `teachers.email` row matching their JWT email (in which case it's the
  match — fine, harmless).

Edge cases:

- Open Edit for a `link` or `script` item. The Preview button should be
  hidden (only relevant for bucket-stored types).
- Open New (no saved item yet). The Preview button should be hidden (no
  storage_path).

---

## 6. Storage bucket reads still blocked

Repeat the bucket-direct-fetch check from §7 of `T5B_VERIFICATION.md` to
confirm T5c didn't accidentally widen storage access. As the assigned
teacher in the browser console:

```js
await window.__dk_supabase.storage
  .from("curriculum-assets")
  .download("<storage_path_from_an_assigned_item>");
```

Expect: 401 / RLS error / empty body. The Edge Function's signed URL
remains the ONLY path to bucket content. If a SELECT policy got added to
`storage.objects` for the `curriculum-assets` bucket, **revert it** —
CLAUDE.md §4.22 / §5 forbid that policy.

---

## 7. Realtime audit feed (optional sanity)

`curriculum_access_log` is in the `supabase_realtime` publication, so a
super_admin tab can subscribe to it. Optional: open browser devtools as
admin and run:

```js
const ch = window.__dk_supabase
  .channel("audit-test")
  .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "curriculum_access_log" },
      (p) => console.log("audit row:", p.new))
  .subscribe();
```

Then have a teacher click View on an unlocked PDF in another browser.
Within ~300ms the admin's console logs the new row.

This isn't surfaced in any UI yet — it's for a future "Curriculum
access" admin report. Cleanup:
`window.__dk_supabase.removeChannel(ch)`.

---

## 8. Cleanup

The migration is permanent. The audit log grows unbounded — fine for
v1 since insert volume is low (one row per fetched signed URL, and
signed URLs cache for 5 min on the client side). If volume ever
matters, add a nightly pg_cron purge of rows older than N days.

If you seeded preview rows during testing, they'll show up alongside
real ones — they're harmless to leave but you can DELETE specific
test rows as super_admin via SQL.
