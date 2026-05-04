# T13 Verification — per-school closures

> Adds `closures.school_id` (nullable) so multi-school franchises can scope a
> closure to one location. NULL = legacy global behavior.

## 0. Prereqs

- `migrations/phase_t13_per_school_closures.sql` applied to DK
  (`ybolygqdbjqowfoqvnsz`).
- At least two `schools` rows exist on the project (otherwise per-school
  scoping isn't observable — single-school franchises will still see the
  modal dropdown but it'll have only one option).
- Hard reload after deploy so the new app.js + styles.css are loaded.

## 1. Migration spot-checks

```sql
-- New column + index
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='closures' and column_name='school_id';
-- Expect: 1 row, uuid, YES (nullable).

select indexname from pg_indexes where tablename='closures' and indexname='closures_date_school_idx';
-- Expect: 1 row.

-- Pre-existing rows kept their semantic
select count(*) as legacy_global from closures where school_id is null;
-- Expect: matches your pre-T13 closure row count.
```

## 2. Modal — add a closure with each scope

Open Schedule → 🗓 Closures. The modal now has a third control: a school
dropdown defaulting to "All schools (global)".

1. **Global**: pick a near-future date, type a label, leave the dropdown on
   "All schools (global)", click Add. Row appears in the list with a
   green-ish 🌐 "All schools" chip.
2. **Per-school**: pick another near-future date, type "Pretend snow day",
   choose any school from the dropdown, Add. New row appears with a 📍
   chip showing that school's name.
3. Reload; both rows survive.

## 3. Schedule rendering — Day view

Navigate Schedule → Day to the date of the **per-school** closure.

- Closure card at the top of the day list shows the label with the school
  in parens: "🗓 Pretend snow day (Mt Pleasant ES)".
- Class rows whose `classes.school_id` matches that school are dimmed
  (~55% opacity) with a line-through on the title and a small 🗓 badge
  next to the time.
- Class rows at OTHER schools (or with no school set) on the same day
  render normally — no dimming, no badge.

Now navigate to the **global** closure's date:
- Every class row that day is dimmed + 🗓 badged, regardless of school.

## 4. Schedule rendering — Week view

Navigate to a week containing both closure types.

- The day with the **global** closure: cell-wide `.closed` styling kicks in
  (the column subtly dims), the closure pill at the top shows the label,
  and every block in that column is dimmed + 🗓 badged.
- The day with the **per-school** closure: cell-wide `.closed` does NOT
  fire (the column is normal). The pill at the top still shows the label
  with the school in parens. Only the blocks whose class is at that school
  are dimmed + 🗓 badged. Other classes that day render normally.

## 5. Schedule rendering — Month view

Navigate to the month covering both closures.

- The cell with the **global** closure: red 45° hatch fills the cell
  (`.closed-full`). Class rows inside are dimmed.
- The cell with the **per-school** closure: NO red hatch. The closure
  label still shows on the cell (with school in parens via tooltip), and
  ONLY the rows for that school are dimmed + 🗓 badged.

This is the load-bearing T13 visual rule: prominence is reserved for "all
schools." (See CLAUDE.md §5 gotcha.)

## 6. Mobile (≤720px)

Open the modal on a narrow viewport — the school dropdown wraps to a new
line below the date/label inputs. The list rows put the scope chip on its
own line below the date+label.

## 7. Edge cases

- **Class with no school_id**: only global closures dim it. A per-school
  closure cannot affect it — verify by adding a manually-created class
  with no school_id, then a per-school closure on its date; the class
  should NOT dim.
- **Two closures same day** (one global, one per-school): the cell shows
  red hatch (global wins) AND the pill lists both. Class rows for the
  scoped school's classes show ONE 🗓 badge with both labels in the
  tooltip (joined with " · ").
- **Delete a per-school closure**: the school's `on delete cascade` would
  also drop any closures pointing at that school if the school itself is
  deleted (verify via SQL: `delete from schools where id = '<test-id>'`
  and confirm the closure rows are gone). Don't run this on a real school.

## 8. RLS sanity

```sql
-- Writes still gated on edit_closures (via existing policies — no T13
-- policy change). As a viewer:
--   set request.jwt.claims = '{"sub":"<viewer-id>","role":"authenticated"}';
insert into closures (date, label, school_id) values (current_date, 'test', null);
-- Expect: permission denied via RLS.
```

## 9. Pass criteria

- [ ] Migration applied; column nullable; index present.
- [ ] Existing global closures still render the legacy way.
- [ ] Modal dropdown lists schools alphabetically + "All schools (global)" default.
- [ ] Per-school closure dims only matching classes; global dims everything.
- [ ] Month-view red hatch fires ONLY on global closures.
- [ ] Pill labels include school name in parens for non-global closures.
- [ ] Mobile layout doesn't clip the dropdown or scope chip.
- [ ] Writes still gated on edit_closures.
