# T18 Verification — templates + infographics publish workflow

> Draft / published / archived workflow on `templates` and `infographics`.
> Picker contexts (leads reply modal, Templates tab infographics sidebar)
> hide drafts AND archived entirely. See CLAUDE.md §4.34.

## 0. Prereqs

- `migrations/phase_t18_publish_status.sql` applied to DK (`ybolygqdbjqowfoqvnsz`).
- Hard reload after deploy so the new `app.js` / `styles.css` / `index.html`
  are loaded (DK has no build step; cache-bust by reloading).
- Sign in as a super_admin AND have at least one other role available
  (manager or teacher) for the role-gating spot-checks in §5.

## 1. Migration spot-checks

```sql
-- Enum exists with three values
select unnest(enum_range(null::content_status))::text as v;
-- Expect: draft, published, archived (in that order).

-- Both tables carry the new columns
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('templates','infographics')
   and column_name in ('status','published_at','published_by')
 order by table_name, column_name;
-- Expect: 6 rows. status NOT NULL with default 'draft'::content_status.
--         published_at + published_by both nullable.

-- Indexes exist
select indexname
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('templates_status_idx','infographics_status_idx');
-- Expect: 2 rows.

-- Backfill: every existing row landed in draft
select status, count(*) from public.templates group by status;
select status, count(*) from public.infographics group by status;
-- Expect: all rows in 'draft' immediately post-migration. NULL count = 0.
```

## 2. Visibility — the safety property

**This is the entire point of T18.** Every check in this section must pass.

1. Sign in as super_admin (or admin/manager — anyone with `respond_to_leads`).
2. Open **Templates** tab. Confirm every existing template renders with an
   amber "Draft" pill next to the category badge. The status filter chips
   below the category chips show `All (N) · Drafts (N) · Published (0) ·
   Archived (0)` immediately after migration.
3. Open the **Leads** tab. Pick any lead → click **Reply**.
4. Click the template select dropdown.
   - **Expected:** the dropdown is empty (or shows only "— Pick a template —"). No drafts appear, even though the Templates tab is full of them.
5. Scroll down to the infographic attach strip below the editor.
   - **Expected:** "No published infographics. Templates → 🖼 Manage infographics → publish a draft." appears in place of the usual tile grid.
6. Close the modal. Back on the Templates tab, open the infographics sidebar.
   - **Expected:** sidebar count reads `0` and the grid is empty (or shows the "no images" empty state).

If any draft appears in any of those three picker surfaces, the visibility
filter is broken. STOP and fix before continuing — this is the load-bearing
safety property.

## 3. Per-row review flow (quick-toggle)

1. On the Templates tab, find a Draft card.
2. Click the **✓** button in the card-actions row (left of ✎ Edit).
   - **Expected:** toast "Template published". Card now shows a green "Published" pill. The toggle button changes to **↩** with title "Unpublish".
3. Re-open the Leads → Reply modal. Template dropdown now shows that template
   (grouped by category). Infographic strip still empty.
