# Phase T1 — UI gating verification

After deploying the new build (or running locally), test each role by flipping Jason's profile in the DB and hard-reloading the console.

## Setup

You'll be running these SQL snippets against the DK Supabase project (`ybolygqdbjqowfoqvnsz`). Each one flips your role, you reload the page, you check the UI matches, then move on. The last snippet restores `super_admin`.

> **Important:** the `signed-in user' must be Jason for these tests, since Jason is the only profile in the DB right now.

## Test 1 — `super_admin` (current state, baseline)

```sql
update public.profiles
set role = 'super_admin'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

**Expected UI:**
- Header: chip shows "Jason Lyons · SUPER ADMIN" with PAR ✓ badge
- Tabs visible: Home, Templates, Classes, Teachers, Categories, Infographics
- All "+ New X" buttons visible
- Sync now / Refresh PAR links visible
- Teachers tab: Pay rate column visible
- Edit / delete buttons visible everywhere
- Bento Quick Actions: all 4 actions

## Test 2 — `admin`

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

**Expected UI:** identical to super_admin (admin has all the same UI permissions in T1; the difference between the two only matters for billing / role-management features that don't exist yet).

## Test 3 — `manager`

```sql
update public.profiles set role = 'manager'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

**Expected UI:**
- Chip: "MANAGER" badge in amber
- Tabs visible: all 6 (Home, Templates, Classes, Teachers, Categories, Infographics)
- All "+ New X" buttons HIDDEN (T1 limitation: manager can't write yet — RLS extension lands in T1.5)
- Sync now / Refresh PAR links HIDDEN
- Teachers tab: Pay rate column HIDDEN; Edit button HIDDEN
- Templates: ✎ and ⎘ icons HIDDEN on each card; cards still expand and copy-to-clipboard still works
- Classes / Infographics: Edit buttons HIDDEN
- Categories: Delete buttons HIDDEN; label inputs are read-only
- Bento Quick Actions: shows "No quick actions available for your role"

## Test 4 — `viewer`

```sql
update public.profiles set role = 'viewer'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

**Expected UI:** essentially identical to manager (both are read-only in T1). Chip shows "VIEWER" with a muted dashed badge.

## Test 5 — `teacher`

```sql
update public.profiles set role = 'teacher'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

**Expected UI:**
- Chip: "TEACHER" in sky blue
- Only the **Home** tab is visible — Templates / Classes / Teachers / Categories / Infographics are all hidden
- Bento switches to teacher layout: Welcome card mentioning that no teacher record was found (because Jason isn't in the `teachers` table by his email)
- Visible cards: Welcome (no-record state), Coming soon, On PAR
- No edit/admin UI anywhere

To exercise the *with-teacher-record* path, temporarily insert yourself as a teacher and assign yourself to a class:

```sql
insert into public.teachers (full_name, slug, email, status)
values ('Jason Lyons (test teacher)', 'jason-test', 'jlyonsld@gmail.com', 'active')
on conflict do nothing;

-- Pick any class and assign yourself
insert into public.class_teachers (class_id, teacher_id, role)
select c.id, t.id, 'primary'
from public.classes c, public.teachers t
where t.email = 'jlyonsld@gmail.com'
  and c.is_test = false
  and c.active = true
limit 1
on conflict do nothing;
```

After hard-reload, the teacher bento should show:
- "Your next class" or "No classes for you on [day]" — depending on the class schedule
- "Your week" stat card with 1 class assigned
- "Today's schedule" if the class runs today

To clean up after teacher testing:
```sql
delete from public.class_teachers
where teacher_id in (select id from public.teachers where email = 'jlyonsld@gmail.com' and slug = 'jason-test');
delete from public.teachers where slug = 'jason-test';
```

## Test 6 — `null` (no role granted)

```sql
update public.profiles set role = null
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

**Expected UI:** the "Waiting for access" screen instead of the main console. Sign-out button is visible. No tabs, no data.

## Restore to super_admin

```sql
update public.profiles set role = 'super_admin'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

After this, hard-reload one more time and confirm everything is back to the baseline state.

## Audit log spot-check

Each role flip writes a `role_audit` row. After you're done, this should show your full test sequence:

```sql
select created_at, prior_role, new_role, granted_by
from public.role_audit
order by created_at desc
limit 10;
```

`granted_by` will be NULL for these direct UPDATEs (no auth context); when role changes happen via the future Phase T6 UI, granted_by will be the acting admin's user id.
