# PAR DK — Project Handoff Document

> **Supabase project:** `ybolygqdbjqowfoqvnsz` (DK)
> **Federates with PAR:** `dzcmfiahnxxqqeheimis` (Selectively / get-on-par.com)
> **Deploy target:** Vercel (auto-deploys from `github.com/jlyonsld/DK` `main`)
> **Live URL:** `https://dk-green.vercel.app`

---

## 1. What the app does

PAR DK is the franchise-operations console for a Drama Kids studio — part CRM, part response-template library, part class/teacher/enrollment manager, part Jackrabbit bridge. Sharon (franchise owner) and her delegates use it to respond to leads with pre-built copy-and-personalize templates, manage the class roster synced nightly from Jackrabbit, track teachers and their assignments, attach infographic images to classes for fast lead replies, view a day/week/month schedule, and invite team members at any of five roles (super_admin, admin, manager, teacher, viewer). DK is federated with PAR: PAR owns identity (one canonical `person_id` across personal and work email contexts) and org ownership; DK plugs in as a "thick spoke" that holds everything industry-specific to a Drama Kids business. A franchise installs PAR DK by clicking Install on PAR's Connected Apps panel, which triggers an HMAC-signed token handoff that auto-configures DK for that org. On first sign-in with a linked work email, DK looks up the user's PAR org role and auto-promotes them to the matching DK role — owner → super_admin, admin → admin — so no manual SQL is ever needed to bootstrap a new franchise.

---

## 2. Tech stack and key libraries

| Layer | Choice | Notes |
|---|---|---|
| Framework | None — vanilla HTML/CSS/JS | Single `app.js` monolith, intentional |
| Runtime | Browser + Supabase Edge Functions (Deno) | No Node server of our own |
| Backend / DB | Supabase (`ybolygqdbjqowfoqvnsz`) | Postgres + Auth + Realtime + Storage + Edge Functions |
| Auth | Supabase Auth | Password sign-in AND magic-link (OTP) — both live on the login screen |
| Realtime | Supabase Realtime channels | All public tables are in the `supabase_realtime` publication; one channel watches everything with a 300ms debounce |
| Styling | Inline `style` in app.js rendered strings + global classes in `styles.css` | No CSS framework, no preprocessor |
| Supabase client | `@supabase/supabase-js@2` via jsdelivr CDN | Loaded as a script tag in `index.html`; no bundler |
| Error tracking | None | We rely on `sync_log` table + Supabase Edge Function logs for observability |
| Payments | None | Not in scope for DK; billing is PAR's concern |
| Email | Resend (via Edge Function `dk-invite-teacher`) | Optional — if `RESEND_API_KEY` unset the invite flow gracefully degrades to a copy-paste link modal |
| Identity federation | PAR's `spoke-get-identity` + `spoke-create-org-invitation` | DK calls PAR Edge Functions with a pre-provisioned spoke API key |
| Install handoff | HMAC-SHA256 signed token | `SPOKE_INSTALL_SIGNING_SECRET` must be byte-identical on both PAR and DK projects |

**There is no build step.** The browser loads `index.html`, `config.js`, `app.js`, and `styles.css` directly. Vercel just serves static files. No Vite, no Webpack, no TypeScript at the frontend layer.

---

## 3. File and folder layout

```
response-console-v3/
├── index.html                ← App shell, login screen, no-role screen,
│                               all modals, tab bar. ~500 lines.
├── install.html              ← Standalone install-flow landing page that
│                               receives the HMAC-signed token from PAR,
│                               POSTs to dk-install-callback, shows
│                               success/error and a Continue-to-sign-in CTA.
├── app.js                    ← ~3100 lines. Everything:
│                                 - State + Supabase client
│                                 - Role + permissions helpers (PERM_BUNDLES
│                                   mirrors the SQL has_permission() exactly)
│                                 - Auth (password + magic-link + session boot)
│                                 - reloadAll() / renderAll() orchestration
│                                 - Realtime subscription setup
│                                 - Home bento (admin variant + teacher variant)
│                                 - Schedule Day/Week/Month renderers
│                                 - Templates (list, edit modal, card body)
│                                 - Classes (table + detail expand panel)
│                                 - Teachers (table + edit modal)
│                                 - Categories (inline editor)
│                                 - Infographics (sidebar + management table)
│                                 - Invitations (editor modal + result modal)
│                                 - Closures manager modal
│                                 - PAR identity bridge (par-identity-proxy
│                                   call on boot)
├── styles.css                ← ~2000 lines. Tokens (CSS vars for colors /
│                               radii / spacing), global resets, component
│                               classes, schedule-view layouts, and a
│                               responsive pass under two media queries:
│                               ≤720px (phones & small tablets) and ≤380px
│                               (iPhone SE-class).
├── config.js                 ← Supabase URL + publishable key. The
│                               publishable key is safe in the browser —
│                               every write is RLS-gated.
├── logo.png                  ← Brand asset.
├── README.md                 ← Older. May be stale.
│
├── CLAUDE.md                 ← This file.
│
├── T1_VERIFICATION.md        ← Role-swap SQL snippets for verifying the
│                               Phase T1 role gating behavior.
├── T2_VERIFICATION.md        ← Setup + test steps for the teacher invitation
│                               flow (what Sharon must configure + how to test
│                               that the invite/redemption round-trip works).
├── INSTALL_FLOW_VERIFICATION.md ← End-to-end test plan for the spoke install
│                               flow: share-the-secret, do-a-test-install,
│                               verify auto-promote, SQL spot checks.
└── SHARON_ONBOARDING_WALKTHROUGH.md ← The step-by-step for walking Sharon
                                through her first PAR + PAR DK setup,
                                including the personal/work email split.
```