4. Repeat the publish action on one infographic via the **Manage infographics**
   modal (Templates tab → 🖼 Manage infographics → row's ✓ Publish button).
5. Verify the published infographic now appears in:
   - The Templates-tab sidebar (with its tag chip restored).
   - The Leads → Reply infographic attach strip.
6. Click **↩ Unpublish** on the same infographic in the manage modal.
   - **Expected:** "Image draft" toast. Sidebar reverts to empty. Leads-reply
     strip reverts to empty. Status pill flips back to amber Draft.

## 4. Audit field correctness

```sql
-- Publish one specific template in the UI, then check the row:
select status, published_at, published_by
  from public.templates
 where id = '<the id you published>';
-- Expect: status='published', published_at within the last minute,
--         published_by = your profile id.

-- Unpublish it via the ↩ button. Re-check:
select status, published_at, published_by
  from public.templates
 where id = '<same id>';
-- Expect: status='draft', published_at IS NULL, published_by IS NULL.
--         Audit fields CLEARED on transition away from published.
```

## 5. Bulk publish — super_admin only

1. Sign in as super_admin. Open Templates tab.
2. Confirm the **↑ Publish all N drafts** button renders to the left of the
   `+ New template` button (only visible when `N > 0`).
3. Click it. Confirmation prompt names the count.
4. Confirm.
   - **Expected:** toast "Published N templates". Every Draft card flips to
     Published. Draft chip count drops to 0. Bulk button disappears (auto-hide
     when `counts.draft === 0`).
5. Sign out, sign in as **admin** (or manager).
6. Templates tab — confirm the bulk button is NOT visible regardless of
   draft count.
7. Repeat steps 2–6 in the Manage infographics modal.

## 6. Archive flow

1. Open Templates tab. Find a Published card.
2. Click the **↩** quick-toggle to unpublish (draft state needed first since
   quick-toggle doesn't archive directly).
3. Now archive: open the template editor on the same card (✎). [In v1, the
   editor doesn't yet expose a status dropdown — workaround: set status via
   the SQL Editor for now.]
   ```sql
   update public.templates set status='archived' where id='<id>';
   ```
4. Verify: grey "Archived" pill on the card. Card hidden from `Drafts` and
   `Published` filter chips; visible only under `All` and `Archived`.
5. Verify Leads → Reply template picker does NOT show the archived row.
6. On the archived card, click **↻** (Restore).
   - **Expected:** toast "Template draft". Card flips back to Draft.

**Note:** the editor modal's status dropdown is deferred to a follow-up (T18b).
v1 only ships the card-level quick-toggle + sql-level archive. CLAUDE.md
§4.34 calls this out.

## 7. Picker filter for new contexts (forward check)

If you add any new picker surface (e.g. a future Messenger composer for T16b
or a broadcast tool):

- Source from `state.templates.filter(t => t.status === 'published')` or
  `state.infographics.filter(i => i.status === 'published')`, NOT from the
  raw state arrays.
- Greying out unpublished rows with a badge is NOT acceptable — the entire
  T18 contract is that picker contexts physically cannot list drafts or
  archived rows.

## 8. Duplicated templates always start as draft

1. On the Templates tab, find a Published template.
2. Click the **⎘** Duplicate button.
3. Find the new "...(copy)" card.
   - **Expected:** amber Draft pill, regardless of the source's status. The
     duplicate has not been reviewed and shouldn't reach the picker until
     someone explicitly publishes it.

## 9. Edits don't auto-demote (deliberate)

1. Publish a template via ✓ quick-toggle.
2. Open the editor (✎) and change the body text. Save.
3. Re-check the card:
   - **Expected:** card stays Published. `status` and `published_at` unchanged.
4. This is the documented v1 behavior (CLAUDE.md §5 + §4.34 — small-team
   tradeoff). If a future franchise needs auto-demote on edit, add it in
   `saveTemplate()` per the §5 gotcha.

## 10. Realtime spot-check

1. Open the Templates tab in two browsers signed in as different admins
   (or two tabs in incognito).
2. In browser A, click ✓ on a draft card.
3. In browser B, within ~500ms (300ms debounce + render):
   - **Expected:** the same card flips to Published with the green pill,
     no manual refresh.
4. Browser A clicks ↩. Browser B sees the flip back to amber.

## Known follow-ups

- **T18b — status dropdown in the editor modals.** Currently the quick-toggle
  handles draft↔published and archived→draft. Archive requires SQL Editor
  in v1. Add a Status section to `templateModalOverlay` and `igModalOverlay`
  with three radio buttons (Draft / Publish / Archive) so the full status
  graph is achievable from the UI.
- **T18c — designated reviewer permission split.** Currently `edit_templates`
  / `edit_infographics` cover both content edits and the publish toggle.
  If a franchise wants delegated reviewers who can publish but not edit (or
  vice versa), add `publish_templates` + `publish_infographics` permissions
  and re-gate `setTemplateStatus` / `setInfographicStatus` on the new names.
- **T18d — auto-demote-on-substantive-edit.** Diff the pre-edit fields in
  `saveTemplate()` / `saveInfographic()`; if any tracked content field
  changed AND the row was previously published, force `status='draft'` +
  null the audit fields. Documented as a deliberate non-v1 tradeoff in
  CLAUDE.md §5.
