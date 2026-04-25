# Phase T5b — Curriculum assignments + teacher view + teacher notes — verification

End-to-end test plan for the assignment + teacher-card + notes feature
shipped in `migrations/phase_t5b_curriculum_assignments.sql`. Run these
checks against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) and the
live Vercel deploy (`https://dk-green.vercel.app`) after applying the
migration.

This doc assumes you already have:

- A super_admin DK profile.
- At least one active `teachers` row with `email` populated, AND that
  teacher has signed into DK at least once so they have a DK profile
  with `role = 'teacher'`.
- At least one `classes` row that the teacher is assigned to via
  `class_teachers` (any role).
- T5a applied: at least one `curriculum_items` row of each type you
  want to test (link + script are the most useful for T5b — pdf/video/
  image still defer to T5c's viewer).

---

## 1. Apply the migration

In the Supabase SQL editor (DK project), paste the contents of
`migrations/phase_t5b_curriculum_assignments.sql` and run. The whole
thing is a `begin … commit` block.

Spot-check after:

```sql
-- Table exists, RLS on, indexes there.
select tablename, rowsecurity
  from pg_tables
  where schemaname = 'public' and tablename = 'curriculum_assignments';
-- Expect: rowsecurity = true.

select indexname from pg_indexes
  where schemaname = 'public' and tablename = 'curriculum_assignments';
-- Expect: pkey + 3 idx (item, class, teacher) + the unique constraint.

-- Policies are present on both tables.
select polname, polcmd
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'curriculum_assignments'
  order by polname;
-- Expect 5 rows: select_admin, select_teacher, insert, update, delete.

select polname from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'curriculum_items'
  order by polname;
-- Expect curriculum_items_select_admin AND curriculum_items_select_teacher.

-- The notes RPC exists and is security definer.
select prosecdef, proname
  from pg_proc
  where proname = 'set_curriculum_assignment_notes';
-- Expect prosecdef = true.

-- Realtime publication includes the new table.
select tablename from pg_publication_tables
  where pubname = 'supabase_realtime'
    and schemaname = 'public'
    and tablename = 'curriculum_assignments';
-- Expect 1 row.
```

---

## 2. Admin: assign a curriculum item

As super_admin / admin / manager (anyone with `assign_curriculum`):

1. Navigate to **Curriculum** tab. Confirm each row now shows a
   `👥 0 assigned` chip and an **Assign…** button next to **Edit**.
2. Click **Assign…** on any non-archived item. The modal opens with
   the title "Assign · _item title_" and shows the item's
   `default_lead_days` value in the helper text.
3. The "Current assignments" list reads "No assignments yet."
4. Pick a class from the **Class** dropdown. The **Teacher** dropdown
   should immediately narrow to teachers actually linked to that
   class via `class_teachers`. If no teachers are linked, you see a
   disabled hint option directing you to the Classes tab.
5. Pick a teacher. Leave **Lead-day override** blank. Optionally type
   a curator note like "Use the warmup pages only with the older
   cohort." Click **+ Add assignment**.
6. The form clears, the assignment appears in "Current assignments"
   showing `Class → Teacher`, the lead-time line reads `Nd (default)`,
   and the curator note is shown below.
7. The Curriculum tab's per-row chip now shows `👥 1 assigned`.
8. Click **Remove** on the assignment row, confirm the prompt — the
   row disappears, the chip drops back to `0`.
9. Re-add the assignment so the next sections have data.

Try the override:

10. Open the same item's Assign… modal again. Add a second
    assignment to a different class+teacher with `Lead-day override = 0`.
    The list should show `0d (override)` for the new row.

Permission spot-check:

11. Sign in as a **viewer** role profile. The Curriculum tab is
    hidden entirely (still gated by `ROLE_TAB_VISIBILITY`).
12. Sign in as a **teacher** role profile. The Curriculum tab is
    hidden. The new **Your curriculum** card on Home should appear
    instead (next section).

---

## 3. Teacher: view assigned items + lock/unlock chips

Sign in as the teacher who got the assignment in §2.

1. The Home bento has a new **Your curriculum** card spanning the
   full row width. Subheading reads `N items assigned`.
2. Items are grouped by class — the class name + location appear
   above each group.
3. Each item shows: type icon, title, type pill, optional ✓ DK
   approved badge, and a lock/unlock chip:
   - **🔓 Available now** (green): if today is on or after
     `next session date − leadDays`.
   - **🔒 Unlocks in Nd** (orange): with the day countdown.
   - **No upcoming session** (grey): if the class has no class day in
     the next 60 days.
4. The curator note from step 2.5 (if you added one) shows as
   `From Sharon: …` below the title.
5. A **My notes** textarea appears on every row, initially empty.

Lead-window math:

6. To force-unlock an item that's currently locked, set its override
   to `60` (max) via the Assign… modal as admin, then refresh the
   teacher's home — chip flips to **Available now**. Reset to your
   real value after.
7. To force-lock an unlocked item, set the override to `0` AND
   confirm the next session is at least 1 day out — chip flips to
   **🔒 Unlocks in Nd**.

---

## 4. Teacher: open a curriculum item (T5b types only)

For a `link`-type unlocked assignment:

1. Click **View**. A new tab opens to `external_url`. (If the item
   has no `external_url`, you get a "Link is missing a URL" toast.)

For a `script`-type unlocked assignment:

2. Click **View**. The Curriculum viewer modal opens. The script
   content renders in a serif body with line breaks preserved. The
   meta line at bottom reads `Script · <class> · DK approved` (or
   blank if not approved).
3. Click **Done** or the overlay to close.

For a `pdf`, `video`, or `image`-type unlocked assignment:

4. Click **View**. The Curriculum viewer modal opens with a stub
   reading "📦 PDF/Video/Image viewer ships in Phase T5c." This is
   intentional — the watermarked viewer is T5c's deliverable.

Lock-bypass attempt:

5. Manually mutate the DOM `data-cur-view` value or call
   `openCurriculumViewer(<assignment_id>)` from the console for a
   **locked** assignment. The viewer refuses to open and toasts
   "Locked — unlocks in Nd". (RLS still allows SELECT on the
   assignment row; the lock check is the second layer that runs
   before the modal opens. T5c will add a third layer in the Edge
   Function.)

---

## 5. Teacher notes (the "travels with curriculum" piece)

Still as the teacher:

1. Type a note into **My notes** on any row, e.g. "Cohort A loved
   page 3 warmup; skipped page 4."
2. Click **Save notes**. Toast reads "Notes saved." The label above
   the textarea now shows "Saved Xs ago" in green.
3. Reload the page. The note persists.
4. Open a different class's row for the same teacher — notes are
   **independent** per (item, class, teacher). The note from class
   A does not show on class B's view of the same item. (This is
   intentional: cohorts diverge fast; per-class notes are what
   teachers actually want.)
