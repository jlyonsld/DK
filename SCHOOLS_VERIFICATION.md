# Phase T8 — Schools + class cancellations + notify-daily-contact

End-to-end test plan for `migrations/phase_t8_schools.sql`. Run these
checks against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) and the
live Vercel deploy after applying the migration.

Prereqs:

- A super_admin DK profile (you).
- At least one `classes` row with a non-empty `location` text value (the
  migration's auto-backfill needs something to seed from).
- Optionally, a real second email address you can receive at, for
  testing the mailto: flow end-to-end.

---

## 1. Apply the migration

In the Supabase SQL editor, paste the contents of
`migrations/phase_t8_schools.sql` and run. Whole thing is `begin … commit`.

Spot-check after:

```sql
-- Tables exist + RLS on
select tablename, rowsecurity
  from pg_tables
  where schemaname = 'public'
    and tablename in ('schools','class_cancellations');
-- Both rows: rowsecurity = true.

-- Backfill seeded schools from existing class locations
select count(*) as schools_count from public.schools;
-- Should match the count of distinct non-empty trimmed values from
-- classes.location at the moment you ran the migration.

-- classes.school_id was added and backfilled
select count(*) as linked_classes
  from public.classes
  where school_id is not null;
-- Should match the number of classes whose location matches a school
-- by case-insensitive trimmed name.

-- RPC exists
select proname from pg_proc where proname = 'mark_class_cancellation_notified';
-- One row.

-- Realtime publication
select tablename from pg_publication_tables
  where pubname = 'supabase_realtime'
    and tablename in ('schools','class_cancellations');
-- Two rows.
```

---

## 2. Schools tab — visibility + backfill

Sign in to the deploy and open the **Schools** tab.

| Role         | Schools tab visible | Edit buttons visible |
| ------------ | ------------------- | -------------------- |
| super_admin  | yes                 | yes                  |
| admin        | yes                 | yes                  |
| manager      | yes                 | yes                  |
| teacher      | no                  | n/a                  |
| viewer       | yes                 | no                   |

You should see one card per school auto-created from your existing
class locations. Each card shows the school name, an empty contacts
section, and a class count.

If the migration created N schools and the unlinked-class banner shows
M classes still using free-form locations, M+N should equal the count
of distinct trimmed locations in your classes table.

---

## 3. Add contacts to a school

Click **Edit** on one of the auto-created schools (or **＋ New school**
if you don't have any locations yet).

- Fill in name + address.
- Fill in primary contact (name, role like "Principal", email, phone).
- Click **Copy from primary** — daily-contact fields populate.
- Edit daily contact role to "Front Desk" (so you can tell them apart).
- Save.

The card on the Schools tab should now show both contacts.

---

## 4. Class editor — school dropdown

**Classes** tab → click a class to expand it → click **Edit class**.

- The editor now has a **School** dropdown above the **Location** text.
- Pick the school you just edited; save.
- Confirm the class card on the Classes tab still shows the location
  string (we render `school.name` when `school_id` is set, falling back
  to `cls.location` otherwise — both should agree visually for backfilled
  classes).
- Re-open the editor; the dropdown should be pre-selected.

SQL spot check:

```sql
select id, name, school_id, location from public.classes
  where id = '<your class id>';
-- school_id populated; location still has the original string.
```

Test the unset path: re-open the editor, set School to **(unset)**,
save. The class falls back to displaying `cls.location` everywhere.

---

## 5. Cancel a class session

Click into a class on the **Classes** tab → in the Attendance section,
click **Cancel class**.

- Modal opens with the next class day pre-filled in the banner.
- Type a reason ("Teacher illness, no sub available").
- Click **Cancel class & notify**.
- Toast: "Class cancelled".
- The notify modal opens immediately with subject + body filled in.

In SQL:

```sql
select class_id, session_date, reason, cancelled_at, notified_at
  from public.class_cancellations
  order by cancelled_at desc
  limit 1;
-- New row, notified_at still null at this point.
```

Click **Open in email app** in the notify modal. Your default mail
client should open with `to:`, `subject:`, `body:` pre-filled. Don't
actually send — just confirm the fields look right, then close.

Re-check SQL:

```sql
select notified_at from public.class_cancellations
  order by cancelled_at desc limit 1;
-- Now populated (mark_class_cancellation_notified RPC fired).
```

Switch to the **Schedule** tab → Week or Month view → navigate to that
date. The class block should be muted with a line-through style and a
small ✗ badge in the time row.

In the class detail panel, the action row now shows a **"Cancelled · …
notified ✓"** pill plus **Re-notify school** and **Restore** buttons.

Click **Restore** — confirm the prompt → the cancellation row deletes,
the schedule un-mutes, and the action row goes back to showing
**Cancel class**.

---

## 6. Sub assigned → notify daily contact auto-pop

Open a sub request (Phase T4 flow):

1. Class detail panel → **Request sub** for the next session.
2. As another teacher (or admin), claim it via the Sub requests tab.
3. As admin, click **Pick this teacher**.
4. Toast: "Sub request filled".
5. **~350ms later** the notify modal pops automatically with kind =
   "Sub assigned notification" — pre-filled subject and body referencing
   the assigned teacher and the date.

If the class isn't linked to a school with a daily-contact email, the
modal does NOT auto-pop. Confirm by repeating the test on a class
whose school has no daily contact — toast still appears, modal does not.

You can always trigger the modal manually via the **✉ Notify daily
contact** button on the class detail panel (when the school has a daily
email on file).

---

## 7. RLS spot checks

```sql
-- As a teacher, schools should be readable but not writable.
-- In the teacher's browser console:
window.__dk_supabase.from('schools').select('*').then(console.log)
// Returns rows.

window.__dk_supabase.from('schools').insert({name:'Hack School'}).then(console.log)
// Expect a permission-denied error.

window.__dk_supabase.from('class_cancellations').insert({class_id:'xxx',session_date:'2026-04-26'}).then(console.log)
// Expect a permission-denied error.
```

---

## 8. Realtime sanity

Open two browsers signed in as different roles. As admin, save a school
on side A. Side B's Schools tab should reflect the change within ~300ms
(the realtime debounce window). Ditto for cancelling a class — side B's
Schedule and class detail panel should update without a manual refresh.

Browser console should report:
```
[realtime] subscribed to N tables
```
where N = 20 (was 18 in T4).

---

## 9. Class editor → save without a school

- Open a class editor, **(unset)** the school dropdown, save.
- Confirm the class card now displays only the free-form location
  string (no school link).
- Confirm the next session's **Cancel class** action still works
  (cancellation isn't gated by school presence).
- Confirm the **✉ Notify daily contact** button is hidden for that
  class (no daily email available without a school).

---

## 10. Done — restore test data

If you cancelled real classes for testing, delete those rows:

```sql
delete from public.class_cancellations where reason = 'TEST';
```

Or use the **Restore** button on each cancelled class panel.

If you created throwaway "Hack School" entries from the RLS test, delete
them via the school editor's Delete button.

That's it — Phase T8 is verified.
