# T11 — Student intake (PII fields + parent self-fill form) verification

This phase ships in three parts; verify each before declaring done.

## Pre-flight

- [ ] `phase_t11_student_intake.sql` applied (Supabase MCP `apply_migration` or dashboard SQL editor).
- [ ] Edge Functions deployed: `dk-send-intake-form` (verify_jwt: **true**) and `dk-submit-intake-form` (verify_jwt: **false**).
- [ ] `student-intake.html` deployed to Vercel (just push to `main`, ~30s).
- [ ] (Optional but recommended) `RESEND_API_KEY` is set on the DK Supabase project's Edge Function secrets, AND `dk_config.sender_email` is populated. Without these, intake emails skip and the admin uses the copy/paste fallback.

```sql
-- Quick schema check
select column_name from information_schema.columns
 where table_schema='public' and table_name='students'
   and column_name in ('allergies','medical_notes','photo_permission',
                       'emergency_contact_name','school_name','grade',
                       'authorized_pickup');
-- Expect 7 rows (the 9 added; emergency_contact_phone + relationship live too)

select count(*) from public.student_intake_requests;
-- Should not error
```

## Part 1 — Expanded Add Student modal (admin path)

1. **Sign in as admin or super_admin**, open Classes tab, expand any class.
2. Click **+ Add student** in the enrollments section.
3. The modal opens with new sections: Student / Parents repeater (1 row seeded) / Emergency contact / Health & safety / Notes.
4. Fill in:
   - First / Last (required)
   - DoB, Gender, Grade, Day school
   - Click **+ Add another parent** twice → 3 parent rows. Fill 2 of them with name+email+phone; remove the 3rd via the **Remove** link.
   - Emergency contact name + phone + relationship + authorized pickup textarea
   - Allergies + medical notes + radio = "Yes" for photo permission
   - Internal notes
5. Click **Add to class**.
6. Toast: `<First> <Last> added to class`.
7. The new row appears in the enrollments list with:
   - Name + DoB + grade
   - Parent line(s): name · email (mailto link) · phone (tel link) on subsequent line
   - 🚨 emergency contact line
   - **No** chips (photo permission was "Yes", no allergies/medical notes triggered display)

8. Open the row in Supabase → confirm `parent_names`, `parent_emails`, `parent_phones` are populated arrays (lowercase emails), and the new PII columns are filled.

**Edge cases:**

- [ ] Submit with empty first or last → toast "First and last name are required", modal stays open.
- [ ] Set photo permission radio to "No" → after save, the row gets a `📷 no photos` chip.
- [ ] Set allergies AND medical notes → chips `⚠ allergies` and `⚕ medical` appear, hover shows the full text.
- [ ] Cancel button on the lone (1st) parent row should NOT exist (only rows 2+ get a Remove button). Verify.

## Part 2 — Send-intake-form path (parent self-fill)

### 2a. Send the form

1. Open Add Student modal again on a class.
2. In the **📧 Send the parent a form** banner at the top, type a real test email (use yours) → click **Send form**.
3. If Resend is configured: a real email arrives at the test address with subject "Please fill out the enrollment form for `<class name>`".
4. Either way, the in-app **Form sent** result modal appears with:
   - The intake URL (`https://dk-green.vercel.app/student-intake.html?token=…`) selectable / copyable.
   - Expiry date 14 days from now.
   - If email failed/skipped: yellow note explaining why (Resend unset / sender_email unset / actual error from Resend).
5. Close the modal. Back on the class detail panel: a **Pending parent forms (1)** subsection appears above the enrollments list, showing the parent email + "Sent today · expires <date>".

### 2b. Submit the form

1. Open the intake URL (from email or copy/paste).
2. The page loads with brand header + form sections. Form fields appear immediately (no extra round-trip to validate the token — only the submit endpoint validates).
3. Fill in: first + last (required), DoB, gender, grade, school, 2 parents (name + email + phone), emergency contact, photo permission radio = "Yes", allergies, notes.
4. Click **Submit enrollment**.
5. Page replaces form with the success card showing the class name.
6. Switch back to DK in another tab/device:
   - The pending intake row drops out of "Pending parent forms" within ~300ms (realtime debounce).
   - The new student appears in the enrollments list with all the data the parent typed.
   - Inserting the student fires the existing T3a duplicate-detection trigger; if the parent's typed name+DoB matches a JR-synced student, the reconcile banner appears (admin only) — verify by intentionally typing a duplicate.

### 2c. Resend / cancel

1. Send a new intake to a different email.
2. On the class panel pending row, click **Resend** → result modal reappears with a NEW URL (token rotated).
3. Open the OLD URL → submission must fail with "Invalid or expired link" (the old token's hash is no longer in the DB).
4. New URL works.
5. Send another intake. Click **Cancel** on the pending row → confirm dialog → toast "Intake cancelled". The row disappears.
6. Open the cancelled URL → submission fails with "This link is no longer active."

### 2d. Expired

```sql
-- Manually backdate one for the expiry test
update public.student_intake_requests
   set expires_at = now() - interval '1 minute'
 where status = 'pending'
 limit 1;
```

1. Open that intake URL → submit → response is 410 with "This link has expired."
2. SQL: confirm the row's `status` flipped to `expired` automatically.

### 2e. Duplicate submission

1. Send an intake; submit it successfully.
2. Re-open the same URL (or click the email link a second time) → submit → response is 409 "This form has already been submitted."

## Part 3 — RLS spot checks

1. **Admin path:** SELECT against `student_intake_requests` returns ALL rows.
2. **Teacher path:**
   - Sign in as a teacher who's on `class_teachers` for class A but NOT class B.
   - SELECT against `student_intake_requests` should return only rows where `class_id = A`.
   - Confirm pending parent forms appear in class A's detail panel for that teacher, not in class B's.
3. **Viewer path (or any role without `edit_students` and not on `class_teachers`):** SELECT returns 0 rows.
4. **No INSERT/UPDATE/DELETE policies:** an `update public.student_intake_requests set status='completed' where ...` from a logged-in user (not service-role) should fail with RLS denial.

## Part 4 — `cancel_student_intake` RPC

1. Sign in as a non-admin (teacher) → call `select public.cancel_student_intake('<some uuid>');` → expect "Not authorized to cancel intake requests".
2. Sign in as admin → call against a non-existent uuid → expect "Intake request not found or not pending".
3. Call against a real pending uuid → no error; SELECT shows status='cancelled'.

## Part 5 — Schema sanity (one-shot)

```sql
select policyname, cmd from pg_policies
 where schemaname='public' and tablename='student_intake_requests';
-- Expect: intake_requests_select_admin (SELECT), intake_requests_select_teacher (SELECT). No others.

select count(*) from pg_publication_tables
 where pubname='supabase_realtime' and tablename='student_intake_requests';
-- Expect: 1
```

## What's NOT in T11 (deliberate)

- **No SMS / WhatsApp delivery.** Email only via Resend. If a parent prefers SMS, the admin copy/pastes the link into their phone.
- **No mid-form save.** The parent has to fill the whole form in one sitting. The form is short (~3 minutes) so this is fine.
- **No partial-update flow.** The form creates a NEW student; it does not "top up" an existing JR-sourced student row. If you need that, it's a separate phase (would need a second intake type that targets `student_id` instead of `class_id`).
- **No nightly purge of expired/cancelled rows.** Volume is low. Add pg_cron later if needed.