5. Sign in as super_admin in another browser. Open the SQL editor:

   ```sql
   select id, class_id, teacher_id, teacher_notes,
          teacher_notes_updated_at
     from curriculum_assignments
     where teacher_notes is not null
     order by teacher_notes_updated_at desc;
   ```

   The note is visible to admins (assign_curriculum SELECT path) so
   Sharon can read teacher feedback. **Admins should not write to
   `teacher_notes` directly** — there's no UI for it; doing so via
   raw SQL works but is off-pattern.

Permission spot-check on the RPC:

6. As super_admin, attempt to call the RPC against another teacher's
   assignment:

   ```sql
   select set_curriculum_assignment_notes(
     '<assignment_id_for_a_different_teacher>'::uuid,
     'admin override attempt'
   );
   ```

   Expect: `ERROR: You can only edit your own assignment notes`.
   (Super_admin doesn't pass the identity check inside the function
   unless they themselves are also a teacher matching that
   assignment — by design.)

7. As a teacher, attempt to UPDATE the assignment's `teacher_id` or
   `lead_days_override` directly:

   ```sql
   update curriculum_assignments
     set lead_days_override = 0
     where id = '<my_assignment_id>';
   ```

   Expect: 0 rows updated (RLS denies — `assign_curriculum`-gated
   UPDATE policy is the only path, and teachers don't hold that
   permission).

---

## 6. Realtime: live updates across devices

1. Open Home as the teacher in browser tab A.
2. In a separate tab B as admin, add a new assignment for that same
   teacher to a class they're already on.
3. Within ~300ms tab A's **Your curriculum** card re-renders with
   the new item. (Realtime channel subscribes to
   `curriculum_assignments`.)
4. In tab B, remove the assignment. Tab A's card removes the row in
   the same way.

---

## 7. Storage bucket reads still blocked

The widened SELECT on `curriculum_items` is row-level metadata only.
The private `curriculum-assets` bucket has no SELECT policy — that
remains intentional per CLAUDE.md §4.22 / §5.

Verify:

1. Sign in as the teacher and open the browser console.
2. Try to fetch a `pdf`-type item's storage_path via the JS SDK:

   ```js
   await window.__dk_supabase.storage
     .from("curriculum-assets")
     .download("<storage_path_from_an_assigned_item>");
   ```

   Expect: an RLS error / 401 / empty body. T5c's
   `curriculum-fetch` Edge Function will be the only path; it uses
   the service-role key to bypass RLS after verifying the
   assignment + lead-window, and writes a row to
   `curriculum_access_log`.

---

## 8. Cleanup

The realtime publication is permanent; no cleanup needed.

If you seeded throwaway assignments during testing, remove them as
admin via the Assign… modal's per-row **Remove** button (or via SQL
DELETE — no cascade beyond the assignment row itself; the curriculum
item and class/teacher rows remain untouched).
