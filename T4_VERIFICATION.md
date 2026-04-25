# Phase T4 — Sub requests / shift trades — verification

End-to-end test plan for the sub-request feature shipped in
`migrations/phase_t4_sub_requests.sql`. Run these checks against the DK
Supabase project (`ybolygqdbjqowfoqvnsz`) and the live Vercel deploy
(`https://dk-green.vercel.app`) after applying the migration.

This doc assumes you already have:

- A super_admin DK profile (you, probably).
- At least 2 active `teachers` rows with `email` populated, and at least
  one of those teachers signed in to DK via magic link so they have a DK
  profile with `role = 'teacher'`.
- At least one `classes` row with both teachers assigned in
  `class_teachers` (any role — primary, sub, co-teacher).

If you don't have a second teacher account handy, a super_admin can play
the second teacher's role by temporarily setting `profiles.role` to
`teacher` for a side account.

---

## 1. Apply the migration

In the Supabase SQL editor (DK project), paste the contents of
`migrations/phase_t4_sub_requests.sql` and run. The whole thing is a
`begin … commit` block — nothing partially-applied if anything fails.

Spot-check after:

```sql
-- Tables exist and are RLS-enabled
select tablename, rowsecurity
  from pg_tables
  where schemaname = 'public'
    and tablename in ('sub_requests','sub_claims');
-- Both rows should show rowsecurity = true.

-- has_permission() includes the new perms for the right roles
select has_permission('claim_sub_requests'),
       has_permission('manage_all_sub_requests'),
       has_permission('request_sub');
-- As a super_admin → t/t/t.
-- As a teacher    → t/f/t.
-- As a manager    → t/t/f.
-- As a viewer     → f/f/f.

-- Realtime publication includes the new tables
select tablename
  from pg_publication_tables
  where pubname = 'supabase_realtime'
    and tablename in ('sub_requests','sub_claims');
-- Two rows expected.

-- RPCs exist
select proname from pg_proc
  where proname in (
    'create_sub_request','create_sub_request_for',
    'claim_sub_request','withdraw_sub_claim',
    'fill_sub_request','cancel_sub_request'
  );
-- Six rows expected.
```

---

## 2. Tab visibility

Sign in as each role and confirm the **Sub requests** tab is present in
the top tabs and (on mobile / ≤720px) inside the Tools bottom sheet.

| Role         | Sub requests tab visible | Filter chips visible |
| ------------ | ------------------------ | -------------------- |
| super_admin  | yes                      | Open · Mine · All    |
| admin        | yes                      | Open · Mine · All    |
| manager      | yes                      | Open · Mine · All    |
| teacher      | yes                      | Open · Mine          |
| viewer       | yes                      | Open · Mine          |

The "+ Request a sub" button is visible to anyone with `request_sub`
**or** `manage_all_sub_requests` — viewers see no button, everyone else
does.

---

## 3. Create a sub request — happy path

Sign in as the teacher. Go to **Classes** → click a class you teach →
in the Attendance section, click **Request sub**.

- The modal pre-fills with that class and the next class-day on the
  calendar.
- Enter a reason ("Doctor's appointment" or whatever) and click
  **Open request**.
- Toast: "Sub request opened".
- Sub requests tab now shows the new row under **Open**.

Spot-check the row in SQL:

```sql
select id, class_id, session_date, requested_by_teacher_id,
       created_by_user_id, status, reason
  from public.sub_requests
  order by created_at desc
  limit 1;
-- status = 'open', requested_by_teacher_id matches your teachers.id,
-- created_by_user_id = auth.uid().
```

Without leaving the class detail panel, refresh the page — the
"Request sub" button should now be replaced by a status pill reading
"Sub request open · {date}". Click the pill — it should jump to the
Sub requests tab.

---

## 4. Open the schedule and confirm the badge

Switch to the **Schedule** tab → **Week** view → navigate to the week
that contains the open request's session_date. The class block on
that day should carry a 🔄 badge inline with the time. Switch to
**Month** view — the row for that class on that day should also show
🔄 (between the class name and teacher initials).

If the badge doesn't appear, check the browser console for a render
error and confirm `state.subRequests` is populated:

```js
window.__dk_supabase  // should exist
// In DevTools console:
window.__dk_supabase
// then in the same console (after reloadAll):
// Inspect the subRequests via a manual select:
window.__dk_supabase.from("sub_requests").select("*").then(console.log)
```

---

## 5. Claim the request — second teacher