**Adjacent folders (in the DK Optimization parent, not deployed):**

```
DK Optimization/
├── migrations/               ← SQL migrations, applied to Supabase in order.
│   ├── phase_t0_role_foundation.sql
│   ├── phase_t2_teacher_invitations.sql
│   ├── phase_s1_closures.sql
│   ├── phase_t3_permissions.sql         ← Adds reconcile_students +
│   │                                      view_own_roster +
│   │                                      manage_own_roster_students +
│   │                                      manage_own_enrollments perms.
│   ├── phase_t3a_student_adds.sql       ← Teacher-added students,
│   │                                      dk_local vs jackrabbit source,
│   │                                      student_match_candidates,
│   │                                      reconcile_students RPC.
│   ├── phase_t3b_attendance.sql         ← Attendance RLS + take_attendance
│   │                                      RPC (enrollment-scoped).
│   ├── phase_t3c_late_pickup.sql        ← attendance.late_pickup_minutes
│   │                                      + RPC persist.
│   └── phase_t3d_clock_in_out.sql       ← clock_ins table, clock_in /
│                                          clock_out RPCs, teacher-scoped
│                                          RLS, 2-day grace window.
├── edge-functions/           ← Deno sources for Edge Functions deployed to
│   │                           DK's Supabase project.
│   └── dk-invite-teacher/index.ts
└── plans/                    ← Strategy + spec docs. Authoritative for
                                 product intent; the migrations / code are
                                 the authoritative state of the build.
```

**Edge Functions deployed to DK's Supabase project:**

| Name | verify_jwt | What it does |
|---|---|---|
| `par-identity-proxy` | false | Called by the browser on boot to resolve the signed-in user's PAR identity and auto-promote role based on PAR org ownership. Internally verifies the user JWT. |
| `dk-invite-teacher` | true | Called by admin+ users from the Teachers tab. Calls PAR's `spoke-create-org-invitation`, persists a DK-side `teacher_invitations` row, and optionally emails via Resend. |
| `dk-install-callback` | false | Receives the HMAC-signed install token from PAR, verifies it, writes `dk_config.par_franchise_org_id`, consumes the nonce, responds with org details. Token itself is the auth. |
| `jackrabbit-sync` | false | pg_cron-scheduled job that pulls class openings from Jackrabbit and upserts `classes`. |
| `zapier-enrollment-webhook` | false | Authed via `X-Zap-Secret` header. Zapier pushes enrollment/student changes here. |

**Tables in DK's public schema** (roughly in order of importance):

