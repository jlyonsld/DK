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
│                                 - Classes (card grid + detail expand panel)
│                                 - Teachers (table + edit modal)
│                                 - Categories (inline editor)
│                                 - Infographics (sidebar + management table)
│                                 - Invitations (editor modal + result modal)
│                                 - Closures manager modal
│                                 - PAR identity bridge (par-identity-proxy
│                                   call on boot)
├── styles.css                ← ~2100 lines. Tokens (CSS vars for colors /
│                               radii / spacing), global resets, component
│                               classes, schedule-view layouts, and a
│                               responsive pass under two media queries:
│                               ≤720px (phones & small tablets) and ≤380px
│                               (iPhone SE-class). The ≤720px block hides
│                               the top `.tabs` and shows the fixed-bottom
│                               `.mobile-tabbar` (see §4.17).
├── config.js                 ← Supabase URL + publishable key. The
│                               publishable key is safe in the browser —
│                               every write is RLS-gated.
├── logo.png                  ← 1024² PAR DK brand mark. Also the source
│                               for the PWA icon set below — regenerate
│                               via `sips` if you replace it (see §4.18).
├── manifest.webmanifest      ← PWA manifest. Name, short_name ("PAR DK"),
│                               navy theme/background (#0b1638), and the
│                               three icon entries. See §4.18.
├── sw.js                     ← Minimal pass-through service worker.
│                               No caching — exists only to satisfy PWA
│                               install criteria. See §4.18 + §5.
├── apple-touch-icon.png      ← 180×180 — iOS home-screen icon.
├── icon-192.png              ← 192×192 — Android home-screen / manifest.
├── icon-512.png              ← 512×512 — Android splash / manifest.
├── icon-maskable-512.png     ← 512×512 maskable — Android adaptive icon.
├── favicon-32.png            ← 32×32 browser tab.
├── favicon-16.png            ← 16×16 browser tab.
├── README.md                 ← Older. May be stale.
│
├── CLAUDE.md                 ← This file.
│
├── T1_VERIFICATION.md        ← Role-swap SQL snippets for verifying the
│                               Phase T1 role gating behavior.
├── T2_VERIFICATION.md        ← Setup + test steps for the teacher invitation
│                               flow (what Sharon must configure + how to test
│                               that the invite/redemption round-trip works).
├── T4_VERIFICATION.md        ← End-to-end test plan for sub requests:
│                               create / claim / fill / cancel round-trip,
│                               RLS spot checks, schedule badge sanity.
├── SCHOOLS_VERIFICATION.md   ← End-to-end test plan for Phase T8 schools:
│                               migration backfill, schools tab, class
│                               editor dropdown, cancel-class flow,
│                               notify-daily-contact email + mailto.
├── INSTALL_FLOW_VERIFICATION.md ← End-to-end test plan for the spoke install
│                               flow: share-the-secret, do-a-test-install,
│                               verify auto-promote, SQL spot checks.
├── SHARON_ONBOARDING_WALKTHROUGH.md ← The step-by-step for walking Sharon
│                               through her first PAR + PAR DK setup,
│                               including the personal/work email split.
│
└── migrations/               ← SQL migrations applied to Supabase in order.
    │                           **Lives inside the deployed repo as of
    │                           T4** so PR review and history sit alongside
    │                           the code that depends on them. Vercel
    │                           ignores .sql files — they don't ship to
    │                           the browser, they're just colocated.
    │                           Apply via the Supabase MCP `apply_migration`
    │                           or via the Supabase dashboard SQL editor.
    │                           Earlier migrations (T0–T3d) were applied
    │                           before this convention; their .sql sources
    │                           live in the parent `DK Optimization/`
    │                           folder and are NOT in this repo.
    ├── phase_t4_sub_requests.sql        ← Sub requests + claims schema +
    │                                      RLS + RPCs. See §4.20.
    ├── phase_t5a_curriculum_library.sql ← curriculum_items table +
    │                                      private curriculum-assets
    │                                      bucket. New perms:
    │                                      edit_curriculum,
    │                                      assign_curriculum. See §4.22.
    ├── phase_t5b_curriculum_assignments.sql ← curriculum_assignments
    │                                      (item × class × teacher) +
    │                                      widened curriculum_items
    │                                      SELECT for assigned
    │                                      teachers + the
    │                                      set_curriculum_assignment_notes
    │                                      RPC. See §4.22.
    ├── phase_t5c_curriculum_audit.sql    ← curriculum_access_log
    │                                      (append-only audit). RLS
    │                                      SELECT to assign_curriculum
    │                                      / edit_curriculum holders;
    │                                      INSERT only via service-role
    │                                      from curriculum-fetch. See
    │                                      §4.22.
    ├── phase_t6_teacher_personnel.sql   ← Adds personnel fields to
    │                                      teachers (DOB, address, payroll,
    │                                      background-check). Backs the
    │                                      full-record teacher edit modal.
    ├── phase_t6b_personnel_payments_waivers.sql
    │                                    ← teacher_payment_details (super_admin
    │                                      + admin only), teacher_documents +
    │                                      private teacher-documents bucket,
    │                                      liability_waivers (versioned text)
    │                                      + liability_waiver_signatures
    │                                      (append-only audit) +
    │                                      record_waiver_signature RPC. New
    │                                      perms: manage_teacher_payments,
    │                                      manage_teacher_compliance. See
    │                                      §4.23.
    ├── phase_t6c_payment_methods.sql    ← payment_methods table — super_admin-
    │                                      managed list of options for
    │                                      teachers.payment_method. SELECT
    │                                      open to all authenticated; writes
    │                                      gated on is_super_admin() directly
    │                                      (no new permission). Drops the
    │                                      legacy teachers_payment_method_check
    │                                      constraint; the table is now the
    │                                      source of truth. Each row's `kind`
    │                                      ∈ {bank, handle, none} drives
    │                                      personnel-modal sub-field
    │                                      visibility.
    └── phase_t8_schools.sql             ← schools + class_cancellations
                                            tables, classes.school_id FK,
                                            mark_class_cancellation_notified
                                            RPC. See §4.21.
```

**Pre-T4 migrations (not in repo) live at the parent folder:**

```
DK Optimization/                ← parent folder, NOT a git repo
├── migrations/                 ← legacy SQL sources for T0–T3d.
│   ├── phase_t0_role_foundation.sql
│   ├── phase_t1_5_manager_writes.sql
│   ├── phase_t2_teacher_invitations.sql
│   ├── phase_s1_closures.sql
│   ├── phase_t3_permissions.sql
│   ├── phase_t3a_student_adds.sql
│   ├── phase_t3b_attendance.sql
│   ├── phase_t3c_late_pickup.sql
│   └── phase_t3d_clock_in_out.sql
├── edge-functions/             ← Deno sources for Edge Functions deployed
│   │                             to DK's Supabase project.
│   └── dk-invite-teacher/index.ts
└── plans/                      ← Strategy + spec docs. Authoritative for
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
| `curriculum-fetch` | false | T5c. The ONLY path that mints signed URLs against the private `curriculum-assets` bucket. Verifies caller is the assigned teacher (or an admin/manager preview), re-runs the lead-window check server-side, mints a 5-minute signed URL via service-role, and inserts a row into `curriculum_access_log`. **Verifies the JWT manually inside the handler via `auth.getUser(jwt)`** — same pattern as `par-identity-proxy`. We tried `verify_jwt: true` first but the platform's gateway rejections weren't appearing in function logs, which made debugging impossible. Manual verification still requires a valid JWT but gives full log visibility + descriptive error messages. See §4.22. |

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
curriculum_items         — DK-curated lesson library (PDFs, videos,
                           images, scripts, links). Stored in the
                           private `curriculum-assets` bucket. T5b
                           widens SELECT to assigned teachers; T5c
                           adds the watermarked viewer + audit log.
                           See §4.22.
curriculum_assignments   — (curriculum_item_id, class_id, teacher_id)
                           rows linking items to specific teacher+
                           class pairs. lead_days_override is per-
                           assignment; null inherits from the parent
                           item's default. teacher_notes is the
                           teacher's private scratchpad on this
                           item-in-this-class, written via the
                           set_curriculum_assignment_notes RPC
                           (security definer, identity-checked) so
                           teachers can mutate only that one column
                           on rows they own. See §4.22.
curriculum_access_log    — append-only audit of every successful
                           signed-URL mint by the curriculum-fetch
                           Edge Function. access_kind in {view,
                           preview}. SELECT gated to admin/manager
                           (assign_curriculum / edit_curriculum);
                           INSERT only happens via service-role
                           from inside the Edge Function. No
                           UPDATE/DELETE policies — append-only
                           by design. See §4.22.
teacher_invitations      — DK-side mirror of PAR invitations (see §4.6)
schools                  — first-class school records with primary +
                           daily contacts. classes.school_id is the FK;
                           classes.location stays as a free-form fallback
                           string for JR-synced classes. See §4.21.
class_cancellations      — single-session class cancellations (one row
                           per class_id+session_date). Distinct from
                           closures (whole-day, all-classes-at-a-school).
                           Schedule renders cancelled blocks muted; the
                           notify modal stamps notified_at via
                           mark_class_cancellation_notified RPC. See §4.21.
sub_requests             — open / filled / cancelled requests for a teacher
                           sub on a specific class+session_date. Created via
                           create_sub_request RPC; filled via fill_sub_request.
                           See §4.20.
sub_claims               — teachers' offers to cover an open sub_request.
                           Status pending → accepted | declined | withdrawn,
                           transitions are atomic with sub_requests fills.
                           See §4.20.
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

### 4.5 `is_admin()` was redefined, not replaced — and is being gradually retired in favor of `has_permission()`

Phase T0 expanded roles from `{admin, teacher}` to `{super_admin, admin, manager, teacher, viewer}`. Instead of rewriting every existing RLS policy, we redefined `is_admin()` to match both `super_admin` AND `admin`. Every pre-existing policy that gated writes with `using (is_admin())` continued to work for super_admins without change. Don't "fix" `is_admin()` to mean only `admin` — it still gates the remaining admin-only tables (`class_infographics`, `teacher_invitations`, `dk_config`, `role_audit`, `install_nonces`, etc.) and would break those silently.

Subsequent phases migrate specific write scopes off `is_admin()` onto `has_permission('edit_<resource>')`, a scope at a time:

- **T3 (attendance / students / enrollments / clock_ins)** already use `has_permission()` with teacher-scoped conditions (see `migrations/phase_t3[a-d]_*.sql`).
- **T1.5 (templates / categories / infographics / teachers / classes / class_teachers / closures)** swapped from `is_admin()` to `has_permission('edit_<resource>')` so managers can write them (see `migrations/phase_t1_5_manager_writes.sql`). Admin and super_admin kept the same permissions via their bundles; the swap is a strict superset.

The pattern lets us extend per-user grants/revocations (via `profiles.granted_permissions` / `revoked_permissions`) uniformly wherever a table has been migrated off `is_admin()`. See `migrations/phase_t0_role_foundation.sql` for the original `is_admin()` / `has_permission()` definitions.

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

**Term boundaries via `classes.start_date` / `classes.end_date`** (both `date`, nullable). `classRunsOnDay()` short-circuits false when the queried date falls outside the window — null on either side means open-ended (matches the legacy default). Both columns predate JR-sync awareness of term dates, so JR-synced rows are typically null today; the in-app class editor exposes "Starts on" / "Ends on" date inputs so admins can scope manually-added classes (camps, contracted runs) to a real term. When/if JR sync grows term-date support, it just starts populating these columns and nothing else changes — this is why the columns existed before the editor UI did.

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

### 4.17 Mobile navigation mirrors PAR's lower menu

At ≤720px the scrollable top tab bar (`.tabs`) is hidden and replaced by a fixed-bottom `.mobile-tabbar` styled after PAR's lower menu: Home · Schedule · **Tools** (elevated circular center slot) · Classes · Teachers. Tapping Tools opens `.mobile-tools-overlay` as a bottom sheet listing Templates / Categories / Infographics / Reports — i.e., the response-console "tool" tabs that don't merit a fixed mobile slot.

Each `.mtab[data-tab]` button carries the same `data-tab` attribute as its desktop `.tab` counterpart, so `go(tab)` at [app.js](app.js) routes both identically. The three places that iterate tabs (`go()` active-class toggle, `applyRoleVisibility()`, and the click-wire in `wireEvents()`) all use the unified selector `.tab, .mtab[data-tab], .mobile-tools-item`. The Tools center button has no `data-tab` and is wired separately to open/close the sheet.

Role gating is automatic via `canSeeTab()`. For the teacher role (Home + Schedule only), `applyRoleVisibility()` hides the three non-visible mtabs AND the Tools center slot (since no tool tabs are visible to teachers); the remaining two slots auto-center because the bar uses `justify-content: space-evenly`. The center slot is `position: relative; margin-top: -22px` with a ring of `--panel-solid` shadow so it visually "pops" above the bar — don't change the shadow without also re-checking the bar's top border.

Body gets `padding-bottom: calc(76px + env(safe-area-inset-bottom))` at ≤720px so page content isn't hidden behind the fixed bar on iPhones with home-indicator bezels. If you add new full-height views, make sure they respect that bottom padding or scroll containers will clip under the bar.

**When you add a new tab,** update three places together: `index.html` (top `.tabs` + either an `.mtab` for a first-class mobile slot OR a `.mobile-tools-item` for an overflow-sheet entry), `ROLE_TAB_VISIBILITY` in `app.js` (add the new tab name to every role Set that should see it), and the Tools-button auto-hide list in `applyRoleVisibility()` if the tab belongs in the overflow sheet.

### 4.18 Installable PWA — minimal manifest, pass-through service worker

DK installs to iOS / Android home screens and macOS / Windows desktops as a standalone PWA. The wiring is in three places:

1. **`manifest.webmanifest`** declares `name` ("PAR DK · Response Console"), `short_name` ("PAR DK" — what shows under the home-screen icon, kept short for iOS truncation), navy `background_color` and `theme_color` (`#0b1638`, matching the logo's baked-in background), `display: standalone`, and three icon entries (192 any, 512 any, 512 maskable).
2. **`<head>` of `index.html` AND `install.html`** carries the icon links (32/16 favicon, apple-touch), the manifest link, `theme-color`, and the four `apple-mobile-web-app-*` meta tags. `install.html` is included so a user clicking through PAR's spoke install flow on a fresh device gets the same icons / standalone behavior end-to-end.
3. **`sw.js`** is a deliberately minimal pass-through service worker — `skipWaiting` + `clients.claim` + a fetch handler that ignores cross-origin requests entirely (Supabase API, jsdelivr CDN, fonts) and lets same-origin requests fall through to the network. **No fake 503 "Offline" fallback.** An earlier version returned `new Response('Offline', { status: 503 })` on any fetch failure, which masked real CORS / network errors as a generic 503 — a curriculum-fetch CORS issue surfaced as `503 Offline` in the UI for an entire debugging session because of this. If we ever need offline support, design a versioned cache + force-update story first; do not bring back a blanket fallback. It does no caching and stores nothing. It exists for two reasons: (a) Chrome's installability check requires a SW with a fetch handler, (b) iOS treats sites with any SW as "real" web apps with better standalone behavior. Registered from `index.html` via a tiny inline script after `app.js` loads.

**Why pass-through, not a caching SW.** Per §5, Vercel redeploys reach the live site in ~30s — aggressive SW caching would gate that visibility behind a registration update + reload, which is exactly the failure mode that makes "did my push deploy?" investigations painful. The browser's HTTP cache + Vercel's CDN are sufficient. If you ever need offline support, design a versioning + force-update story first.

**Regenerating icons.** All six PNG sizes derive from the 1024² `logo.png` source via macOS `sips` (`sips -z <size> <size> logo.png --out <name>.png`). Keep them in sync — a stale icon size will silently win on whichever platform happens to prefer it. The maskable variant uses the same source as `icon-512.png` because the logo's navy background fills the square (no transparent corners to clip).

**Notch / safe-area handling — navy must reach the top of the screen.** Three coordinated pieces:

1. The viewport meta on both `index.html` and `install.html` includes `viewport-fit=cover` so the page extends edge-to-edge on notched devices and `env(safe-area-inset-top)` returns a non-zero value.
2. `html { background: var(--slate-950); }` in `styles.css` so iOS rubber-band overscroll at the top reveals dark, not the default white. The body's `--bg-gradient` covers the visible page area; this catches the area outside the body during overscroll.
3. `.header-top` uses `padding: calc(16px + env(safe-area-inset-top)) 22px 16px` so the brand row + Sign-out drop below the notch instead of clipping under it. The header's translucent slate-900 background then visually fills the notch area.

If you change the viewport meta, the `html` background, or the header padding, re-test in iOS Safari AND in standalone PWA mode (Add to Home Screen → open from icon) — the two render the top region differently and a regression in either is easy to miss. The bottom counterpart (`mobile-tabbar` + body `padding-bottom: calc(76px + env(safe-area-inset-bottom))`) is documented in §4.17.

### 4.19 Per-tab action buttons live in the panel, not the global header

The only buttons in `<header>` `.header-actions` are user-chip and Sign out — controls that apply across every tab. Tab-specific actions (`＋ New template`, `＋ New class`, `＋ New teacher`, `＋ New category`, `＋ Upload / add image`, `⟳ Sync now`, `✉ Invite user`, `⟳ Refresh PAR links`) all live inside their own tab panel's `.tab-head` row, so they only show when their tab is active. Role gating for them is consolidated in `applyRoleVisibility()` in `app.js` — one `if (btn) btn.style.display = hasPerm(...) ? "" : "none"` line per button. **When you add a new tab-scoped action**, follow the pattern: button inside the panel's `.tab-head`, gating line in the per-tab block of `applyRoleVisibility()`. Don't put it in the global header — every other tab will get visual clutter for an action they can't use.

### 4.20 Sub requests are class+session-scoped with claim/fill atomicity

A `sub_requests` row keys on `(class_id, session_date)` — one open or filled request per session, enforced by a partial unique index that excludes cancelled rows so a fresh request can be reopened after a cancellation. Teachers, managers, and admins can all create requests; teachers must be assigned to the class (RLS check via `class_teachers` + `auth.jwt() ->> 'email'` join, mirroring §4.14's attendance pattern), admins/managers can file on a teacher's behalf via the separate `create_sub_request_for(class_id, session_date, teacher_id, reason)` RPC.

Other teachers offer to cover via `claim_sub_request(req_id, note)`, which `INSERT … ON CONFLICT (sub_request_id, claimed_by_teacher_id) DO UPDATE` so re-offering after a withdraw resets the claim back to `pending` instead of erroring. **The `fill_sub_request(req_id, teacher_id)` RPC is the only place a request transitions to `filled`** — and in the same transaction it flips the chosen teacher's claim to `accepted` and any sibling pending claims to `declined`. This means the UI never has to reconcile "request says filled but claims still show pending" — they always agree. `cancel_sub_request` does the symmetric cleanup: marks the request `cancelled` and any pending claims `declined`.

UI surfaces:
- **"Sub requests" tab** — visible to every signed-in role (teachers see `Open` and `Mine` filters; managers/admins also see `All`). Cards group by status with per-card `Offer to cover` / `Withdraw` (claimer) and `Pick this teacher` / `Cancel request` (admin) actions. Admins also get a "Assign teacher directly…" select that bypasses claims for emergency direct assignments.
- **Class detail panel** — a `Request sub` button next to `Take attendance` / `Clock in`, pre-filled with `nextSessionDateForClass(cls)`. If a request already exists for that next session, the button is replaced by a clickable status pill that jumps straight to the Sub requests tab.
- **Schedule week + month views** — a small badge (🔄 open, ✓ filled) overlays class blocks that have an active request for the rendered date, computed via `activeSubRequestForSession(cls.id, dateIso)`.

Permissions: `request_sub` (teacher, manager, admin, super_admin) — already in T0's bundles, the file-on-behalf path layers `manage_all_sub_requests` on top. `claim_sub_requests` (teacher, manager, admin, super_admin) gates the Offer button. `manage_all_sub_requests` (manager, admin, super_admin) gates Fill / file-on-behalf / cancel-anyone-else. All three sit alongside the existing `has_permission()` flow — no new RLS pattern.

The realtime channel watches `sub_requests` and `sub_claims` so a claim from another teacher's phone lights up the admin's open-card list inside the 300ms debounce window. Both tables are added to `supabase_realtime` by the migration.

### 4.21 Schools are first-class; `classes.location` stays as a fallback string

Phase T8 promotes the free-form `classes.location` text into a real `schools` table with primary + daily contacts. **`classes.location` is intentionally not removed.** The Jackrabbit nightly sync writes `location`; we don't want to teach the sync about schools, so the column stays as the JR-of-record source. The schema adds `classes.school_id` (nullable FK) alongside it, and the migration auto-creates one `schools` row per distinct `location` value plus backfills `school_id` to match. New classes created in the app pick a school from a dropdown; `school_id` wins when set, `location` is the display fallback when not. `classLocationLabel(cls)` and `schoolForClass(cls)` are the two helpers — use them everywhere instead of reaching for `cls.location` directly.

Each school carries two contacts: **primary** (long-term ops — principal, activities director) and **daily** (day-of-class person — front desk, after-care coordinator). Same person allowed via the "Copy from primary" button in the school editor. The daily-contact email is what powers the notify-daily-contact flow.

`class_cancellations` is a thin table — `(class_id, session_date)` unique — that records single-session cancellations. **Distinct from `closures`**, which is whole-day + all-classes-at-the-school. Cancelling a class via the "Cancel class" button on the class detail panel inserts a row, mutes the schedule block (line-through + opacity), and immediately pops the notify modal so the admin can email the school. The cancellation row's `notified_at` timestamp is stamped when the admin clicks "Open in email app" (via the `mark_class_cancellation_notified` RPC) so re-notification can show "notified ✓".

The notify modal (`openNotifyModal({ kind, cls, sessionDate, ... })`) handles three notification kinds — `sub_assigned` (auto-pops after `fill_sub_request` success when the linked school has a daily contact), `class_cancelled` (auto-pops after class-cancel save), and `adhoc` (the always-available "✉ Notify daily contact" button on the class panel). Subject + body are pre-filled but fully editable; "Copy email" pushes both to the clipboard, "Open in email app" launches `mailto:` with the daily contact pre-filled. **No actual SMTP** — DK doesn't send email itself; admins prefer to send from their own work address (better deliverability + reply threading). This is the same copy-paste-fallback pattern as the teacher-invitation modal when Resend is unset.

Permissions: schools and class_cancellations writes are gated on the existing `edit_classes` permission — no new permission name. Anyone signed in can SELECT both tables (the schedule needs cancellation data for every viewer to render line-throughs correctly).

### 4.22 Curriculum library is private-by-default with three slices

DK corporate is serious about access to its curriculum, so the library is built as a layered cake instead of a single feature. Each slice ships independently:

- **T5a (✅ shipped):** `curriculum_items` table + admin/manager CRUD on the **Curriculum** tab. Five asset types — `pdf` / `video` / `image` / `script` / `link`. Items live in a private `curriculum-assets` Storage bucket (writes gated on `edit_curriculum`, **no SELECT policy at all** — direct browser reads of the bucket are blocked by RLS denying everything that isn't whitelisted). `default_lead_days` is admin-configurable per item; `dk_approved` is a soft badge. Two new permissions: `edit_curriculum` (admin/manager/super_admin) and `assign_curriculum` (same — managers can assign within scope per franchise direction).
- **T5b (✅ shipped):** `curriculum_assignments` table keyed `(curriculum_item_id, class_id, teacher_id)` with optional `lead_days_override` (null = inherit `curriculum_items.default_lead_days`). Admin/manager **Assign…** modal off each curriculum row lists current pairings and an inline "+ Add assignment" form whose teacher dropdown narrows to teachers actually on the chosen class via `class_teachers`. Curriculum tab grows a `👥 N assigned` chip per row. Teacher home gets a **Your curriculum** bento card grouped by class: each item shows a 🔒 / 🔓 lock chip computed by `curriculumLeadWindowState()` against `nextSessionDateForClass()` (rolling per-session — `now >= nextSession - leadDays`). Unlocked `link` items open in a new tab; unlocked `script` items render in a read-only viewer modal; `pdf` / `video` / `image` are handled by T5c's watermarked viewer. Teacher visibility on `curriculum_items` widens via a second permissive SELECT policy that joins through `curriculum_assignments` + `teachers.email` (CLAUDE.md §5 pattern). **Teacher notes travel with the assignment** — every card has a `My notes` textarea backed by `curriculum_assignments.teacher_notes`, written via the `set_curriculum_assignment_notes(p_assignment_id, p_notes)` RPC (`security definer`, identity-checked against `auth.jwt() ->> 'email'`) so teachers can mutate only that column on rows they own and can't reassign or re-target their own assignment via raw UPDATE. Curators can leave a `notes` (admin-side) string on any assignment that the teacher sees as a "From Sharon:" callout. No new permissions — `assign_curriculum` (T5a) and `view_own_curriculum` (T0) cover everything. See `migrations/phase_t5b_curriculum_assignments.sql` and `T5B_VERIFICATION.md`.
- **T5c (✅ shipped):** `curriculum_access_log` (append-only audit) + Edge Function `curriculum-fetch` (verify_jwt: **false** — handler verifies the JWT manually via `auth.getUser(jwt)`, same pattern as `par-identity-proxy`; the platform's gateway-layer rejections weren't appearing in function logs and made debugging impossible) that gates every read against the private `curriculum-assets` bucket. The bucket has no SELECT policy — direct browser reads are denied — so the function (using the service-role key) is the only path. For `kind: 'view'` it verifies the caller is the assignment's teacher and re-runs the lead-window check server-side; for `kind: 'preview'` it verifies admin/manager curator role. Either path mints a 5-minute signed URL and inserts a row into `curriculum_access_log` before returning. The watermarked viewer renders PDFs via PDF.js (v4 ESM, lazy-loaded via dynamic `import()` from the CDN — no build step, no initial page-weight cost), videos via `<video controlsList="nodownload" disablePictureInPicture>`, images via `<img>` — all behind a CSS-tiled overlay (`pointer-events:none`) with the user's name + email + ISO timestamp + context label, plus `contextmenu` / `selectstart` / `copy` / Cmd-S/P/C keydown suppression on the modal subtree. None of the suppression is unbreakable; the watermark + audit log make any leaked screenshot trivially traceable. The admin curriculum edit modal grows a **"Preview (watermarked)"** button (visible only on saved bucket-stored items) that uses the same viewer with `kind: 'preview'` so curators are also auditable. See `migrations/phase_t5c_curriculum_audit.sql`, `edge-functions/curriculum-fetch/index.ts`, and `T5C_VERIFICATION.md`.

**Where teachers actually see assigned curriculum.** Home tab → full-width **Your curriculum** bento card (`renderTeacherCurriculumCard` at app.js). The card is gated by THREE conditions, all of which must be true at the same time, or it doesn't render: (1) the signed-in user's `profiles.role = 'teacher'` — admins / managers / super_admins see the **Curriculum** library tab instead, never the bento card; (2) a `teachers` row exists with `lower(email) = lower(auth.jwt() ->> 'email')` — admins who happen to also teach can match here, but most won't; (3) at least one `curriculum_assignments` row exists with that teacher's `id`. If you're testing assigned-content visibility and the card isn't appearing, the failure is almost always #1 (you're signed in as super_admin) or #2 (the teacher's `teachers.email` doesn't exactly match their auth email). When debugging, sign in as the teacher in question — there's no "view as teacher" override.

**Lead-window is enforced at three layers, not RLS.** The user-confirmed semantic is "rolling per-session" (a teacher gets access N days before *each* upcoming session, not once at the start of the term). Encoding that in RLS would require evaluating the class's recurring `days`/`times` strings inside SQL — brittle and slow. So the gate lives in (a) the client UI (lock icons + countdown chips), (b) T5c's Edge Function (refuses to mint a signed URL until `now() >= next_session - lead_days`), and (c) the audit log (every fetched URL records who saw what when). RLS only verifies "an assignment exists" — read access alone tells corporate nothing without the access-log entry to match it.

**Why three permissions instead of one.** `edit_curriculum` covers writes to the library. `assign_curriculum` is a separate gate so a future role split can give one person curating powers without hand-out powers, or vice versa. `view_own_curriculum` already lived in the teacher bundle from Phase T0 — T5b uses it.

### 4.23 Personnel — payment details, documents, e-signed waiver (T6b)

T6a (`phase_t6_teacher_personnel.sql`) added basic personnel columns to `teachers` (DOB, address, emergency contact, employment classification, background-check). T6b layers the sensitive-PII tables on top — bank/routing/account, document storage, and the e-signed liability waiver — without further widening the `teachers` row itself. Sensitive PII lives in dedicated tables behind dedicated permissions; the existing `edit_teachers` (manager+) keeps writing only the classroom-relevant fields.

Two new permissions, both currently at admin+super_admin:

- **`manage_teacher_payments`** — gates `teacher_payment_details` and the bank/account fields on the personnel modal. Splitting the permission name lets a franchise owner later revoke payments from a specific admin (e.g. a non-bookkeeper ops admin) via `profiles.revoked_permissions` without losing their compliance access.
- **`manage_teacher_compliance`** — gates `teacher_documents`, the `teacher-documents` storage bucket, the waiver-signing UI, and `liability_waiver_signatures` reads.

Three storage / data layers:

- **`teacher_payment_details`** — one row per teacher (PK = teacher_id). Holds `bank_name`, `account_type`, `routing_number`, `account_number`, `payment_handle` (PayPal/Venmo/Zelle), `notes`. Plaintext at the column level — Supabase encrypts at rest at the storage layer; a future hardening pass could move these to pgsodium-encrypted columns without changing the table shape. Touch trigger stamps `updated_at`/`updated_by` on insert/update so the bookkeeper's last-edit is always recorded. The personnel modal upserts this row only if at least one payment field is non-empty (or the row already exists).
- **`teacher_documents` + private `teacher-documents` Storage bucket** — metadata table + uploaded files. `kind` enum covers tax forms (`tax_w9`/`tax_w4`/`tax_1099`), certifications (`certification_cpr`/`certification_first_aid`/`certification_background`/`certification_other`), and `other`. `expires_on` is for certifications, used by the UI to render expiring/expired badges in the doc list. Storage paths are `${teacher_id}/${kind}-${timestamp}-${safeName}`. **Unlike curriculum-assets** (T5a/c, which has NO SELECT policy because reads go through an Edge Function intermediary), `teacher-documents` DOES expose SELECT to authenticated callers who hold `manage_teacher_compliance` — admins read directly via `createSignedUrl()` (10-minute TTL). The metadata table already restricts visibility to those callers, so adding a parallel storage SELECT policy is consistent. No per-row authorization story is needed (admins can see everything; no Edge Function intermediary required).
- **`liability_waivers` + `liability_waiver_signatures`** — versioned waiver text + append-only signature audit. The waivers table allows exactly one active row at a time (partial unique index `liability_waivers_one_active`). The signatures table has NO INSERT/UPDATE/DELETE policies — `record_waiver_signature(p_teacher_id, p_waiver_id, p_typed_name, p_signer_ip, p_user_agent)` is the only writer. The RPC is `security definer` and gates either on the caller being the teacher whose waiver is being signed (email match against `auth.jwt() ->> 'email'`) OR on the caller holding `manage_teacher_compliance` (admin recording in person). Side-effect: stamps `teachers.liability_waiver_signed = true` and `liability_waiver_date = current_date` so the existing personnel-modal flag keeps reading correctly without joining the signatures table.

Two UI entry points use the same sign modal (`#waiverSignOverlay`):

- **Admin-recorded path** — Teacher edit modal → Liability waiver section → "Read & sign waiver…" button. Opens the modal with `mode: "admin"`. Used when a teacher physically signs paperwork at onboarding and the admin records it.
- **Teacher self-sign path** — Teacher home bento gets a top-row banner ("Action required: please read & sign…") if the signed-in teacher is missing a signature for the current active waiver (or signed an older version). Tap → modal with `mode: "self"`. Banner clears after the next reload following a successful sign.

The modal renders the waiver `body_html` in a scrollable read-only block, requires both the agree-checkbox and a non-empty typed name (Submit button stays disabled otherwise), and posts to the RPC. A 401-style failure (caller is neither the teacher nor a compliance admin) surfaces as an inline error in the modal; the sign button stays clickable for retry.

**Why `liability_waiver_signed`/`liability_waiver_date` stay on the teachers row.** They're a snapshot, not the source of truth. The signatures table is canonical; the booleans on `teachers` are a denormalized convenience for the personnel modal flag and any quick "has this teacher signed?" filters. The RPC writes both atomically, so they never drift. Don't try to compute the booleans from a JOIN at read-time — it'd add a query to every teacher list render for no benefit.

**Lightweight (a) vs. heavyweight (b) for the e-signature.** v1 ships the lightweight path: typed name + checkbox + timestamp + IP + user-agent. Holds up legally for an internal employment waiver if the text is fixed and versioned (it is — `liability_waivers.version` is unique and the foreign key on signatures pins which version was signed). The seed waiver row v1 is placeholder text Sharon will edit through the UI before launch. If a heavyweight DocuSign/HelloSign integration is ever needed, the schema doesn't change — `liability_waiver_signatures` adds a column or a sibling table, the RPC's signing logic gets swapped, and the UI swaps the typed-name input for a redirect.

---

## 5. Gotchas, quirks, and "don't touch this"

**`is_admin()` matches super_admin OR admin.** See §4.5. Don't refactor it to mean just admin — it still gates the admin-only residue (`class_infographics`, `teacher_invitations`, `dk_config`, `role_audit`, `install_nonces`, etc.) that T3 and T1.5 didn't migrate to `has_permission()`.

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

**`sw.js` is pass-through, not caching, AND it must NEVER substitute a synthetic response on fetch failure.** It exists only to satisfy PWA install criteria (§4.18). Don't add caching casually — caching the static shell would gate Vercel deploys behind a SW registration update + reload, undoing the "push hits prod in ~30s" property the rest of this codebase relies on. **Equally important: don't `.catch()` the fetch and return a fake 503 / "Offline" response.** That masks real network / CORS errors from app code, which is exactly the trap that hid a stale-preflight CORS bug behind `503 Offline` for an entire debugging session. Cross-origin requests (Supabase, CDNs) are skipped entirely; same-origin requests fall through unchanged. If you genuinely need offline support, design versioning + a forced-update path AND a per-route allowlist for what gets the offline fallback first.

**Migrations live inside the deployed repo as of T4** (at `response-console-v3/migrations/*.sql`). Earlier phases (T0–T3d) were applied with their .sql sources living in the parent `DK Optimization/migrations/` folder, which is NOT a git repo and has no PR review trail. The convention shifted because PR reviewers want to see the schema change next to the code that depends on it. **When you write a new migration, put it in the in-repo folder, not the parent.** Vercel ignores .sql files (no build step touches them), so colocation is safe — they don't ship to the browser, they're just there for review and history.

**The `curriculum-assets` storage bucket has NO SELECT policy and that is intentional.** RLS on `storage.objects` is permissive — every read goes through whichever policies match. The T5a migration creates INSERT/UPDATE/DELETE policies scoped to this bucket but deliberately omits SELECT. With no matching SELECT policy, all direct browser reads of this bucket are denied. Reads happen exclusively via T5c's `curriculum-fetch` Edge Function using the service-role key (which bypasses RLS) after the function verifies an active assignment + lead-window. **Don't add a SELECT policy to this bucket** — it would let any teacher with a Supabase URL bypass the audit log and the lead-window gate. If the bucket ever needs admin-direct preview, do it through a dedicated Edge Function that still logs the access, not a SELECT policy.

**`set_curriculum_assignment_notes` is the ONLY path teachers can mutate `curriculum_assignments`.** The base UPDATE/INSERT/DELETE policies on `curriculum_assignments` are gated on `has_permission('assign_curriculum')`, which teachers don't hold. The RPC is `security definer` and verifies `auth.jwt() ->> 'email'` matches the assignment row's teacher's email before writing — and it touches **only** `teacher_notes` and `teacher_notes_updated_at`. **Don't add a teacher-self UPDATE policy on `curriculum_assignments`** — it would either need column-level grants (invasive, risks breaking the admin path) or it would let a teacher mutate their own `lead_days_override`, `class_id`, or `teacher_id` and silently re-target their assignment. The RPC pattern is the entire reason teacher_notes lives on the assignment row instead of a separate table.

**Teacher visibility on `curriculum_items` is two permissive policies, OR'd.** T5a's `curriculum_items_select_admin` covers `edit_curriculum` / `assign_curriculum` holders; T5b's `curriculum_items_select_teacher` joins through `curriculum_assignments` + `teachers.email` to expose exactly the items a teacher is assigned to (and only when `is_archived = false`). If you simplify this to a single policy with an `OR`, you lose the archived-items hide for teachers AND make the admin path harder to disable independently. Both policies use `auth.jwt() ->> 'email'` per §5's rule against referencing `auth.users` from RLS.

**Curriculum lead-window enforcement is layered, not RLS.** RLS only verifies "an assignment row exists." The rolling per-session unlock (`now >= nextSession - leadDays`) is computed client-side by `curriculumLeadWindowState()` for the lock chip + the View-button gate, and (in T5c) re-verified server-side in the `curriculum-fetch` Edge Function before it mints a signed URL. **Don't try to encode the date math in SQL** — it would have to evaluate the JR-synced `classes.days` / `classes.times` strings inside a policy, which is brittle and slow. The two-layer check (client UX + Edge Function authority + audit log) is the documented design (§4.22).

**Curriculum teacher_notes are scoped per `(item, class, teacher)`, not per `(item, teacher)`.** A teacher running the same item in two cohorts has two independent note streams — by design (cohorts diverge fast). If a future requirement wants notes that follow the teacher across all classes for an item, it's a schema change (drop the unique on `(item, class, teacher)` notes, add a separate `curriculum_teacher_notes` table or denormalize), not a UI tweak. The current shape is the answer to "notes that travel with how the teacher views curriculum" because the teacher view itself is per-class.

**The curriculum watermark overlay MUST keep `pointer-events: none`.** The overlay is positioned absolute over `#curViewerBody` at `z-index: 5` so the user's identity + timestamp tile across the entire surface. If you give the overlay any pointer-event handling, it captures mouse events meant for the underlying content — PDF.js scroll-to-page-flip, video controls, even the modal's own backdrop click-to-close all stop working. The same applies to `user-select: none` (already set). Test the viewer with all three asset types after any tweak to `.cur-viewer-watermark` in `styles.css`.

**PDF.js is loaded lazily via dynamic `import()`, not a `<script>` tag.** v4+ is ESM-only by default, so a regular `<script src=…/pdf.min.mjs>` won't expose a `pdfjsLib` global. Instead, `loadPdfJs()` in `app.js` does `await import(…/pdf.min.mjs)` the first time a teacher opens a PDF, caches the module, and sets `mod.GlobalWorkerOptions.workerSrc` to the matching `…/pdf.worker.min.mjs` from the same version. The bundle URL and worker URL are derived from the single `PDFJS_CDN` constant — bump that and both follow. A version skew between bundle and worker triggers PDF.js's "API version does not match Worker version" runtime error and renders the modal blank. The lazy-import also keeps the initial page weight small for the 99% of sessions that never open a PDF.

**The `curriculum-fetch` Edge Function uses service-role for storage, not the user's JWT.** That's the entire point: the bucket has no SELECT policy (CLAUDE.md §4.22), so reads under the user's JWT are denied. The function authenticates the user separately (via `auth.getUser(jwt)`), runs every authorization check itself (assignment ownership, lead-window, role for preview), THEN signs a URL with service-role. **Don't refactor it to fetch storage under the user's JWT** — every signed URL would 401 and the watermarked viewer would show a blank stage. Audit-log inserts also rely on service-role (the table has no INSERT policy on purpose).

**Reading the body of a non-2xx Edge Function response: check both `resp.response` AND `resp.error.context`.** supabase-js v2.50+ exposes the raw `Response` as a top-level field on the invoke result (`{ data, error, response }`); pre-2.50 only put it on `error.context`. Either way the user-visible `error.message` is the generic "Edge Function returned a non-2xx status code" wrapper — the actual JSON body has to be read by hand via `await respObj.clone().json()`. The curriculum-fetch viewer's error handler walks both shapes; copy that pattern when adding new Edge Function calls so failure messages are actually informative. We pinned `@supabase/supabase-js@2` (no minor) in `index.html` so the shape can shift under us — defensive parsing matters more than version-pinning here.

**Curriculum suppression handlers are scoped to the modal subtree, not the document.** `installCurriculumViewerSuppression` adds `contextmenu` / `selectstart` / `copy` / `keydown` listeners only on `#curViewerModalOverlay`. They are removed in `closeCurriculumViewer` via the saved-handler reference (anonymous closures can't be removed, hence `state._curViewerHandlers`). **Don't add these as document-level listeners** — they would block right-click and Cmd-C across the entire app indefinitely if `closeCurriculumViewer` ever fails to fire (e.g., a rendering error).

**Payment methods are super_admin-defined, not hardcoded.** T6c moved the list of payment methods (Direct deposit, Check, PayPal, Venmo, Zelle, Other, plus anything Sharon adds) into the `payment_methods` table. The personnel modal's dropdown populates from `state.paymentMethods` at modal-open. Each row's `kind` (one of `bank`, `handle`, `none`) drives whether the bank/routing/account block, the payment-handle field, or neither shows up below the dropdown — replacing the prior hardcoded string-matching in `applyPaymentMethodVisibility()`. Writes are RLS-gated to `is_super_admin()` (NOT a new `manage_payment_methods` permission, since the list rarely changes); the "⚙ Edit options" link next to the dropdown is hidden for non-super_admins. **Don't reintroduce the `teachers_payment_method_check` constraint** — it was deliberately dropped so super_admins can add methods through the UI without a SQL migration. Validation now lives in the dropdown (only valid slugs are written) plus the `kind` discriminator (which drives UX without needing the constraint). If a method is deleted from the list while a teacher still references it, the dropdown surfaces it as a disabled "(removed)" option so the admin can see what was previously set before reassigning.

**`record_waiver_signature()` is the ONLY path that inserts into `liability_waiver_signatures`.** The signatures table has NO INSERT/UPDATE/DELETE policies. The RPC is `security definer` and gates either on caller-is-the-teacher (email match against `auth.jwt() ->> 'email'`) OR `manage_teacher_compliance`. **Don't add a self-INSERT policy on the table** — it would bypass the email-match check and let a teacher forge a signature on a coworker's behalf. The RPC pattern is the entire reason both the self-sign and admin-recorded paths can share one writer.

**`teacher-documents` storage SELECT is gated, but `curriculum-assets` is not.** Both are private buckets but they handle reads differently. `teacher-documents` exposes a SELECT policy gated to `manage_teacher_compliance` because the compliance admins see ALL docs and there's no per-row authorization story (lead windows, assignments, etc.). `curriculum-assets` has NO SELECT policy because the per-teacher lead-window check needs to run server-side AND every read needs an audit-log row, both of which require the Edge Function intermediary. **Don't unify the two patterns** — adding an Edge Function for teacher-documents would just be ceremony with no security benefit; adding a SELECT policy to curriculum-assets would let teachers bypass the audit log and the lead-window gate.

**The Categories tab is gone — categories are managed via a modal off the Templates tab head.** The standalone Categories tab existed for years; it was retired during T6b's UI consolidation because it held a handful of inline-editable rows that didn't justify a top-level slot. The "⚙ Manage categories" button in the Templates tab head opens `#categoriesOverlay`; the existing `renderCategoriesTab()` + `newCategory()` functions stayed as-is — they now render into the modal's `#categoryList` instead of a tab panel, and the modal-open handler calls them. **`ROLE_TAB_VISIBILITY` no longer lists "categories"** for any role; the tools-overflow auto-hide check was updated to match. If you want to bring back a standalone Categories tab, restore those two strings AND add a tab panel to `index.html` AND add the panel id back to whatever bento/sidebar logic toggles tab visibility.

**Mobile header collapses to a single row at ≤720px.** Brand text (the "PAR DK / Response Console" stack) hides — only the logo remains, scaled down to 28px. The standalone `#signOutBtn` is hidden via `display: none !important` and the user-chip becomes a `<button>` that opens a `.user-menu` popover. The popover holds the user's name/email/role/PAR-link CTA + a Sign-out menu item. **`<a>` cannot live inside a `<button>`** — that's why the legacy "Connect to PAR" anchor inside the chip moved to the menu. If you put HTML back inside `#userChip`, keep it span/text only or browsers will silently break the chip's click handling. The popover is positioned absolute against `.header-top` (which sets `position: relative`) — don't remove that or the menu floats relative to the wrong ancestor.

---

## 6. Open issues and half-built features

### Half-built / deferred by phase

- **Phase T1.5 — manager write access.** ✅ **Shipped.** Managers can write templates, categories, infographics, teachers, classes, class_teachers, and closures. RLS on those 7 tables was swapped from `is_admin()` to `has_permission('edit_<resource>')`, and the manager bundle gained `edit_classes`, `edit_teachers`, plus a new `edit_closures` permission. `class_infographics`, `teacher_invitations`, `dk_config`, and `profiles.role` stay admin-only. The Reports tab stays admin-only via ROLE_TAB_VISIBILITY. See `migrations/phase_t1_5_manager_writes.sql` and `T1_5_VERIFICATION.md`.

- **Phase T3 — attendance + clock-in/out + reports.** ✅ **All shipped.** Teachers and admins take per-session attendance (Present/Absent + late-pickup minutes) and clock in/out per class via the class detail panel or the teacher bento cards. Admin-only **Reports** tab ships with two entries: **Attendance** (summary, per-class breakdown, late-pickup log + CSV for billing) and **Teacher hours** (per-teacher payroll roll-up, shift log + CSV for payroll). See §4.13 – §4.16.

- **Phase T8 — schools + class cancellations + notify daily contact.** ✅ **Shipped.** `schools` table with primary + daily contacts replaces the free-form `classes.location` string as the source of truth (location stays as a JR-sync fallback). `class_cancellations` records single-session cancellations distinct from closures. The class detail panel grows "Cancel class" + "✉ Notify daily contact" buttons; the notify modal opens automatically after `fill_sub_request` success and after class-cancel save, with pre-filled email templates and a Copy/mailto path (no actual SMTP — admins send from their own email). Schedule blocks render cancelled sessions line-through. Anyone signed in can SELECT schools + cancellations; writes gated on `edit_classes`. See `migrations/phase_t8_schools.sql`, `SCHOOLS_VERIFICATION.md`, and §4.21.

- **Phase T4 — sub requests / shift trades.** ✅ **Shipped.** Teachers (or admins on a teacher's behalf) open a `sub_requests` row for a specific class+session_date; other teachers offer to cover via `sub_claims`; admins/managers `fill_sub_request(req, teacher)` which atomically marks the request `filled` and flips the chosen claim to `accepted` (sibling pending claims auto-`declined`). Cancellation by the requester or admin auto-declines outstanding claims. Two new permissions — `claim_sub_requests` (teacher+), `manage_all_sub_requests` (manager+) — layered onto the existing `request_sub` permission. The "Sub requests" tab is visible to every signed-in role with a status filter (Open / Mine / All-for-admins) and per-card claim/withdraw/fill/cancel actions. The class detail panel grows a "Request sub" button next to "Take attendance" / "Clock in" that pre-fills the next session date; week + month schedule blocks badge classes with an active request (🔄 open, ✓ filled). All RPCs (`create_sub_request`, `create_sub_request_for`, `claim_sub_request`, `withdraw_sub_claim`, `fill_sub_request`, `cancel_sub_request`) are `security invoker` so RLS fires per row. See `migrations/phase_t4_sub_requests.sql` and `T4_VERIFICATION.md`.

- **Phase T5 — curriculum / scripts / materials library.** Three slices documented in §4.22.
  - **T5a (✅ shipped):** `curriculum_items` + private `curriculum-assets` Storage bucket + admin/manager Curriculum tab with full CRUD on the library. New perms `edit_curriculum` + `assign_curriculum` added to both SQL `has_permission()` and JS `PERM_BUNDLES`. See `migrations/phase_t5a_curriculum_library.sql`.
  - **T5b (✅ shipped):** `curriculum_assignments` (item × class × teacher) + Assign… modal off each curriculum row + teacher **Your curriculum** bento card with rolling per-session lock/unlock chips + per-assignment teacher notes (RPC-gated). Teacher visibility on `curriculum_items` widens through a second permissive SELECT policy joining `curriculum_assignments` + `teachers.email`. No new permissions. See `migrations/phase_t5b_curriculum_assignments.sql` and `T5B_VERIFICATION.md`.
  - **T5c (✅ shipped):** `curriculum_access_log` + Edge Function `curriculum-fetch` (verify_jwt: true, signed-URL gate + server-side lead-window re-check + audit log) + watermarked viewer (PDF.js v4 lazy-loaded via dynamic `import()`, native `<video>` / `<img>`, CSS-tiled overlay with user identity + ISO timestamp, suppressed copy/save/print/contextmenu). Admin curriculum edit modal grows a "Preview (watermarked)" button that uses the same path with `kind: 'preview'` — also audited.

- **Phase T6a — personnel fields on `teachers` (DOB, address, employment, background).** ✅ **Shipped.** See `migrations/phase_t6_teacher_personnel.sql` and the personnel sections of the teacher edit modal.

- **Phase T6b — sensitive PII split, document storage, e-signed liability waiver.** ✅ **Shipped.** Three new tables (`teacher_payment_details`, `teacher_documents`, `liability_waivers` + `liability_waiver_signatures`) plus the private `teacher-documents` Storage bucket, the `record_waiver_signature()` RPC, and two new permissions (`manage_teacher_payments`, `manage_teacher_compliance`). Personnel modal grows three new sections (bank/payment, documents, waiver) gated by those permissions; teacher home gets a self-sign banner. See `migrations/phase_t6b_personnel_payments_waivers.sql`, `T6B_VERIFICATION.md`, and §4.23.

- **Phase T6c — super_admin-managed payment_methods list.** ✅ **Shipped.** New `payment_methods` table replaces the hardcoded set of six options on `teachers.payment_method`. Super_admin gets a "⚙ Edit options" link next to the personnel-modal dropdown that opens a manage-list sub-modal (label, kind, active toggle, delete-if-not-in-use). The legacy `teachers_payment_method_check` constraint was dropped — the table is now the source of truth. See `migrations/phase_t6c_payment_methods.sql`.

- **Phase T6d — role management UI + explicit `profiles.teacher_id` link + returning-user invitation redemption.** 🔲 Not started. Today, promotion is manual SQL (or auto via PAR org ownership). `handle_new_user` only redeems invitations on FIRST sign-in. T6c adds an RPC or UI flow for admins to (a) change roles via a UI, (b) manually redeem a pending invitation for a returning user, (c) link a profile to a teacher row explicitly via a new `profiles.teacher_id` foreign key column.

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

- **Closures are still global, not per-school.** A closure on a given date flags EVERY class on the month grid that day, regardless of `classes.school_id`. Fine for single-location franchises; wrong for multi-school franchises where e.g. Mt Pleasant ES is closed but West Ashley ES isn't. Phase T8 promoted schools to first-class (see §4.21) — the natural follow-up is `closures.school_id` (nullable = all schools, non-null = per-school) and a school filter on the closures modal. Until that ships, single-class cancellations should go through `class_cancellations` (the "Cancel class" button) rather than closures.

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
| T1.5 — Manager write RLS | ✅ Shipped |
| T2 — Teacher invitation flow (code-complete) | ✅ Shipped, awaiting Sharon's PAR setup |
| Spoke install-flow platform (Phase A + B) | ✅ Shipped, awaiting Sharon's PAR setup |
| Schedule tab (Day / Week / Month) + closures | ✅ Shipped |
| Full responsive pass | ✅ Shipped |
| T3 — Attendance + clock-in/out + Reports tab | ✅ Shipped |
| T4 — Sub requests / shift trades | ✅ Shipped |
| T8 — Schools + class cancellations + notify-daily-contact | ✅ Shipped |
| T5a — Curriculum library (admin CRUD) | ✅ Shipped |
| T5b — Curriculum assignments + teacher view + teacher notes | ✅ Shipped |
| T5c — Watermarked viewer + audit log | ✅ Shipped |
| T6a — Personnel fields on `teachers` (DOB, address, payroll, background-check) | ✅ Shipped |
| T6b — Payment details + tax/cert documents + e-signed liability waiver | ✅ Shipped |
| T6c — Super_admin-managed payment_methods list (replaces hardcoded enum) | ✅ Shipped |
| T6d — Role management UI + profiles.teacher_id + returning-user invitation redemption | 🔲 Not started |
| T7 — Freemium conversion tracking | 🔲 Not started |
