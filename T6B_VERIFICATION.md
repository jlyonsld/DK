# Phase T6b — Personnel: payment details, documents, waivers — verification

End-to-end test plan for the sensitive-PII split, document storage,
and e-signed waiver flow shipped in
`migrations/phase_t6b_personnel_payments_waivers.sql`. Run these
checks against the DK Supabase project (`ybolygqdbjqowfoqvnsz`) and
(after Phase B ships) the live Vercel deploy
(`https://dk-green.vercel.app`).

This doc assumes you already have:

- A super_admin DK profile (Jason — `jlyonsld@gmail.com`).
- Phase T6a applied (basic personnel columns on `teachers` already
  exist, including `payment_method`, `liability_waiver_signed`,
  `liability_waiver_date`).
- At least one `teachers` row with an `email` populated. Ideally
  also one teacher who has signed in (so they have a DK profile
  with `role='teacher'`) for the self-sign path.
- For full coverage: a manager profile (NOT admin or super_admin) so
  you can verify both `manage_teacher_payments` and
  `manage_teacher_compliance` are admin+ only and that managers are
  blocked from payment details and tax docs.

---

## 1. Apply the migration

In the Supabase SQL editor (DK project), paste the contents of
`migrations/phase_t6b_personnel_payments_waivers.sql` and run. The
whole thing is a `begin … commit` block, idempotent on re-run.

Spot-check after:

```sql
-- Tables exist with RLS on.
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('teacher_payment_details',
                     'liability_waivers',
                     'liability_waiver_signatures',
                     'teacher_documents')
 order by tablename;
-- Expect: 4 rows, all rowsecurity = true.

-- Policies on each table.
select c.relname as table_name, p.polname, p.polcmd
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
 where c.relname in ('teacher_payment_details','liability_waivers',
                     'liability_waiver_signatures','teacher_documents')
 order by c.relname, p.polname;
-- Expect:
--   teacher_payment_details:    tpd_select / tpd_insert / tpd_update / tpd_delete
--   liability_waivers:          lw_select / lw_insert / lw_update / lw_delete
--   liability_waiver_signatures: lws_select_admin / lws_select_self
--                                  (NO insert/update/delete policies — RPC is the writer)
--   teacher_documents:          td_select / td_insert / td_update / td_delete

-- record_waiver_signature RPC exists and is security definer.
select prosecdef, proname
  from pg_proc
 where proname = 'record_waiver_signature';
-- Expect prosecdef = true.

-- has_permission() now knows the two new permissions.
-- (Run as super_admin.)
select public.has_permission('manage_teacher_payments') as can_payments,
       public.has_permission('manage_teacher_compliance') as can_compliance;
-- Expect: t / t (when run as super_admin Jason).

-- Storage bucket exists, private.
select id, name, public from storage.buckets where id = 'teacher-documents';
-- Expect: 1 row, public=false.

-- Storage RLS policies on the new bucket.
select polname from pg_policy p
  join pg_class c on c.oid = p.polrelid
 where c.relname = 'objects'
   and polname like 'tdocs_%'
 order by polname;
-- Expect 4: tdocs_admin_select / insert / update / delete.

-- Seed waiver landed.
select version, title, is_active from public.liability_waivers;
-- Expect 1 row, version=1, is_active=true.

-- Realtime publication.
select tablename from pg_publication_tables
 where pubname='supabase_realtime'
   and schemaname='public'
   and tablename in ('teacher_payment_details','liability_waivers',
                     'liability_waiver_signatures','teacher_documents');
-- Expect all 4 tables listed.
```

---

## 2. Permission split: admin+ vs manager-and-below

Both new permissions sit at admin+super_admin. Manager / teacher /
viewer see neither. Verify with a manager profile signed into the
browser:

```js
// In the manager's browser console on dk-green.vercel.app:
await sb.rpc('has_permission', { perm: 'manage_teacher_payments' })
await sb.rpc('has_permission', { perm: 'manage_teacher_compliance' })
// Expect both: false.
```

Then sign in as super_admin and as admin in turn — both should
return true for both perms.

---

## 3. teacher_payment_details RLS

Sign in as **manager** in a browser:

```js
// Should succeed (zero rows, but no permission error):
await sb.from('teacher_payment_details').select('*');
// Expect: data: [], error: null  (RLS hides everything; no rows returned)

// Should fail with RLS denial:
await sb.from('teacher_payment_details')
  .insert({ teacher_id: '<some-teacher-uuid>', bank_name: 'X' });
// Expect: error code 42501 ("new row violates row-level security policy")
```

Sign in as **admin** or **super_admin** in a browser:

```js
// Insert one row.
const t = (await sb.from('teachers').select('id').limit(1).single()).data;
await sb.from('teacher_payment_details').insert({
  teacher_id:     t.id,
  bank_name:      'Test Federal Credit Union',
  account_type:   'checking',
  routing_number: '021000021',
  account_number: '1234567890'
});
// Expect: success.

// SELECT works:
await sb.from('teacher_payment_details').select('*');
// Expect: 1+ rows.

// Touch trigger updates updated_at + updated_by:
await sb.from('teacher_payment_details')
  .update({ notes: 'set during T6b verification' })
  .eq('teacher_id', t.id);
const r = (await sb.from('teacher_payment_details')
  .select('updated_at, updated_by').eq('teacher_id', t.id).single()).data;
console.log(r);
// Expect: updated_at within last few seconds; updated_by = your auth uid.

// Cleanup.
await sb.from('teacher_payment_details').delete().eq('teacher_id', t.id);
```

A manager-tier signed-in session should see `data: []` on SELECT
(NOT a permission error — that's RLS doing its job) and 42501 on
INSERT/UPDATE/DELETE. Admin and super_admin see + write everything.

---

## 4. liability_waivers — versioning + one-active invariant

In the Supabase SQL editor as super_admin:

```sql
-- Try to insert a SECOND active waiver. Should fail the partial
-- unique index `liability_waivers_one_active`.
insert into public.liability_waivers (version, title, body_html, is_active)
values (2, 'V2 attempt', '<p>Should fail.</p>', true);
-- Expect: ERROR  duplicate key value violates unique constraint
--                "liability_waivers_one_active"

-- Correct flow: deactivate v1 first, then insert v2 active.
update public.liability_waivers set is_active = false where version = 1;
insert into public.liability_waivers (version, title, body_html, is_active)
values (2, 'PAR DK Liability Waiver v2', '<p>Updated terms.</p>', true);
-- Expect: success.

-- Roll back.
update public.liability_waivers set is_active = true  where version = 1;
delete from public.liability_waivers where version = 2;
```

A signed-in **teacher** can SELECT waivers (needed to read the text
before signing) — open the browser console as a teacher and:

```js
await sb.from('liability_waivers').select('*').eq('is_active', true);
// Expect: 1 row, the seed waiver text.
```

A teacher CANNOT INSERT / UPDATE / DELETE:

```js
await sb.from('liability_waivers').insert({ version: 99, title: 'x', body_html: 'x' });
// Expect: 42501 RLS denial.
```

---

## 5. record_waiver_signature() RPC — both paths

### 5a. Self-sign path (teacher signs their own)

Sign in as a **teacher** whose `teachers.email` matches their auth
email. Browser console:

```js
const w = (await sb.from('liability_waivers')
  .select('id').eq('is_active', true).single()).data;

// Find the teacher row that matches the signed-in teacher.
const session = (await sb.auth.getSession()).data.session;
const tRow = (await sb.from('teachers')
  .select('id, email')
  .ilike('email', session.user.email)   // case-insensitive match
  .single()).data;

await sb.rpc('record_waiver_signature', {
  p_teacher_id: tRow.id,
  p_waiver_id:  w.id,
  p_typed_name: tRow.email.split('@')[0].replace(/[._-]/g, ' '),
  p_signer_ip:  null,         // OK to omit on self-sign
  p_user_agent: navigator.userAgent
});
// Expect: returns a uuid (the new signature_id).

// Confirm signature row exists and snapshot updated.
await sb.from('liability_waiver_signatures')
  .select('*').eq('teacher_id', tRow.id);
// Expect: 1+ rows, signed_by_self = true.

await sb.from('teachers').select('liability_waiver_signed, liability_waiver_date')
  .eq('id', tRow.id).single();
// Expect: signed = true, date = today.
```

### 5b. Admin-on-behalf path

Sign in as **super_admin**. Find a teacher who is NOT the same
person as you and whose email is NOT yours. In the browser console:

```js
const someoneElse = (await sb.from('teachers')
  .select('id, email')
  .neq('email', 'jlyonsld@gmail.com')   // anyone but you
  .limit(1).single()).data;

const w = (await sb.from('liability_waivers')
  .select('id').eq('is_active', true).single()).data;

await sb.rpc('record_waiver_signature', {
  p_teacher_id: someoneElse.id,
  p_waiver_id:  w.id,
  p_typed_name: 'Test Teacher (signed in person)',
  p_signer_ip:  null,
  p_user_agent: 'verification-script'
});
// Expect: returns a uuid.

await sb.from('liability_waiver_signatures')
  .select('signed_by_self, recorded_by_user, typed_name')
  .eq('teacher_id', someoneElse.id)
  .order('signed_at', { ascending: false }).limit(1).single();
// Expect: signed_by_self = false, recorded_by_user = your auth uid.
```

### 5c. Negative path — unauthorized caller

Sign in as a **teacher** whose email does NOT match the target row,
and try to sign for someone else:

```js
const otherTeacher = (await sb.from('teachers')
  .select('id, email').neq('email', '<your-own-email>').limit(1).single()).data;
const w = (await sb.from('liability_waivers')
  .select('id').eq('is_active', true).single()).data;

await sb.rpc('record_waiver_signature', {
  p_teacher_id: otherTeacher.id,
  p_waiver_id:  w.id,
  p_typed_name: 'Should fail'
});
// Expect: error.message contains "not authorized to sign on behalf of this teacher".
```

### 5d. Empty-name guard

```js
await sb.rpc('record_waiver_signature', {
  p_teacher_id: '<your own teacher id>',
  p_waiver_id:  '<active waiver id>',
  p_typed_name: '   '
});
// Expect: error.message contains "typed_name is required".
```

---

## 6. liability_waiver_signatures SELECT RLS

Sign in as a **teacher**:

```js
await sb.from('liability_waiver_signatures').select('*');
// Expect: ONLY rows whose teacher_id maps to a teachers row with
// my email (typically just my own signatures, possibly empty).
```

Sign in as **admin**:

```js
await sb.from('liability_waiver_signatures').select('*');
// Expect: every row across all teachers.
```

Sign in as **manager** or **viewer**:

```js
await sb.from('liability_waiver_signatures').select('*');
// Expect: 0 rows (RLS hides everything; NOT a permission error).
```

---

## 7. teacher_documents + storage bucket

Sign in as **admin** (or super_admin) in a browser. Create one
metadata row + upload a small file:

```js
const t = (await sb.from('teachers').select('id').limit(1).single()).data;
const path = `${t.id}/test-${Date.now()}.txt`;
const blob = new Blob(['hello T6b'], { type: 'text/plain' });

// Upload to bucket.
const up = await sb.storage.from('teacher-documents').upload(path, blob);
console.log(up);
// Expect: data.path matches the path we sent; error null.

// Insert metadata.
await sb.from('teacher_documents').insert({
  teacher_id:   t.id,
  kind:         'certification_other',
  label:        'T6b verification upload',
  storage_path: path,
  mime_type:    'text/plain',
  size_bytes:   blob.size
});

// SELECT works.
await sb.from('teacher_documents').select('*').eq('teacher_id', t.id);

// Mint a signed URL (storage SELECT policy gates this on
// manage_teacher_compliance).
const signed = await sb.storage.from('teacher-documents')
  .createSignedUrl(path, 60);
console.log(signed.data.signedUrl);
// Expect: a URL that returns "hello T6b" when fetched in this tab.

// Cleanup.
await sb.storage.from('teacher-documents').remove([path]);
await sb.from('teacher_documents').delete().eq('storage_path', path);
```

Sign in as **manager** and try the same upload:

```js
await sb.storage.from('teacher-documents').upload('m/test.txt', new Blob(['x']));
// Expect: error (storage RLS denies — manager doesn't hold
//         manage_teacher_compliance).
await sb.from('teacher_documents').select('*');
// Expect: data: [] (RLS hides everything; no permission error).
```

---

## 8. Realtime — admin sees teacher's self-sign live

Two browser windows:

1. Window A: super_admin on the (future) Teachers tab personnel modal
   open to a particular teacher.
2. Window B: that teacher signed in, signing the waiver.

When B's `record_waiver_signature` returns, A's `liability_waiver_signatures`
realtime channel should fire within ~300ms and the modal should
refresh "Last signed: <today>". (Once the Phase B UI ships — for
now, just confirm the realtime publication includes the table.)

---

## 9. Idempotency — re-run the migration

Re-run the migration file end-to-end:

```sql
\i phase_t6b_personnel_payments_waivers.sql
```

Should complete without error. Spot-check that the data already
present hasn't been duplicated:

```sql
select count(*) from public.liability_waivers;
-- Expect: still the same number you had before re-run.
```

---

## 10. Rollback (if needed)

If something goes catastrophically wrong, the rollback is destructive
and loses signature audit data:

```sql
begin;
  drop function if exists public.record_waiver_signature(uuid, uuid, text, inet, text);
  drop table if exists public.liability_waiver_signatures cascade;
  drop table if exists public.liability_waivers cascade;
  drop table if exists public.teacher_documents cascade;
  drop table if exists public.teacher_payment_details cascade;
  drop policy if exists "tdocs_admin_select" on storage.objects;
  drop policy if exists "tdocs_admin_insert" on storage.objects;
  drop policy if exists "tdocs_admin_update" on storage.objects;
  drop policy if exists "tdocs_admin_delete" on storage.objects;
  delete from storage.buckets where id = 'teacher-documents';
  -- Restore prior has_permission() by re-running the T5a migration
  -- (which contains the previous version verbatim).
commit;
```

Don't do this casually — once teachers have signed waivers, those
rows are evidence of consent. Roll back only on day-zero before any
real signatures exist.