```
profiles                 — per-auth-user DK profile with role + PAR identity cache
categories               — template categories (pricing, scheduling, etc.)
templates                — response templates with {variable} placeholders
classes                  — classes synced nightly from Jackrabbit
teachers                 — DK-side teacher roster
class_teachers           — many-to-many: which teacher is primary/sub for which class
class_infographics       — many-to-many: which images suggest for which class
students                 — students; `source` in {jackrabbit, dk_local}. JR
                           rows come from the Zapier webhook; dk_local from
                           the in-app "+ Add student" flow. See §4.13.
enrollments              — student enrollments; also carries `source`.
attendance               — attendance records, enrollment-scoped (one row
                           per enrollment_id + session_date). Status is
                           present/absent in the UI; `late`/`excused` remain
                           allowed in the check constraint for historical
                           rows. Includes `late_pickup_minutes` for billing.
                           See §4.14.
student_match_candidates — flagged possible duplicates across sources;
                           admin resolves via reconcile_students RPC. See §4.13.
clock_ins                — teacher shift timestamps (one row per
                           teacher+class+day). Fed by the clock_in /
                           clock_out RPCs. Feeds the "Teacher hours"
                           report for payroll. See §4.16.
infographics             — image assets in Supabase Storage bucket
teacher_invitations      — DK-side mirror of PAR invitations (see §4.6)
closures                 — holidays / non-class dates rendered on Schedule views
dk_config                — singleton row for franchise-level config
                           (par_franchise_org_id, sender_email, sender_name)
role_audit               — audit log for profile.role changes
install_nonces           — replay protection for spoke install tokens
sync_log                 — append-only log of sync + webhook events
```

---

## 4. Main architectural decisions

### 4.1 app.js is intentionally a monolith

~3100 lines. One file. All state, all Supabase queries, all render functions, all event wiring, all modals. Same rationale as PAR's App.jsx: everything grep-able, no prop-drilling, trivial traceability. The trade-off is hot-reload is slow (Vercel takes ~30s) and scanning unfamiliar code requires the file's line-number mental map. **Do not split this file without a clear migration plan.**

### 4.2 No framework

Plain HTML + JS. Initially it was Sharon's template tool. The app grew organically without ever needing a framework. We don't mint components; we `render<Thing>Tab()` into `innerHTML`. Events are wired via direct `onclick` assignment in those render functions, which means re-rendering replaces all handlers — that's intentional (event handlers live with their DOM).

### 4.3 Live UI everywhere, no manual refresh

Every mutation handler calls `reloadAll() + renderAll()` — never a partial re-render. Every public table is in the `supabase_realtime` publication. On boot, one channel subscribes to `postgres_changes` on all watched tables with a 300ms debounce, so external writes (Jackrabbit nightly sync, Zapier enrollment webhook, par-identity-proxy promoting a role, another admin editing from a second device) land in the UI live. **This is a cross-cutting principle** — don't introduce code that mutates the DB but only re-renders a subset. The debounce handles burst writes (e.g., a 60-row enrollment sync firing 60 INSERT events in 2s triggers one `reloadAll`).

### 4.4 Client-side role gating mirrors server-side RLS exactly

`PERM_BUNDLES` in `app.js` is a literal copy of the `has_permission()` SQL function's per-role permission list. The client uses `hasPerm('edit_templates')` to decide whether to show the Edit button; the server enforces the same check via RLS policies that call `is_admin()` or `has_permission()`. They agree line-for-line. **If you change one, change the other.** Otherwise the UI will show buttons that fail with RLS errors, which is the worst kind of broken (user confused, no clear diagnostic).

### 4.5 `is_admin()` was redefined, not replaced, to preserve 33 RLS policies

Phase T0 expanded roles from `{admin, teacher}` to `{super_admin, admin, manager, teacher, viewer}`. Instead of rewriting every existing RLS policy, we redefined `is_admin()` to match both `super_admin` AND `admin`. Every pre-existing policy that gated writes with `using (is_admin())` continued to work for super_admins without change. Don't "fix" `is_admin()` to mean only `admin` — it'd break 33 policies silently. See `migrations/phase_t0_role_foundation.sql` for the full story.

### 4.6 Teacher invitations pass through PAR's `org_invitations`, not DK's

PAR's `org_invitations` table already had everything we needed (org_id, email, role, auto-generated 64-char hex token, 7-day expiry, accepted_at). Parallel-implementing on DK's side would have created two invitation tables to reconcile. Instead: DK's `teacher_invitations` is a mirror — it stores the `par_invitation_id`, `par_token`, `par_accept_url` that PAR returned, plus DK-specific fields (`teacher_id` link, `dk_role`, `email_status`, `email_error`). The invitation flow:

