# Phase T1.5 — Manager write access verification

T1.5 extends write access to the `manager` role for templates, categories,
infographics, teachers, classes, class_teachers, and closures. Admin-only
holdouts: class_infographics, teacher_invitations, dk_config, profiles.role,
and the Reports tab (per ROLE_TAB_VISIBILITY — managers don't see reports).

## Pre-flight

Run the migration `migrations/phase_t1_5_manager_writes.sql` against DK
(`ybolygqdbjqowfoqvnsz`) via the Supabase SQL editor. Confirm:

```sql
select tablename, policyname, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('templates','categories','infographics',
                    'teachers','classes','class_teachers','closures')
  and cmd in ('INSERT','UPDATE','DELETE')
order by tablename, cmd;
```

Every `qual` / `with_check` should read `has_permission('edit_<resource>')`
— no remaining `is_admin()` calls in these 21 rows. For class_teachers,
the perm is `edit_classes` (shared with classes).

Then confirm the bundle:

```sql
select pg_get_functiondef('public.has_permission(text)'::regprocedure);
```

The manager branch of the CASE should list `edit_classes`, `edit_teachers`,
`edit_closures` in addition to the T0 three. The super_admin and admin
branches should both include `edit_closures`. T3 permissions
(`reconcile_students`, `view_own_roster`, `manage_own_roster_students`,
`manage_own_enrollments`) must still be present.

## Setup

Same as T1: flip Jason's profile.role, hard-reload the console, observe.
Last snippet restores `super_admin`.

## Test 1 — `manager` can write the new surface

```sql
update public.profiles set role = 'manager'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

**Expected UI (new in T1.5):**
- Header chip: "Jason Lyons · MANAGER"
- Tabs visible: Home, Schedule, Templates, Classes, Teachers, Categories,
  Infographics
- Tabs HIDDEN: Reports (still admin-only)
- Header buttons VISIBLE: New template, New class, New teacher, Refresh PAR
  links, New category, New infographic
- Header buttons HIDDEN: Sync Jackrabbit (still admin-only —
  `run_jackrabbit_sync` not in manager bundle), Invite user
- Schedule tab: "Manage closures" button VISIBLE
- Teachers tab: Invite column HIDDEN, Edit column VISIBLE
- Every Edit / Delete button across Templates / Classes / Teachers /
  Categories / Infographics VISIBLE

**Expected server-side (while signed in as manager in the browser):**

```js
// Browser dev console:
await sb.from('templates').insert({ slug: 't15-test', label: 'T1.5', body: 'x', category_id: null });
// → { error: null }  ✔
await sb.from('closures').insert({ date: '2026-12-25', reason: 'T1.5 test' });
// → { error: null }  ✔
await sb.from('class_teachers').insert({ class_id: '<id>', teacher_id: '<id>', role: 'primary' });
// → { error: null }  ✔  (clean up after)
```

## Test 2 — `manager` still BLOCKED where we want it blocked

```js
// class_infographics stays admin-only — RLS still checks is_admin()
await sb.from('class_infographics').insert({ class_id: '<id>', infographic_id: '<id>' });
// → { error: row-level security / new row violates ... }  ✔

// dk_config.update requires is_super_admin()
await sb.from('dk_config').update({ sender_name: 'hack' }).eq('id', 1);
// → { error: ... }  ✔

// Attendance / students / enrollments still governed by T3 policies —
// manager has no view_attendance_readonly, no edit_students, etc.
await sb.from('attendance').select('*').limit(1);
// → { data: [], error: null } — empty because view_attendance_readonly
//   isn't in manager's bundle, not because of an error
```

## Test 3 — Reports tab stays admin-only

Manager should NOT see a Reports tab in the tab bar. `ROLE_TAB_VISIBILITY`
in app.js gates this; the tab doesn't appear for manager/viewer/teacher.

## Test 4 — `viewer` unchanged (still read-only everywhere)

```sql
update public.profiles set role = 'viewer'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

- No edit / delete buttons anywhere
- `await sb.from('templates').insert({...})` → RLS error
- `await sb.from('closures').insert({...})` → RLS error

## Test 5 — explicit revoke still works

Revoke one perm from manager for Jason specifically:

```sql
update public.profiles
set role = 'manager',
    revoked_permissions = array['edit_closures']
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

Reload. The "Manage closures" button should be hidden; browser-console
`insert` into `closures` should fail. Clean up:

```sql
update public.profiles
set revoked_permissions = '{}'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

## Restore

```sql
update public.profiles set role = 'super_admin'
where id = (select id from auth.users where email = 'jlyonsld@gmail.com');
```

## Notes

- `is_admin()` is intentionally **not** touched by this migration. Many
  other policies still rely on it (profiles, role_audit, dk_config,
  teacher_invitations, install_nonces, class_infographics, sync_log).
  Per CLAUDE.md §4.5, don't refactor it.
- T3 permissions (`reconcile_students`, `view_own_roster`,
  `manage_own_roster_students`, `manage_own_enrollments`) are preserved
  verbatim in the new `has_permission()` body. If the live function
  predates T3 somehow, this migration folds T3's permissions in too —
  safe because all PERM_BUNDLES in app.js already reflect T3.
- PERM_BUNDLES in app.js is the mirror of `has_permission()`; if you
  change one, change the other in the same commit (§4.4).
- `canMutate()` helper was removed from app.js — it conflated "admin or
  above" with "can write something," which no longer matches reality.
  Use `isAdminOrAbove()` for the few spots that genuinely need it
  (invite user), and `hasPerm('edit_<resource>')` everywhere else.
