# T7b Verification — usage-tier variants, dismiss UX, PAR funnel report

> Builds on T7a (`par_promotion_events` + `resolveParVariant` + 5 base variants).
> Adds two usage-tiered variants for unlinked teachers, a 7-day dismiss UX, and
> an admin-only **PAR funnel** report. One migration, no new permission names.

## 0. Prereqs

- `migrations/phase_t7b_par_promo_dismiss.sql` applied to DK
  (`ybolygqdbjqowfoqvnsz`).
- Browser cache cleared (or hard reload) so the new app.js + styles.css load.

## 1. Migration spot-checks (psql / Supabase SQL editor)

```sql
-- Three policies should exist on par_promotion_events.
select polname, polcmd
from pg_policy
where polrelid = 'public.par_promotion_events'::regclass
order by polname;
-- Expect 3 rows: par_promo_events_admin_read (r),
--                par_promo_events_self_insert (a),
--                par_promo_events_self_read (r).
```

```sql
-- Self-read sanity. As a non-admin teacher:
--   set role authenticated;
--   set request.jwt.claims = '{"sub":"<that-teacher-profile-id>","role":"authenticated"}';
-- Then:
select count(*)
from par_promotion_events
where profile_id <> auth.uid();
-- Expect 0 (RLS silently filters; admins see all rows).
```

## 2. Resolver tiering — manual matrix

Sign in as a teacher whose `state.profile.par_person_id` is null (unlinked).
The base variant should be `unlinked_teacher`.

To exercise tiers without leading 50 real classes, temporarily seed `attendance`
or `clock_ins` rows for that teacher. Easiest path is `clock_ins` because each
row is one (teacher, class, session_date) tuple — no enrollment plumbing.

```sql
-- Seed 25 fake clock-ins distributed across recent dates.
-- Replace <teacher-id> + <class-id> with real ids.
insert into clock_ins (teacher_id, class_id, session_date, clocked_in_at, clocked_out_at)
select '<teacher-id>'::uuid,
       '<class-id>'::uuid,
       (current_date - g)::date,
       (current_date - g + interval '15 hours'),
       (current_date - g + interval '16 hours')
from generate_series(1, 25) g;
```

| State | Expected variant |
|---|---|
| 0 sessions | `unlinked_teacher` |
| 25 sessions (between 20–49) | `unlinked_teacher_attendance_20` |
| 60 sessions (≥50) | `unlinked_teacher_attendance_50` |

Reload the home tab between seedings (the resolver reads from `state.attendance`
and `state.clockIns`, which `reloadAll()` rehydrates). The PAR card copy should
flip between the three lines. Each variant fires exactly one `impression` per
session — re-rendering the home tab without a fresh page load should NOT
double-fire (verify in `par_promotion_events` SELECT).

Cleanup:

```sql
delete from clock_ins where teacher_id = '<teacher-id>' and clocked_in_at::date < current_date;
```

## 3. Dismiss UX

With the teacher at the 50-tier (or 20-tier) variant:

1. The PAR card shows a small `×` in the top-right corner.
2. Click `×`. Card immediately re-renders to the next-lower tier (or to the
   base `unlinked_teacher` if dismissing the 20-tier with sessions in
   [20, 50)).
3. Verify `par_promotion_events` got a new `dismiss` row for the dismissed
   variant_key.
4. Hard reload. The dismissed tier stays suppressed for 7 days; the lower
   tier (or base) keeps rendering.
5. To force re-emergence today, delete the dismiss row:
   ```sql
   delete from par_promotion_events
   where profile_id = '<teacher-profile-id>'
     and event_kind = 'dismiss'
     and variant_key = 'unlinked_teacher_attendance_20';
   ```

The base variants (`unlinked_admin`, `unlinked_teacher`, all `linked_*`) must
NOT show a dismiss button — confirm by signing in as an unlinked admin and
inspecting the card; no `×` should appear.

## 4. Admin funnel report

As `super_admin` or `admin`:

1. Navigate to **Reports** tab → **PAR funnel** sub-nav.
2. Verify the date-range controls + presets (Last 7d / 30d / 90d) work.
3. Summary cards: Impressions / Clicks / Dismisses / CTR / Dismiss rate.
4. By-variant table sorted by impressions desc, with CTR + dismiss-% per row.
5. Daily impressions sparkline — bars scaled to the largest day.
6. **Export CSV (events)** downloads `par-funnel-<start>-to-<end>.csv` with
   columns CreatedAt, ProfileId, Variant, Kind, Surface, Metadata.

Sign in as a `manager` or `teacher` and navigate to Reports — the tab should
not be visible at all (existing `ROLE_TAB_VISIBILITY` gate). Even if a manager
forces the URL/path, `renderParFunnelReport`'s guard renders an "admin-only"
notice and the underlying SELECT would return only their own rows anyway.

## 5. Realtime live-update

Open two browsers side-by-side:
1. Browser A — admin on Reports → PAR funnel.
2. Browser B — unlinked teacher with ≥20 sessions, on Home.

In Browser B, click the PAR card. Within ~300ms (realtime debounce), Browser
A's funnel should tick up Click + Impression counts without a manual refresh.
Same for clicking `×` (Dismiss tick).

## 6. RLS — non-admin shouldn't read other users' rows

Sign in as `teacher_a` and run from the JS console:

```js
(async () => {
  const r = await sb.from("par_promotion_events").select("profile_id").limit(20);
  console.log("rows:", r.data?.length, "distinct profiles:", new Set(r.data?.map(x => x.profile_id)).size);
})();
```

Expect: only `teacher_a`'s own profile_id appears (1 distinct profile). Admin
running the same query sees many distinct profile_ids.

## 7. Pass criteria

- [ ] Three policies on `par_promotion_events` (admin_read, self_insert, self_read).
- [ ] Variant flips at 20 and 50 session thresholds (clock_ins or attendance).
- [ ] Dismiss × visible only on tiered variants.
- [ ] Click `×` → optimistic flip + dismiss row inserted + 7-day suppression.
- [ ] PAR funnel report visible to admins only, summary + variant table + sparkline.
- [ ] CSV export round-trips in spreadsheet.
- [ ] Realtime updates the funnel from another tab without manual refresh.
- [ ] Non-admin SELECT returns only their own rows.