1. DK Edge Function `dk-invite-teacher` calls PAR's `spoke-create-org-invitation`
2. PAR creates the canonical `org_invitations` row, returns the token + accept_url
3. DK persists a `teacher_invitations` row mirroring the PAR response
4. Acceptance happens at `https://get-on-par.com/org/invite/<token>` (PAR's page, not ours)
5. On PAR acceptance, an `org_members` row is created using the teacher's PAR `auth.users.id`
6. When the teacher signs into DK for the first time, `handle_new_user` trigger fires, finds the pending DK invitation by email, promotes `profile.role` to the invitation's `dk_role`, marks `accepted_at`

### 4.7 Spoke install flow: HMAC-signed token handoff

When Sharon clicks Install in PAR's Connected Apps tab:

1. PAR's `spoke-install-redirect` Edge Function verifies she's owner/admin of her org
2. Mints an HMAC-SHA256 signed token with `{spoke_slug, org_id, org_name, installing_user_id, installing_user_email, iat, exp (5 min), nonce}` using `SPOKE_INSTALL_SIGNING_SECRET`
3. Returns a redirect URL pointing at `https://dk-green.vercel.app/install.html?token=<signed>`
4. Browser navigates there
5. `install.html` POSTs the token to DK's `dk-install-callback` Edge Function
6. DK verifies the HMAC with its copy of the shared secret, checks nonce uniqueness against `install_nonces` table, validates expiry and spoke_slug
7. Writes `dk_config.par_franchise_org_id`
8. Redirects user to DK login

The shared secret (`SPOKE_INSTALL_SIGNING_SECRET`) must be byte-identical on both Supabase projects' Edge Function secrets. If it drifts, install tokens fail with "Invalid signature." This pattern scales to many spokes × many orgs with zero code changes.

### 4.8 Auto-promotion from PAR org ownership

`par-identity-proxy` v5 extends `spoke-get-identity`'s response consumption: after caching PAR identity on the DK profile, it checks if the caller has an `org_memberships[]` entry matching `dk_config.par_franchise_org_id`. If yes and their DK role is currently null, it promotes them using `owner → super_admin`, `admin → admin`, `member → null` (member doesn't auto-promote; teachers go through the invitation flow). Never demotes. **This eliminates the need for Jason (or any admin) to manually SQL-promote a new franchise owner.** The full auto-bootstrap chain is: Sharon creates PAR account → creates PAR org → installs Drama Kids in PAR's Connected Apps → signs into DK with her work email (which she linked to her PAR identity via PAR's Linked Accounts UI) → `par-identity-proxy` sees she owns the configured franchise org → super_admin.

### 4.9 Five roles with deterministic mapping to PAR's three

DK has granular roles to fit the franchise ops model (super_admin, admin, manager, teacher, viewer). PAR stays coarse with owner/admin/member. Mapping happens at the boundary:

| DK role | PAR `org_members.role` |
|---|---|
| super_admin | owner |
| admin | admin |
| manager | member |
| teacher | member |
| viewer | member |

PAR doesn't need to know DK's granular distinctions. Every spoke can do this differently.

### 4.10 Class recurrence is string-based, not RRULE

Classes carry `days: "Mon, Wed"` and `times: "3:00 PM - 3:45 PM"` strings, both populated by the Jackrabbit sync. `classRunsOnDay()` does case-insensitive substring matching on the day name; `classStartTimeOn()` regex-parses the time string. **This is intentional:** JR's openings feed uses these string formats, and reimplementing RRULE on top would require us to translate each JR class into RFC 5545, which is pointless for JR-sourced classes. The cost: one-off workshops with weird schedules don't fit the model cleanly. If you ever need real recurrence, look at PAR's `expandEvents()` — but don't bolt it onto DK classes casually.

### 4.11 Schedule Day/Week/Month views read from the same data

`classesForDate(date)` is the one source of truth for "what classes run on this day" across all three schedule views. Week view positions blocks absolutely at `(hour - 8) * 42px` from the top of the day column, with height `(duration / 60) * 42px`. Month view renders up to 3 inline class rows per cell (web) or 2 rows (≤720px) as `time · truncated-name · teacher-initials`; full name lives in the `title` tooltip; left-border color = primary teacher hue. `classInitialsString()` produces `"JL"` for primary-only and `"JL/MS"` when a sub is also assigned. Ultra-narrow (≤380px) hides the rows entirely and falls back to day number + count pill. Tapping a class row opens that class's detail panel; tapping empty cell space opens Day view for that date — this relies on `e.stopPropagation()` in `wireScheduleClassClicks`, don't remove it. All three views honor the role filter: teachers see only classes they're assigned to, via email match between `session.user.email` and `teachers.email`.

**Closure color hooks.** The month cell emits `.closed-full` today (red 45° hatch) for every closure. `.closed-short` (yellow hatch) is wired in CSS but not emitted — when the academic-calendar schema grows a `closures.type` column distinguishing full-day vs. short-day, flip the one-line conditional in `renderScheduleMonthView` to choose between them. No redesign needed.