Sign in as a different teacher (use an incognito window if you only
have one machine). Go to **Sub requests** — the open request from
step 3 should be visible (RLS lets every signed-in role see open
requests). The card should show:

- Class name + session date
- Requester name
- A green **"Offer to cover"** button

Click **Offer to cover**. A `prompt()` asks for an optional note —
type one or leave blank, hit OK. Toast: "Offer sent — admin will
review".

In the original (super_admin / admin) tab, the same card should
update within ~300ms (realtime debounce) to show the new claim under
**Offers (1)** with status `pending`. If realtime is flaky, click
the tab again to force `renderAll`.

SQL spot-check:

```sql
select sub_request_id, claimed_by_teacher_id, status, note, created_at
  from public.sub_claims
  order by created_at desc
  limit 1;
-- status = 'pending', claimed_by_teacher_id matches teacher #2.
```

Try claiming the **same** request a second time as the same teacher
(just re-click Offer). The migration's `ON CONFLICT … DO UPDATE`
should leave you with one row, status still `pending`, with the
new note replacing the old one.

---

## 6. Fill the request — admin chooses the claimer

Back in the admin tab, on the same card, click **Pick this teacher**
next to the claimer's name. Confirm the prompt → Toast: "Sub request
filled". The card moves down to the **Filled** section (the green
status pill changes to `filled`, and a "Filled by …" line appears).

The claim row's status should now show `accepted`.

SQL spot-check:

```sql
select status, filled_by_teacher_id, filled_at
  from public.sub_requests
  where id = '<the-request-id>';
-- status = 'filled', filled_by_teacher_id matches the chosen teacher,
-- filled_at populated.

select claimed_by_teacher_id, status, decided_at
  from public.sub_claims
  where sub_request_id = '<the-request-id>';
-- The chosen claim → 'accepted', any others → 'declined'.
```

The schedule view's badge should flip from 🔄 to ✓ on the next render.

---

## 7. Direct-fill bypass (admin only)

Open a fresh request (repeat steps 3) and, **without** anyone claiming
first, in the admin's Sub requests tab use the `Assign teacher
directly…` select on the card to pick a teacher. Confirm the prompt.

The request flips to `filled` immediately, no claim row required —
this is the emergency-coverage path where the admin already lined up
a sub by phone.

---

## 8. Cancel a request

Open another request as the teacher, then back on the same teacher's
Sub requests tab click **Cancel request**. Optional reason → prompt
→ Toast: "Sub request cancelled".

SQL:

```sql
select status, cancelled_at, cancellation_reason
  from public.sub_requests
  order by created_at desc
  limit 1;
-- status = 'cancelled', cancelled_at populated.
```

Now that the request is cancelled, you should be able to open a
**new** request for the same class+session_date — the partial unique
index excludes cancelled rows.

If a teacher tries to cancel a request they didn't open, the RPC
should error with "Sub request not found, not yours to cancel, or
already filled" (toast).

---

## 9. RLS spot checks

As a teacher, you should NOT be able to:

- See requests filed by another teacher unless they're `open` (or you
  filled them or claimed them yourself).
- Mutate the `sub_requests` table directly via PostgREST — only RPCs.
- Decide claims on requests you didn't file (the RPC blocks via
  `has_permission('manage_all_sub_requests')`).

Quick test (in the teacher's browser console):

```js
// This should return no rows for requests filed by other teachers
// once they've been filled.
window.__dk_supabase.from('sub_requests').select('*').then(console.log)

// This should error or noop — teachers can't update directly.
window.__dk_supabase.from('sub_requests')
  .update({status:'cancelled'})
  .eq('id','<some-request-id>')
  .then(console.log)
// Expect 0 rows updated (RLS hides target) or a permission error.
```

---

## 10. Realtime sanity

Open two browsers (or two devices) — one logged in as super_admin,
one as a teacher. Open both to the **Sub requests** tab. Have one
side create / claim / fill / cancel and confirm the other side's UI
updates within ~300ms without a manual refresh. If updates don't
arrive, check the browser console for the line:

```
[realtime] subscribed to N tables
```

`N` should be 18 (the original 16 + sub_requests + sub_claims). If
N is still 16, the deploy didn't pick up the new code yet — wait for
Vercel's ~30s rebuild and hard-reload.

---

## 11. Permissions cleanup

If you granted yourself the `teacher` role for testing, restore your
DK profile to `super_admin`:

```sql
update public.profiles
  set role = 'super_admin'
  where id = auth.uid();
```

Done. T4 ships.