### 4.12 Magic-link + password login both live

Sharon and future teachers don't want to manage DK passwords. The login screen exposes both: password (for people who prefer it) and a "✉ Email me a sign-in link" button that calls `sb.auth.signInWithOtp()`. The magic-link path auto-creates the `auth.users` row on first click, which triggers `handle_new_user`, which creates the DK profile and redeems any pending invitation. The `onAuthStateChange` handler detects the session arriving via the magic-link hash redirect and boots the app if the login screen is still visible.

### 4.13 Students have a `source` discriminator; reconciliation is user-driven

Students come from two places: Jackrabbit (via the Zapier webhook; `source='jackrabbit'`) and DK itself (teacher/admin "+ Add student" on a class panel; `source='dk_local'`). They coexist — contracted classes that never touch JR keep their students as dk_local indefinitely; late adds to JR classes may eventually reconcile.

**No auto-merging, ever.** On every insert into `students`, a `detect_student_match` trigger looks for likely duplicates across sources and files a `student_match_candidates` row. Three heuristics (all candidate, never merge): exact `(lower(first_name), lower(last_name), dob)`; phonetic `dmetaphone(last_name)` + exact first + dob; same `family_id` + exact first. Admin sees a yellow banner on affected class panels → **Review** opens a reconcile modal with three actions: **Link** (calls `reconcile_students` RPC, re-parents enrollments, archives the DK row), **Keep separate** (dismiss), **Delete DK-only**. Teachers can't SELECT the candidate table — admin-territory.

The `reconcile_students(uuid)` RPC is `security definer`, gated by `has_permission('reconcile_students')`. It re-parents `enrollments.student_id` only; attendance follows automatically because attendance is enrollment-scoped (see §4.14).

### 4.14 Attendance is enrollment-scoped (not student+class)

The `attendance` table keys on `enrollment_id` + `session_date`, not `student_id` + `class_id` + `session_date`. An attendance row can't exist without the enrollment that ties a student to a class — which means reconciling a duplicate student (see §4.13) silently moves all attendance with its enrollments, no explicit reparenting.

One row per `(enrollment_id, session_date)` enforced by unique index. Re-takes upsert via the `take_attendance(p_class_id, p_session_date, p_entries)` RPC. RPC is `security invoker` so RLS fires per INSERT — teachers can only write within their 2-day grace window on classes they teach; admins unconstrained. Defense-in-depth: the RPC also verifies each entry's enrollment belongs to `p_class_id` before inserting.

**Status in the UI is simplified to `present` / `absent`.** The check constraint still accepts `late` and `excused` for historical rows and future states — the renderer folds legacy `late` into Present and `excused` into Absent so old data reads cleanly. Unmarked students have no row (status `unknown` sentinel in-memory only; not persisted).

**Late pickup is tracked independently of status** via `attendance.late_pickup_minutes` (nullable integer ≥ 0). A student can be Present AND late-pickup. Absent students can't — the UI disables + clears the minutes input, and the modal's save logic nulls it regardless. The Reports tab's late-pickup list is the billing source of truth.

### 4.15 Reports tab is a pluggable registry

Admin-only top-level tab. `app.js` has a `REPORTS` array of `{ id, label, render }` entries; `renderReportsTab()` builds the sub-nav from it and calls the active entry's render function against a shared `#reportContent` node. Adding a report = one entry + one function. Ships with two entries:

- **Attendance** — summary counts, per-class breakdown, late-pickup log, CSV export (billing source).
- **Teacher hours** — shift summary, per-teacher payroll roll-up, per-class breakdown, itemized shift log, CSV export (payroll source).

Both aggregate entirely client-side from `state.attendance` / `state.clockIns` — no new queries.

### 4.16 Clock-in / clock-out is class-scoped and RPC-driven

Teachers record shift start/end per class session via two security-invoker RPCs: `clock_in(class_id)` (idempotent — returns the existing open shift if called twice) and `clock_out(clock_in_id)` (errors if already closed). Both resolve `teacher_id` from `auth.jwt() ->> 'email'` → `teachers.email`, so a user with no matching `teachers` row can't clock in — including super_admins who aren't also teachers.

UI surfaces:
- **Teacher bento "Today's shifts" card** — one row per today's assigned class with Clock in / Clock out + live duration.
- **Class detail panel** — a Clock in/out button next to "Take attendance for today" (visible to anyone with a matching `teachers` row, not just teachers-role users; admin-owners who also teach can clock in for their own classes).
- **Reports → Teacher hours** — admin payroll view.

`clock_ins` is keyed `(teacher_id, class_id, session_date)` via a partial unique index (`where class_id is not null`), which leaves the door open for future non-class shifts (prep, meetings) with a nullable `class_id`. v1 only surfaces class-tied shifts.

Teachers write within the same 2-day grace window as attendance (§4.14). Admins unconstrained. The `clock_in_out` permission already lived in the teacher bundle from Phase T0; T3d just hooked RLS into it.

---

## 5. Gotchas, quirks, and "don't touch this"

**`is_admin()` matches super_admin OR admin.** See §4.5. Don't refactor it to mean just admin. It's called by 33 RLS policies.

**`PERM_BUNDLES` in `app.js` ↔ `has_permission()` in SQL must stay byte-identical.** Any role/permission change requires editing both. If they drift, the UI lies about what the user can do.

**`handle_new_user` does more than create a profile.** It also redeems pending invitations by email. Don't casually replace it. See `migrations/phase_t2_teacher_invitations.sql`.

**`par-identity-proxy` v5 runs auto-promotion inline.** After caching identity, it checks PAR org memberships and promotes role if applicable. If you refactor this function, preserve that logic or the install flow stops auto-promoting.

**`spoke-get-identity` returns `org_memberships[]` across ALL linked auth users.** A person's work email and personal email both map to the same `person_id` via `identity_links`; `spoke-get-identity` collects org memberships from EVERY linked auth user. Don't filter to just the queried email's auth user — you'd miss memberships.

**Install tokens are single-use via `install_nonces`.** Reloading the install page with the same token fails with "Token already consumed (replay detected)." That's intentional. For legitimate re-install, go back to PAR's Connected Apps and click Install again to mint a fresh token.

**Edge Function `verify_jwt` setting matters.** `dk-invite-teacher` has `verify_jwt: true` because it must verify the caller is an admin user (JWT-authed). `par-identity-proxy`, `spoke-get-identity`, `dk-install-callback`, `jackrabbit-sync`, `zapier-enrollment-webhook` all have `verify_jwt: false` because they authenticate via bearer API keys, shared secrets, or signed tokens — not user JWTs. Don't toggle these without knowing why.

**The teacher bento matches the signed-in user to a `teachers` row by email.** There is no `profiles.teacher_id` column yet (deferred to Phase T6). If a teacher accepts an invitation but their work email doesn't match any teachers.email row exactly (case-insensitive), the teacher bento shows a "no teacher record" welcome card rather than their schedule.

**The realtime channel uses one channel for all tables with a 300ms debounce.** Don't create per-table channels — you'll hit connection limits. Don't remove the debounce — it coalesces burst writes.

**Sidebar (Infographics panel) is visible only on Templates + Infographics tabs.** See `SIDEBAR_TABS` in `app.js`. The layout shifts accordingly.

**The 3-day / 7-day / month schedule views all share `classRunsOnDay` + `classStartTimeOn`.** They pass the same cls/date to these helpers — don't introduce view-specific variants.

**The install flow's success page links to `/` (the app root).** DK's root redirects to login if no session is present. Sharon lands on login → types her work email → magic link. Don't change `continue_url` in `dk-install-callback` without also changing the install-page logic.

**Vercel deploys from `github.com/jlyonsld/DK` `main`.** Branch protection is OFF. `git push` on `main` triggers a production deploy within ~30 seconds. Test locally or in a branch first if you're not confident.

**The archived PAR source at `~/Documents/Claude/Projects/Selectively/PAR-NATIVE-archive/source-original/` is NOT the live PAR repo.** The live PAR repo is at `~/selectively` (connected to `git@github.com:jlyonsld/Selectively.git`). Edits to the archive don't deploy. Easy to get wrong when assisting with PAR work.

**PAR and DK share `PAR_SPOKE_API_KEY` and `SPOKE_INSTALL_SIGNING_SECRET`.** If you rotate either, rotate on BOTH Supabase projects simultaneously or the federation breaks.

**The closures table has no cleanup.** `install_nonces` too. Both grow unbounded. Cheap for now (<1000 rows/year) but eventually worth a nightly pg_cron purge of old rows.

**Classes' `times` field is parsed by a brittle regex.** See `parseClassDurationMinutes()` in `app.js`. If Jackrabbit ever changes its openings-feed time format, the week-view block heights break. We default to 60 min duration on parse failure, so it degrades gracefully.

**Classes have two overlapping day/time columns: `days`+`times` (JR sync) vs. `day_time` (in-app editor).** JR populates structured `days` ("Mon, Wed") + `times` ("3:00 PM - 3:45 PM"); the class editor modal writes a single free-form `day_time` ("Fridays, 3:00–3:45 PM"). All three schedule helpers (`classRunsOnDay`, `classStartTimeOn`, `parseClassDurationMinutes`) check the JR columns first and fall back to `day_time`. Don't remove the fallback — any manually-added class disappears from the schedule if you do. A future cleanup could unify the columns, but matches CLAUDE.md §4.10's "string-based, not RRULE" principle as-is.

**`includeTestClass(c)` honors the Classes-tab "Show test classes" toggle across bento + schedule.** Toggle is session-only (not persisted). When off (the default), test classes stay invisible across home bento, teacher bento, schedule views, and `classesForDate`. When on, they appear everywhere — useful for testing features like clock-in/out against seeded test classes without deploying real data.

**Never use `(select email from auth.users where id = auth.uid())` in RLS policies.** The `authenticated` role lacks SELECT on `auth.users`, so any policy referencing it errors with "permission denied for table users" — and because multiple permissive policies are OR'd in a way that doesn't short-circuit on error, ONE broken policy on a table breaks INSERT/UPDATE for every role that has any policy there (even admins). Use `auth.jwt() ->> 'email'` — Supabase reads it straight off the JWT, no grant needed. All T3a/T3b teacher-scoped policies follow this pattern.

**`take_attendance` RPC is `security invoker`, `reconcile_students` is `security definer`.** `take_attendance` wants RLS to fire per INSERT so teachers can't write outside their grace window via the RPC. `reconcile_students` needs to move enrollments for an admin even if RLS would otherwise restrict; it's gated with an explicit `has_permission('reconcile_students')` check at the top.

**Student INSERTs use client-side `crypto.randomUUID()` ids.** Because teacher-scoped RLS on `students` only allows SELECT once the student is enrolled in one of the teacher's classes, `.insert().select().single()` would fail to read back the just-inserted row. The "+ Add student" flow pre-generates the UUID in JS so it can chain the enrollment INSERT without reading the student back.

**Attendance status enum still accepts `late` and `excused`.** The UI only writes `present` / `absent` / `unknown`, but the check constraint is kept permissive so historical rows and future states survive a schema change without a migration. Renderers fold `late` → Present and `excused` → Absent.

---

## 6. Open issues and half-built features

### Half-built / deferred by phase

- **Phase T1.5 — manager write access.** Strategy doc says managers should be able to edit templates/categories/infographics. RLS on those tables currently checks `is_admin()`, which excludes managers. UI gating treats them as read-only to match. Fix is a small migration extending those three tables' INSERT/UPDATE/DELETE policies to also allow `role = 'manager' AND has_permission('edit_templates')`. Untouched.

- **Phase T3 — attendance + clock-in/out + reports.** ✅ **All shipped.** Teachers and admins take per-session attendance (Present/Absent + late-pickup minutes) and clock in/out per class via the class detail panel or the teacher bento cards. Admin-only **Reports** tab ships with two entries: **Attendance** (summary, per-class breakdown, late-pickup log + CSV for billing) and **Teacher hours** (per-teacher payroll roll-up, shift log + CSV for payroll). See §4.13 – §4.16.

- **Phase T4 — sub requests / shift trades.** No schema. Strategy doc sketches `sub_requests` + `sub_claims` tables.

- **Phase T5 — curriculum / scripts / materials library.** No schema. Strategy doc sketches an admin-curated content library with optional DK-corporate-approval badges.

- **Phase T6 — role management UI + explicit `profiles.teacher_id` link + returning-user invitation redemption.** Today, promotion is manual SQL (or auto via PAR org ownership). `handle_new_user` only redeems invitations on FIRST sign-in. T6 adds an RPC or UI flow for admins to (a) change roles via a UI, (b) manually redeem a pending invitation for a returning user, (c) link a profile to a teacher row explicitly via a new `profiles.teacher_id` foreign key column.

- **Phase T7 — freemium upgrade prompt + conversion tracking.** PAR card on teacher bento with context-aware CTA, click-through analytics, usage-based triggers ("you've taken attendance 20 times, want PAR for your family too?"). The current teacher bento already has a simple "On PAR" card; T7 makes it smarter.

### Wave 1 leftovers (pre-freemium ops work)

- **FAQ page on the DK website.** Not started.
- **Jackrabbit email template rewrite.** Not started.
- **Meta → Mailchimp lead-intake automation.** Not started.

### Known rough edges

- **No sign-up page in the login UI.** First-time users must use the magic-link button (which auto-creates via Supabase OTP) or an admin pre-provisions them via the Supabase dashboard. There's no "click here to create an account" button.

- **Resend email sending is optional.** `dk-invite-teacher` calls Resend only if `RESEND_API_KEY` Edge secret is set AND `dk_config.sender_email` is populated. Otherwise it returns the accept URL and the UI modal prompts the admin to copy-paste into their own email client. Good fallback; could be tighter.

- **No error UI for unknown Edge Function failures on the Classes / Teachers / Templates tabs.** Supabase client errors bubble up to a toast; any un-toasted error shows only in the browser console. If you add a new mutation, ensure it `showToast(error.message, "error")` on failure.

- **Zoom ghost events + recurring-event exception diffs don't apply to DK** (that's a PAR-side concern for the calendar app). DK has no calendar integration beyond Jackrabbit.

- **Zoom/Apple/Outlook sync** — none. DK is not a calendar app.

- **`install_nonces` and `closures` grow unbounded.** See §5.

- **Teacher bento matches via email.** See §5. Fragile if a teacher has an alternate email on file; ignored case-insensitively in lookups.

- **The class `times` regex parser is strict.** See §5. Non-JR classes entered manually with unusual time formats may break the Week view (they'd silently not render blocks).

- **Closures are global, not per-school.** A closure on a given date flags EVERY class on the month grid that day, regardless of `classes.location`. Fine for single-location franchises; wrong for multi-school franchises where e.g. Mt Pleasant ES is closed but West Ashley ES isn't. Before loading real academic-calendar data, this needs a schema decision — either a `closures.location_filter` column (nullable = all schools) or a separate `school_calendars` table keyed by the school name/id used in `classes.location`.

- **Month-view `+N more` is calibrated to the web row cap.** The renderer computes overflow as `classes.length - 3`. On ≤720px CSS hides the 3rd row, so a cell with 4 classes visually shows 2 rows + "+1 more" even though 2 are hidden. Tap opens Day view where all render, so it's mild — but if it matters, move the overflow computation into CSS via `:nth-child` counters or re-render on viewport change.

- **Sharon's setup is still pending.** As of last session: DK code is complete, both Vercel frontends are deployed (needs one more push for schedule views + responsive pass), PAR's `SPOKE_INSTALL_SIGNING_SECRET` is set on both Supabase projects. What remains: Sharon creates her PAR account with personal email, creates her franchise org, adds her work email via PAR's Linked Accounts UI, clicks Install Drama Kids, signs into DK with her work email via magic-link. Walkthrough doc at `SHARON_ONBOARDING_WALKTHROUGH.md`.

### Environment variables required

```
# No frontend .env — config.js has the Supabase URL + publishable key
# (the publishable key is safe in the browser; writes are RLS-gated).

# Supabase Edge Function secrets (set via dashboard for DK project):
SUPABASE_SERVICE_ROLE_KEY        # auto-injected by Supabase
PAR_SPOKE_API_KEY                # bearer token for PAR's spoke-* endpoints
SPOKE_INSTALL_SIGNING_SECRET     # shared HMAC secret with PAR; 96-char hex
RESEND_API_KEY                   # optional — unset = invitation-email path skipped
X_CRON_SECRET                    # for jackrabbit-sync pg_cron authentication
ZAPIER_SECRET                    # for zapier-enrollment-webhook X-Zap-Secret header
JACKRABBIT_ORG_ID                # "551000" for the Charleston franchise
```

### Spoke-side status across the PAR DK deployment

| Milestone | Status |
|---|---|
| T0 — Role schema foundation | ✅ Shipped |
| T1 — UI gating by role | ✅ Shipped |
| T1.5 — Manager write RLS | 🔲 Not started |
| T2 — Teacher invitation flow (code-complete) | ✅ Shipped, awaiting Sharon's PAR setup |
| Spoke install-flow platform (Phase A + B) | ✅ Shipped, awaiting Sharon's PAR setup |
| Schedule tab (Day / Week / Month) + closures | ✅ Shipped |
| Full responsive pass | ✅ Shipped |
| T3 — Attendance + clock-in/out + Reports tab | ✅ Shipped |
| T4 — Sub requests / shift trades | 🔲 Not started |
| T5 — Curriculum library | 🔲 Not started |
| T6 — Role management UI + profiles.teacher_id | 🔲 Not started |
| T7 — Freemium conversion tracking | 🔲 Not started |
