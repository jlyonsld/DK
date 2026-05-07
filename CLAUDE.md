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
├── T7A_VERIFICATION.md       ← End-to-end test plan for PAR promotion-event
│                               logging: variant resolution per role × link
│                               state, impression dedup once-per-session,
│                               click logging on every click, RLS spot checks.
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
    ├── phase_t6d_role_management.sql    ← profiles.teacher_id FK +
    │                                      set_profile_role /
    │                                      set_profile_permissions /
    │                                      link_profile_to_teacher /
    │                                      redeem_invitation_for RPCs +
    │                                      profiles SELECT widening for
    │                                      admin_or_above. Backs the new
    │                                      Users tab (super_admin/admin
    │                                      only). See §4.24.
    ├── phase_t9_events.sql              ← events + event_staff tables,
    │                                      event_kind enum, new edit_events
    │                                      permission added to admin/manager/
    │                                      super_admin bundles. Backs the
    │                                      Events tab + schedule integration
    │                                      for free classes / trainings /
    │                                      promo events. See §4.25.
    ├── phase_t8_schools.sql             ← schools + class_cancellations
    │                                      tables, classes.school_id FK,
    │                                      mark_class_cancellation_notified
    │                                      RPC. See §4.21.
    ├── phase_t7a_par_promo_events.sql    ← par_promotion_events (impression /
    │                                        click / dismiss) + par_promo_event_kind
    │                                        enum. Self-INSERT, admin-only SELECT.
    │                                        Foundation for the freemium-conversion
    │                                        work. See §4.26.
    ├── phase_t7b_par_promo_dismiss.sql    ← Adds par_promo_events_self_read
    │                                        policy so the dismiss UX can check
    │                                        own-history client-side. No table
    │                                        changes. See §4.26.
    ├── phase_t13_per_school_closures.sql  ← Adds nullable closures.school_id
    │                                        FK so multi-school franchises can
    │                                        scope a closure to one location.
    │                                        NULL = global (preserves legacy
    │                                        rows). See §4.21.
    ├── phase_t10_inventory.sql           ← inventory_items + inventory_assignments
    │                                       tables, public inventory-photos Storage
    │                                       bucket, new edit_inventory permission.
    │                                       Items attach to a class session OR an
    │                                       event; conflict detection via timestamp-
    │                                       range overlap on assignment rows.
    │                                       See §4.27.
    ├── phase_t11_student_intake.sql       ← students PII columns (allergies,
    │                                       medical_notes, photo_permission,
    │                                       emergency contact, school_name,
    │                                       grade, authorized_pickup) +
    │                                       student_intake_requests table
    │                                       (sha256-hashed token, 14-day expiry).
    │                                       cancel_student_intake RPC. Backs
    │                                       the expanded Add Student modal +
    │                                       parent-self-fill form
    │                                       (student-intake.html). See §4.28.
    ├── phase_t12_mailchimp_sync.sql       ← Per-franchise Mailchimp sync.
    │                                       Adds dk_config columns
    │                                       (mailchimp_api_key, _server_prefix,
    │                                       _audience_id, _webhook_secret,
    │                                       _double_opt_in default true) +
    │                                       students.marketing_status (subscribed/
    │                                       unsubscribed/cleaned/pending) +
    │                                       mailchimp_sync_outbox (per-row
    │                                       upsert/archive queue) +
    │                                       mailchimp_sync_log (append-only
    │                                       audit, both directions). Triggers
    │                                       on students INSERT/UPDATE +
    │                                       enrollments any-change enqueue
    │                                       outbox rows. pg_cron job
    │                                       `dk-mailchimp-drain` (every 60s)
    │                                       drains via the like-named Edge
    │                                       Function. Vault secret
    │                                       `mailchimp_drain_cron_secret`
    │                                       authenticates the cron call. See §4.29.
    ├── phase_t12_mailchimp_cron_secret_rpc.sql
    │                                     ← Tiny RPC wrapper
    │                                       `get_mailchimp_drain_cron_secret()`
    │                                       (security definer, service-role only)
    │                                       so the drain Edge Function can read
    │                                       the vault secret via PostgREST
    │                                       without exposing the vault schema
    │                                       directly. See §4.29.
    ├── phase_t12b_mailchimp_backfill.sql ← T12b. `enqueue_mailchimp_backfill()`
    │                                       RPC. Super_admin only. Enqueues
    │                                       one mailchimp_sync_outbox row per
    │                                       (student × parent_email). Powers
    │                                       the "Resync all students" button
    │                                       in the Mailchimp settings modal.
    │                                       See §4.29.
    ├── phase_t15_leads.sql               ← T15. Meta Lead Ads inbox.
    │                                       Adds `leads` staging table +
    │                                       `lead_status` enum + two RPCs:
    │                                       `promote_lead_to_student` (atomic
    │                                       insert into students + mark lead
    │                                       promoted) and `mark_lead_contacted`
    │                                       (audit stamp from the reply modal).
    │                                       Reuses existing `respond_to_leads`
    │                                       permission (no new perm name).
    │                                       See §4.31.
    └── phase_t14_nightly_housekeeping.sql ← T14. `nightly_housekeeping()` +
                                            pg_cron job `nightly-housekeeping`
                                            (03:30 UTC daily). Marks pending-
                                            but-expired student_intake_requests
                                            as 'expired', then purges
                                            install_nonces > 30d, closures
                                            > 90d, and terminal intake_requests
                                            > 90d. Returns a jsonb summary
                                            visible in cron.job_run_details.
                                            See §4.30.
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
| `dk-mailchimp-drain` | false | T12. Triggered every 60s by pg_cron (`dk-mailchimp-drain` job). Reads up to 50 rows from `mailchimp_sync_outbox`, resolves student → most-recent enrollment → class → school, and PUTs each parent into the configured Mailchimp audience with allow-listed merge fields (FNAME, LNAME, STUDENT, CLASS, SCHOOL, STATUS) + dk-/class:/school: tags. Authenticated via `X-Cron-Secret` header compared against the `mailchimp_drain_cron_secret` vault entry (read via the `get_mailchimp_drain_cron_secret()` RPC at request time — NOT via an Edge Function env var, so the secret never has to be set out-of-band). Returns `{ skipped: 'not_configured' }` if `dk_config.mailchimp_api_key` is null. See §4.29. |
| `mailchimp-webhook` | false | T12. Public endpoint that receives Mailchimp's audience webhooks. Authenticated by the `?secret=<token>` query param compared constant-time against `dk_config.mailchimp_webhook_secret`. Updates `students.marketing_status` on subscribe / unsubscribe / cleaned and rewrites the email in `parent_emails` arrays on `upemail`. Always returns 200 (even on lookup miss) so MC doesn't retry-storm against parents not yet in DK. See §4.29. |
| `dk-meta-lead-webhook` | false | T15. Receives Meta Lead Ads webhooks. Handles two request shapes: GET ?hub.mode=subscribe (echoes `hub.challenge` if `META_VERIFY_TOKEN` matches) and POST signed with `X-Hub-Signature-256` (HMAC-SHA256 over `META_APP_SECRET`). On a verified POST, GETs `/{leadgen_id}?access_token={META_PAGE_ACCESS_TOKEN}` to fetch the actual `field_data` (the webhook only carries pointers), normalizes parent/child fields with case-insensitive name matching across common Meta field names, and INSERTs a `leads` row. **Always returns 200** on POST (mirrors `mailchimp-webhook` — Meta retries non-2xx for hours). Idempotent via `meta_lead_id` unique index + ON CONFLICT DO NOTHING — Meta retries are silent. If `META_PAGE_ACCESS_TOKEN` is unset, the row still lands with the leadgen pointer + `last_fetch_error = 'META_PAGE_ACCESS_TOKEN not configured'` so the admin can see something arrived. See §4.31. |
| `dk-mailchimp-ping` | true | T12. Helper called from the admin Mailchimp settings modal. Verifies a pasted API key reaches MC (`/3.0/ping`), lists audiences, lists merge fields for a chosen audience, and (optionally) creates missing required merge fields. Super_admin gate via `is_super_admin()` RPC under the user JWT. See §4.29. |

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
role_audit               — audit log for profile.role changes; AFTER INSERT
                           trigger queues a mirror to PAR via role_audit_outbox
role_audit_outbox        — durable outbox for DK→PAR audit mirroring (T6e).
                           Drained every minute by process_role_audit_outbox()
                           via pg_cron job named `role-audit-outbox`, with
                           exponential backoff (1m→24h, 6 attempts). RLS-locked;
                           access via SECURITY DEFINER. Backlog visible via
                           the `role_audit_outbox_summary` view (status counts +
                           oldest pending). PAR-side tripwire on /admin shows
                           lag if DK's outbox stops delivering.
install_nonces           — replay protection for spoke install tokens
sync_log                 — append-only log of sync + webhook events
mailchimp_sync_outbox    — T12. Per-row queue of upsert/archive ops for the
                           Mailchimp drain. One row per (student, parent_email)
                           per change; trigger-fed; drained every 60s. RLS:
                           admin-read only, no client writes. See §4.29.
mailchimp_sync_log       — T12. Append-only audit of every MC sync interaction
                           (outbound upserts/tags/skips/failures + inbound
                           webhook events). RLS: admin-read only. See §4.29.
leads                    — T15. Staging inbox for Meta Lead Ads submissions.
                           One row per Meta leadgen_id (unique → idempotent
                           webhook retries). status ∈ {new, contacted,
                           promoted, junk, archived}. Carries normalized
                           parent/child fields + raw_meta_payload jsonb +
                           audit fields for promote/contacted transitions.
                           RLS: SELECT/INSERT/UPDATE/DELETE all gated on
                           respond_to_leads (admin/manager+). The Edge
                           Function uses service-role and bypasses RLS.
                           See §4.31.
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

**T13 (✅ shipped) — per-school closures.** `closures` gets a nullable `school_id` FK to `schools` (NULL = legacy global behavior, preserves every pre-T13 row without backfill). Multi-school franchises can now scope a closure to one location — e.g. "Mt Pleasant ES — snow day" leaves classes at every other school untouched. The closures modal grows a school dropdown (defaults to "All schools (global)"), and the existing list rows show a 🌐/📍 scope chip so admins can scan global vs. scoped at a glance.

**Rendering rule (load-bearing — see §5 gotcha):**
- **Global closures** (`school_id is null`) trigger the prominent visual treatments: red full-cell hatch on Month view, the cell-wide `.closed` styling on Week view, AND per-class block dimming for every class on that day.
- **Per-school closures** ONLY dim individual class blocks/rows whose `classes.school_id` matches; the cell-level red hatch stays off. The closure pill on Day/Week/Month still mentions the closure (with school name in parens) so the admin sees the full picture, but the visual prominence is reserved for "everyone is off."

Three new helpers in `app.js`: `globalClosuresForDate(date)` filters to `school_id is null`; `closuresForClassOnDate(cls, date)` returns the closures that affect this specific class (global OR matching school); `closureLabelWithScope(cl)` formats labels like "Snow day (Mt Pleasant ES)" for tooltips and pills. Per-class dimming uses a new `.sched-closed` CSS class (analogous to `.sched-cancelled` but with a 🗓 badge and amber color so closure ≠ cancellation visually). No new permission name — `edit_closures` covers writes regardless of scope.

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

### 4.24 Users tab — role management, profile↔teacher link, returning-user invite redemption (T6d)

Until T6d, every promotion outside the install-flow auto-promote (par-identity-proxy, §4.8) and the first-sign-in invitation redemption (`handle_new_user`, §4.6) required Jason to run raw SQL. T6d closes the loop with a single admin-only **Users** tab + four `security definer` RPCs.

**Users tab** — visible to super_admin and admin only (`ROLE_TAB_VISIBILITY` + the mobile tools-overflow auto-hide list). Lists every `profiles` row with name, email, role, linked teacher, PAR badge, and per-row Edit + (when applicable) "Redeem invite" buttons. Search filters across name / email / par_display_name; a "Show no-role users" toggle (default on) hides locked-out accounts. The table also surfaces a `+N/-M` chip on rows with per-user grant/revoke entries so admins can see at a glance who's diverging from the role bundle.

The **role-management modal** edits role + linked teacher + granted permissions + revoked permissions + an optional reason in one save. All four RPCs run sequentially and only when the corresponding field actually changed (a no-op save makes zero RPC calls). Save errors surface inline in the modal — same pattern as the curriculum-fetch viewer (§5 "Reading the body of a non-2xx Edge Function response") — rather than a toast that disappears mid-read.

**The four RPCs:**

- **`set_profile_role(p_profile_id, p_new_role, p_reason)`** — server-side guards: caller must be `is_admin_or_above()`; only super_admin can grant or revoke the super_admin role; refuses to demote the LAST super_admin (counts other super_admins; raises if zero). The T0 `profiles_role_audit` trigger fires on the resulting UPDATE so every change lands in `role_audit` automatically. The reason text is persisted on `role_audit.reason` — `set_profile_role` calls `set_config('par.audit_reason', p_reason, true)` (transaction-local) and the trigger reads it via `current_setting('par.audit_reason', true)`, so the reason makes it into the row instead of just a `raise notice`. **If you add another role-mutating RPC, propagate the reason via `set_config` or it'll land NULL in audit.** The same `role_audit` insert also fires `role_audit_emit_to_par()`, which queues a row in `role_audit_outbox`; a 1-min pg_cron worker (`process_role_audit_outbox()`) drains the outbox to PAR's `spoke-emit-audit` Edge Function with exponential backoff (1m→5m→15m→1h→6h→24h, 6 attempts max). Idempotency is enforced PAR-side via a unique partial index on `metadata->>'spoke_audit_id'`, so multi-send from retries is safe. The trigger no longer calls `pg_net` directly — outbox writes are transactional with the `role_audit` insert.
- **`set_profile_permissions(p_profile_id, p_granted, p_revoked)`** — overwrites the two text[] columns. Granted/revoked permission names aren't validated against the bundle: `has_permission()` is the runtime gate, so a typo'd name silently grants nothing rather than erroring. UI shows the canonical list of names; this RPC trusts what the UI sends. Same super_admin guard as `set_profile_role` (only super_admin can edit a super_admin row's permissions).
- **`link_profile_to_teacher(p_profile_id, p_teacher_id)`** — links / unlinks (NULL = unlink). The unique partial index `profiles_teacher_id_unique` (where teacher_id is not null) enforces one-profile-per-teacher; the RPC just gates the write.
- **`redeem_invitation_for(p_profile_id)`** — handles the case `handle_new_user` can't catch. The trigger only fires on `auth.users INSERT` (first-ever sign-in). If a user already has a DK profile when an admin creates the invitation, nothing redeems it. The RPC finds the most-recent pending non-expired `teacher_invitations` row by the target profile's auth email, promotes the role, links `profile.teacher_id` from the invitation if set, backfills `teachers.email` if missing, and stamps `accepted_at`. Authorization: caller is the target user themselves OR `is_admin_or_above()` — so the same RPC powers both the admin "Redeem invite" button on the Users tab AND a (future) self-service path on the user's own profile.

**`profiles.teacher_id` is the new source of truth for "who's the signed-in teacher".** `mySignedInTeacher()` in app.js prefers `state.profile.teacher_id` and falls back to the case-insensitive email match against `teachers.email` only when the FK is null. This unifies the lookup that previously lived inline in five places (teacher home bento, `classesForDate`, class detail panel, `canTakeAttendanceFor`, the waiver self-sign banner) — they all delegate to `mySignedInTeacher()` now. **The email-match fallback stays** so a teacher whose admin hasn't yet linked them through the Users tab still gets a working schedule + clock-in. T6d makes the FK preferred, not required.

**SELECT-policy widening on `profiles`.** Pre-T6d the table only had self-read (`profile_self_select`, set up via the Supabase dashboard before the repo carried migrations). T6d adds a parallel permissive `profiles_admin_read` policy gated on `is_admin_or_above()`. Multiple permissive policies are OR'd, so admins now see every row while non-admins still see only their own. The `profiles` table was already in the `supabase_realtime` publication, so changes light up the Users tab live without further wiring.

**No new permission names.** Super_admin and admin already hold `manage_users` from the T0 bundles; T6d gates everything via `is_admin_or_above()` at the RPC entry points, which matches both per the redefined `is_admin()` (§4.5). If a franchise ever wants a delegated bookkeeper-style role with permission edits but not role edits, that's a future split (`manage_user_roles` vs. `manage_user_permissions`) — the RPCs are split today specifically to make that future split a one-line gate change.

### 4.25 Special events — free classes, trainings, promotional events (T9)

T9 adds a parallel item type alongside `classes` for one-off / non-recurring activities: free demo classes, teacher trainings, promotional pop-ups, and an `other` catch-all. Distinct from `closures` (whole-day, all-classes-at-a-school) and from `class_cancellations` (single-session no-show on an existing class). The shape is intentionally NOT an extension of `classes` — see §4.10's "string-based, not RRULE" rationale. Adding event-shaped rows to `classes` would force the JR nightly sync to learn about a `kind` discriminator and would mix RRULE-free explicit-date items with day-string recurrence in the same table.

Two new tables, both in the `supabase_realtime` publication:

- **`events`** — `id`, `kind` (`event_kind` enum: `free_class` / `training` / `promotional` / `other`), `title`, `description`, `starts_at` + `ends_at` (timestamptz, no string parsing), `school_id` (nullable FK to `schools`), `location` (free-form fallback if no school), `capacity` (nullable; null = unlimited), `notes`, `is_cancelled`, `created_by`. Constraint: `ends_at > starts_at`. The `events_capacity_nonneg` check guards against negative capacities.
- **`event_staff`** — multi-staff assignment. `(event_id, teacher_id)` is unique; `role_label` is free-form ("Lead", "Assistant", "Greeter", "Photographer") so a franchise uses whatever terminology fits without a schema change. **No primary/sub asymmetry** — events have an equal-tier staff list, unlike `class_teachers`. RSVP/signup tables (future v2) would either widen `event_staff` with a `role` enum or add a sibling `event_attendees` table.

One new permission: **`edit_events`**, added to super_admin/admin/manager bundles in both SQL `has_permission()` and JS `PERM_BUNDLES`. Teachers + viewers see events they're staffed on (or all events for viewer) but can't write. SELECT on both tables is open to any signed-in user — the schedule must render events for everyone, and promotional events are visible across the whole team.

UI surfaces:

- **New "Events" top-level tab** — visible to every signed-in role via `ROLE_TAB_VISIBILITY`. Header has `+ New event` button gated by `hasPerm("edit_events")`. Body has two filter rows (When: Upcoming/Past/All; Kind: All/Free class/Training/Promo/Other) and a card grid. Each card shows kind chip, title, date+time range, school/location, description, capacity (if set), and per-card staff chips. Cancelled events render line-through + opacity. Mobile registers the tab as a Tools-sheet overflow item, same pattern as Sub requests / Curriculum.
- **Schedule Day/Week/Month integration** — `eventsForDate(date)` returns events whose `starts_at..ends_at` window covers that date (multi-day events appear on every covered day). Day view merges classes + events sorted by start time and renders events as rows with a dashed left border in the kind's color + a star (★) and kind chip. Week view positions events as absolute blocks like classes but with a dashed left border and the kind's hue. Month view interleaves events into the per-cell row list (max 3 visible, "+N more" overflow), also dashed left border. The cell's count badge includes events.
- **Click-through** — clicking an event row in any schedule view (or on a schedule month-cell event row) opens the event editor modal, NOT the class detail panel. `wireScheduleClassClicks()` handles `data-open-event` alongside `data-open-class` and `data-open-day`.
- **Event editor modal** (`#eventModalOverlay`) — kind dropdown, title, description, start/end datetime inputs, school dropdown (reuses `state.schools`), location fallback, capacity, internal notes, "Mark cancelled" checkbox, plus an inline staff editor. Staff editor for new events buffers additions in `pendingNewEventStaff[]` until save (no event id yet); for existing events, adds/removes/role-edits write directly to `event_staff` immediately so changes propagate via realtime to other admins.

Visual differentiation across the app: events are **dashed**, classes are **solid**. That's the rule — if you add a new schedule projection or summary card, follow it. The kind colors are deterministic via `EVENT_KIND_META.<kind>.hue` (free_class=170 teal, training=270 violet, promotional=38 amber, other=210 slate); never hardcode an event color outside that lookup.

Out of scope for v1 (deliberate, do not bolt on): no attendance / RSVP / headcount tracking on events (would be a sibling `event_attendees` table); no curriculum link (§4.22 stays class-scoped); no public-facing RSVP page (would need an unauthenticated path with anti-bot gating); closures don't affect events (events carry explicit dates — a closure on the same day doesn't cancel them); events don't appear on the teacher home bento yet (could surface as an "Upcoming events" section in v2 if teachers report missing them in the schedule).

### 4.26 PAR promotion events — variant-keyed funnel logging (T7a)

T7a is the foundation slice for the freemium-conversion work. Until now, the home-bento "On PAR" card had two states (linked / unlinked) and zero observability — we couldn't tell who saw what copy or whether anyone clicked through. T7a adds variant-keyed copy and an append-only `par_promotion_events` log so T7b's smart-trigger work has data to calibrate against. **No new permission name** — logging is universal (any authenticated user records their own events), reading is gated on `is_admin_or_above()`.

**Five variants in v1**, computed by `resolveParVariant()` from `state.profile`:

| Variant key | Condition | Pitch |
|---|---|---|
| `unlinked_admin` | admin/manager/super_admin/viewer/null, no `par_person_id` | 🔗 "Connect to PAR" |
| `unlinked_teacher` | teacher, no `par_person_id` | 🔗 "Link DK to PAR" + "Try the family planner" subline |
| `linked_franchise_owner` | super_admin AND linked | 👤 display name + → (neutral; Sharon already pays via the franchise org) |
| `linked_admin` | admin/manager/viewer/null AND linked | 👤 display name + → (neutral) |
| `linked_teacher` | teacher AND linked | 👤 display name + "Try the family planner" subline + → |

The `super_admin` / `admin` split exists specifically so a future copy test can pitch the franchise owner differently from her admin delegates without affecting how admins see the card. Viewer + null fold into the admin variants — they don't see the home bento often, but the resolver handles them gracefully.

**Two helpers in `app.js`:**

- `resolveParVariant()` — pure function on `state.profile`, returns one of the five keys.
- `logParPromoEvent(variantKey, eventKind, metadata)` — fire-and-forget INSERT into `par_promotion_events`. Failure is silent (a missed log row is strictly better than blocking the user's click).

**Impression dedup is once-per-session** via `state._parPromoImpressions: Set<string>` keyed by variant. The first render of each variant in a session fires `impression`; subsequent re-renders (from realtime debounce, post-mutation `reloadAll()`, etc.) don't re-fire. A full page reload clears the set and re-fires. This was a deliberate calibration call — daily dedup would over-count for admins who keep DK open all day; per-render dedup would be useless once the realtime channel is busy. **Clicks are NOT deduped** — repeat clicks count as repeat intent signals, which is what we want for funnel math.

**Click logging fires before the new tab opens.** The PAR card link carries `data-par-variant="<key>"`; `wireHomeCardEvents()` attaches a click listener that calls `logParPromoEvent(variant, 'click')` before the synchronous `target=_blank` navigation. The INSERT proceeds async; the new tab opens regardless of whether the log row writes (network failure / RLS rejection / etc. don't block the user).

**`event_kind` is an enum (`impression` / `click` / `dismiss`); `variant_key` is text.** Locking down the kind dimension keeps funnel queries unambiguous; leaving variant_key open lets us A/B new copy without a schema migration. T7b will likely add `unlinked_teacher_usage_attendance_20` and similar keys driven by usage thresholds — same pipeline, no migration needed. The `dismiss` kind is in the enum even though v1 has no dismiss UX so a future "× hide for a week" affordance can use the same surface.

**`metadata` is `jsonb` for forward extensibility.** v1 always logs `metadata: {}`. T7b will start carrying threshold values, copy-test ids, and similar context. Anything we want to filter on at scale should eventually be promoted to its own column.

**Realtime publication:** `par_promotion_events` is in `supabase_realtime`. Not strictly required for v1 (no card re-renders on someone-else-logged-an-impression), but consistent with the rest of the schema and cheap. If T7b lands aggregate-counter cards on an admin dashboard, they'll get live updates for free.

**T7b (✅ shipped) — usage-tier variants, dismiss UX, admin funnel report.** Layered onto the same `par_promotion_events` table, no schema rewrite. One tiny migration (`phase_t7b_par_promo_dismiss.sql`) adds a parallel permissive `par_promo_events_self_read` policy gated on `profile_id = auth.uid()` so the dismiss check can read own-history client-side. Multiple permissive policies are OR'd — admins still see everything via `par_promo_events_admin_read`. Reverses T7a's "per-user reads aren't useful" stance now that the dismiss UX needs them.

Two new tier-keyed variants for unlinked teachers, picked by `resolveParVariant()` after counting **distinct (class_id, session_date) sessions** unioned across `state.attendance` (entries on classes the teacher is on) and `state.clockIns` (rows where teacher_id = me). Union avoids under-counting teachers who use only one of the two surfaces:

| Variant | Threshold | Pitch |
|---|---|---|
| `unlinked_teacher_attendance_20` | ≥20 sessions | "You've taught 20+ sessions — PAR keeps your family schedule too" |
| `unlinked_teacher_attendance_50` | ≥50 sessions | "50+ sessions taught — meet PAR" |

Tier order is strongest-first; resolver picks the highest tier the user qualifies for AND hasn't dismissed in the last `PAR_DISMISS_DAYS` (7). Thresholds and dismiss-window live as constants next to `PAR_VARIANT_COPY` so a single PR retunes both numbers + copy. **Linked variants stay unchanged** (Sharon already pays via the franchise org). **`unlinked_admin` doesn't get a usage tier** — admins don't measurably benefit from a "you've used DK heavily" pitch the way a teacher benefits from "you'd use this for your family too," and the original copy test was scoped to teachers.

**Dismiss UX is tier-only by design.** Only `dismissable: true` variants render the small `×` button; the four base variants (`unlinked_admin`, `unlinked_teacher`, all `linked_*`) double as nav so hiding them would orphan the link. The button is a sibling of the anchor, not nested inside it (button-in-anchor is invalid HTML and triggers navigation on click). On click, the handler `preventDefault + stopPropagation`s, calls `logParPromoEvent(variant, "dismiss")`, AND optimistically pushes a synthetic row into `state.parPromoEvents` (id `_local_<ts>`) so the next render flips to the lower tier without waiting for the realtime round-trip. The funnel report filters out `_local_*` rows so a just-clicked dismiss doesn't double-count.

`isVariantDismissed(variantKey)` reads `state.parPromoEvents` (loaded in `reloadAll()` under the new self-read policy) and checks for any `dismiss` row newer than `now - PAR_DISMISS_DAYS`. The dismissed tier surfaces again automatically after the window — no scheduled job, just a date comparison at render time.

**Admin funnel report** is a new `REPORTS` registry entry (§4.15 plug-in pattern), admin-only via the existing `ROLE_TAB_VISIBILITY` gate plus a defensive `isAdminOrAbove()` guard inside `renderParFunnelReport`. Aggregates the existing date-range state into:
- Summary cards: Impressions / Clicks / Dismisses / CTR / Dismiss rate.
- By-variant table: variant_key × {impressions, clicks, dismisses, CTR, dismiss-%}, sorted impressions-desc.
- Daily impressions sparkline: continuous day series across the range (empty days render a gray 1px stub, not a gap), bars scaled to the tallest day.
- CSV export: raw events for spreadsheet analysis (CreatedAt, ProfileId, Variant, Kind, Surface, Metadata).

`par_promotion_events` is added to `setupRealtime()`'s watched tables, so the funnel updates live across browsers within the 300ms debounce — useful for watching a real-time A/B unfold without manual refresh.

**Out of scope for T7b:** copy-test variant ids in `metadata` (the field exists, no producer yet); per-day click + dismiss overlay on the sparkline (single-color impression bars are easier to read at 90+ days); per-user funnel drilldown (admin can grep the CSV); thresholds for `unlinked_admin` (intentionally no admin tier — see above); auto-promotion of variants out of dismissal after a behavior change ("they took 50 more sessions, re-pitch them" — the 7-day window already handles this gracefully).

### 4.27 Inventory — items + class/event assignments + conflict detection (T10)

T10 adds a physical-inventory ledger for the franchise: props, costumes, supplies, and equipment that get checked out to a class session or an event. The shape is two tables (`inventory_items`, `inventory_assignments`), one new permission (`edit_inventory`, super_admin/admin/manager), and a public Storage bucket (`inventory-photos`) for reference photos.

**Schema (one assignment table, polymorphic to class OR event).** `inventory_assignments` carries `item_id`, nullable `class_id`, nullable `event_id`, `session_date` (date, set when class_id is), `usage_starts_at` + `usage_ends_at` (timestamptz materialized at write time), `returned_at` (null = still assigned), `notes`, `created_by`. A check constraint enforces exactly one of `class_id` / `event_id` is set; another enforces `class_id` ⇒ `session_date` is set. **Why one table not two:** the conflict overlap query is "any two assignments for the same item whose [usage_starts_at, usage_ends_at) windows overlap" — trivially expressible against one table, would require a UNION across two. Splitting would also force every read-side helper (`inventoryAssignmentsForItem`, the schedule lookup, the conflict math) to handle both shapes.

**Why materialize the time window on the assignment row.** Classes don't have explicit timestamps — they're recurring on a session_date with the time string parsed from `classes.times`. The assignment writer materializes the window at write time (`classSessionTimeWindow(cls, sessionDate)` for class assignments, `events.starts_at..ends_at` for event assignments) so the conflict overlap query is a single column-level comparison. **Side effect:** if `classes.times` is later edited, existing inventory assignments retain their snapshotted window. This is intentional — a teacher who already pulled a costume for the original time slot doesn't need their assignment silently re-scoped. Admins re-assign explicitly via the editor if the time genuinely changed.

**Conflict detection is surfaced everywhere, never blocked at the DB.** The DB lets overlapping assignments through (admins occasionally need to override double-bookings); a partial unique index does prevent the *same item assigned to the same class session twice* and the *same item assigned to the same event twice*, but cross-target overlaps are detection-only. Conflicts surface in:

- **Inventory tab cards** — red `⚠ N conflicts` row computed by `itemConflictCount(itemId)` (O(n²) within an item's active assignments; cheap because items rarely have more than a handful of overlapping holds).
- **Inventory editor "Current & upcoming assignments" list** — overlapping rows get a red border + `⚠ conflict` pill, computed pairwise across the item's active assignments.
- **Assign-picker** — every item shows a "⚠ Already assigned: …" warning under it if its existing assignments overlap the target's time window. Items already assigned to *this exact* target are checkbox-disabled (the partial unique index would reject the insert anyway).
- **Class detail panel chips** — the "Inventory for [date]:" chip row marks any chip with an active conflict in red with a `⚠`. Hover shows what else it's pinned to.
- **Event editor inventory list** — overlapping rows get the same red border + conflict pill + an "Also assigned: …" detail line.

**Photos: public bucket, mirroring the `infographics` pattern.** `inventory-photos` is a public Storage bucket; reads via `getPublicUrl`, writes gated on `edit_inventory`. `inventory_items.photo_urls` is a `text[]` of the public URLs (no separate join). **Why public, not curriculum-style watermarked:** inventory photos aren't sensitive — they're "what does this prop look like" reference shots. Adding an Edge Function intermediary would be ceremony with no security benefit. Photo deletes call `inventoryStoragePathFromUrl()` to strip the path back out of the public URL so the bucket object can be removed too. New-item flow uploads photos to a `_pending/` prefix before the item id exists, then writes the public URLs into `photo_urls` on save. Cancelling a new-item edit removes the buffered uploads from the bucket.

**Permissions: one new name, `edit_inventory`.** Added to super_admin/admin/manager bundles in both `has_permission()` SQL and `PERM_BUNDLES` JS. Teachers + viewers SELECT-only — they need to see what's been pulled for their classes (chip row on the class detail panel) but can't write. SELECT on both tables is open to any signed-in user, mirroring classes/schools/events: the schedule + class detail + event editor all need to render assignments for everyone, and a teacher-private filter would just add complexity for no security benefit (assignment data isn't sensitive).

**UI surfaces:**

- **New top-level "Inventory" tab** — visible to every signed-in role (read-only for teachers/viewers). Header has search input, Show-archived toggle, and `+ New item` (gated). Tag filter chips. Card grid with photo, location, tags, status (`📍 Assigned to …` or `✓ Available`), conflict badge, and a `↗ Re-order` link if `reorder_url` is set. Cards are clickable → opens the item editor. Mobile registers it as a Tools-sheet overflow item with the 📦 icon.
- **Item editor modal** — name, description, storage_location, tags (comma-separated), reorder_url, notes, archive toggle, Photos section (with upload), and (for existing items) a "Current & upcoming assignments" list with mark-returned / mark-active / remove actions per row.
- **Assign-picker modal** — opened from the class detail panel "📦 Assign inventory" button or the event editor's "+ Assign inventory…" button. Shows a banner of what we're assigning to + the time window. Checkbox-list of items with conflict warnings, search filter, and a notes field. Multi-select.
- **Class detail panel** — admin/manager get the "📦 Assign inventory" action button next to "Cancel class" / "Notify daily contact". *Everyone* (including teachers) sees an "Inventory for [next session date]:" chip row when items are assigned, so a teacher knows what's been pulled. Click a chip → opens the item editor.
- **Event editor** — admin/manager+ see an Inventory section below Staff with the assignment list and a "+ Assign inventory…" button. Only renders for *existing* events (saved); new events have no id yet to attach assignments to. (Admins create the event first, then re-open it to assign inventory — same shape as the staff-list flow for `pendingNewEventStaff`.)

**Re-order link is the small thing that pays for itself.** `inventory_items.reorder_url` lets the franchise stash the vendor URL for items they've ordered before. The Inventory card surfaces it as `↗ Re-order` and the editor has a dedicated input. It's a "save the search next time" pattern — when a costume tears or supplies run out, Sharon clicks one link instead of fishing through Amazon history.

**Out of scope for T10:** quantity tracking (each item is a single physical unit; if the franchise needs N pairs of pirate hats, create N items or one item with `(qty 12)` in the name); check-out → check-in workflow with required returns (we just track `returned_at` as an optional manual mark); barcode/QR scanning; per-school inventory scoping (closures-style — would need `inventory_items.school_id` and a school filter); inventory on the home bento (no surface yet — could be a "Items missing from your class" card for teachers in v2).

### 4.28 Student intake — full PII fields + parent self-fill form (T11)

T11 turns the previously bare-bones Add Student modal (first / last / DoB only) into a full intake form, AND adds an "📧 Send form to parent" path that emails the parent a public token-gated form (`student-intake.html`) which they fill out themselves, syncing back as a new student + enrollment in one round-trip.

**Schema additions, no schema rewrite.** Parent contact arrays (`parent_names text[]`, `parent_emails text[]`, `parent_phones text[]`) and `family_id` were already on `students` from earlier phases — the JR sync populates them, the UI just wasn't surfacing them. T11 adds proper PII columns: `allergies`, `medical_notes`, `photo_permission boolean` (tri-state — null = "not asked"), `emergency_contact_name`/`phone`/`relationship`, `school_name`, `grade`, `authorized_pickup`. All nullable; no backfill needed for existing rows.

**`student_intake_requests` is the token table.** Each row carries `class_id` (FK), `parent_email`, `token_hash text` (sha256(raw_token)), `status` (`pending` / `completed` / `cancelled` / `expired`), `expires_at` (14-day default), audit fields (`sent_by`, `sent_at`, `email_sent_count`, `last_email_status`, `last_email_error`), and on completion: `completed_at`, `resulting_student_id`, `resulting_enrollment_id`, `submitted_payload jsonb`. **The DB stores only sha256(token), never the raw token** — a leak of the row gives an attacker nothing usable; verification re-hashes the URL token and looks up by hash. Same defense pattern as a salted password hash, simpler because the token IS random (no rainbow-table risk).

**Two Edge Functions, distinct auth models:**

- **`dk-send-intake-form`** (`verify_jwt: true`) — admin/manager calls this. Verifies the caller's `edit_students` permission via `has_permission()` (called under the user-bound supabase-js client because the SQL function reads `auth.uid()` internally — with service-role it'd be NULL and always return false). Mints a 32-byte hex random token, persists sha256(token) + class_id + parent_email + (optionally) initial_first_name/last_name as a hint. Builds the URL `https://dk-green.vercel.app/student-intake.html?token=<raw>`. Emails via Resend if `RESEND_API_KEY` + `dk_config.sender_email` are both set; otherwise returns the URL for copy/paste fallback (mirrors `dk-invite-teacher`'s pattern, §4.6). Resend path: passes `resend_intake_id` and rotates the token + pushes expiry on the existing row, so the old emailed link stops working immediately.
- **`dk-submit-intake-form`** (`verify_jwt: false`) — public; the parent has no auth session. Auth IS the token. Function sha256s the URL token, looks up the intake row, verifies status='pending' and not expired. Then atomically: INSERT student (client-supplied UUID, `source='dk_local'`, all PII fields from the payload), INSERT enrollment, UPDATE the intake row to `completed`. The students-INSERT trigger fires the existing T3a match-detection pipeline so duplicate detection works the same as in-app adds. The function uses service-role for writes — there are no INSERT/UPDATE/DELETE policies on `student_intake_requests` by design.

**RLS on `student_intake_requests`.** SELECT to admins/managers (`has_permission('edit_students')`) AND to teachers assigned to the class (email-match through `class_teachers` + `teachers.email`, per §5's "never reference auth.users from RLS" rule). No writes via RLS — both Edge Functions use service-role. The `cancel_student_intake(p_intake_id uuid)` RPC is `security definer`, gated on `edit_students`, and is the admin-side cancel surface (token remains in DB but is unusable since the submit function refuses non-pending rows).

**UI surfaces:**

- **Expanded Add Student modal** at `index.html` — dashed banner at top with "📧 Send form to parent" (parent email + Send button); below that, sectioned form (Student / Parents repeater 1-4 / Emergency contact / Health & safety / Notes). Parents repeater seeds with one empty row; "+ Add another parent" button up to 4. Photo permission is a tri-state radio group (Yes / No / Not asked).
- **Send-result modal** (`#intakeResultOverlay`) — appears after the Send button completes. Shows the intake URL inline regardless of email-sent state, so admin can copy/paste. If Resend is unconfigured (`skipped_no_resend_key` / `skipped_no_sender_email`) or the email failed, shows that explicitly with the URL as the fallback.
- **Class detail panel** — gains a "Pending parent forms (N)" subsection above the enrollments list. Each pending row shows parent email, child hint (if pre-filled), days-since-sent, expiry, with `Resend` and `Cancel` buttons. When the parent submits, the row drops out (status flips to `completed`) and the new student appears in the enrollments list via the realtime debounce.
- **Enrolled-student rows** — now display parent name(s) / email / phone underneath the student name, plus chip indicators for `⚠ allergies`, `⚕ medical`, `📷 no photos` (if `photo_permission = false`). Email + phone render as `mailto:` / `tel:` links. Emergency contact gets a 🚨 line if set. Tooltips on the chips show the full text without bloating the row.
- **Public form page** `student-intake.html` — standalone (parallel to `install.html`). No auth, no Supabase JS SDK; uses raw `fetch` with the publishable key as `apikey` + `Authorization: Bearer <publishable>` (Supabase's gateway requires *some* apikey even for `verify_jwt: false` functions, the publishable one works because the real auth is the token in the body). Reads `?token=…` from URL, renders the form, POSTs `{token, payload}` to `dk-submit-intake-form`, shows success/error.

**No new permission name.** Reuses `edit_students` (manager+) for both the in-app modal entry points and the Edge Function gate. A future per-user grant/revoke can scope intake-sending without affecting other student-write flows because all the granular checks happen via `has_permission('edit_students')`.

**Why `verify_jwt: false` for the submit function but `verify_jwt: true` for `curriculum-fetch` (which is also "auth via something other than JWT").** The curriculum-fetch path verifies the JWT manually inside the handler via `auth.getUser(jwt)` because the platform's gateway-layer rejections weren't appearing in function logs (CLAUDE.md table at §3). For `dk-submit-intake-form` the parent has no JWT at all — they're a member of the public, the email link is their entire credential. That's the same model as `dk-install-callback` (HMAC-signed token) and the same `verify_jwt: false` setting. Don't try to layer manual JWT verification on top — there's no JWT to verify.

**14-day expiry, no auto-purge.** Like `closures` and `install_nonces`, expired/cancelled intake rows accumulate. Volume is low (one per dk_local student) and they're useful audit trail (who sent what to whom, when). If volume becomes a concern, add a nightly pg_cron purge of `status in ('expired','cancelled') and sent_at < now() - interval '90 days'` — same pattern §5 calls out for closures.

### 4.29 Mailchimp sync — outbox queue + drain + webhook (T12)

T12 turns DK into the system of record for student / enrollment / class data and Mailchimp into the marketing-email send engine. Per-franchise audience: each PAR DK install points at its own Mailchimp account (no shared audience across franchises). Sync key is `lower(parent_email)`. **One-way for now** — DK pushes to MC; MC's webhooks only update `students.marketing_status` (subscribed / unsubscribed / cleaned / pending) and rewrite `parent_emails` array entries on `upemail`. No bidirectional student-row writes from MC.

**Schema (one queue table, polymorphic op).** `mailchimp_sync_outbox` carries `(student_id, parent_email, op, attempts, completed_at, last_error)`. `op ∈ {upsert, archive}`. The `archive` path is plumbed but not yet emitted (when a parent email is dropped from `students.parent_emails`, we don't enqueue an archive — it's a v2 concern). One row per (student, parent_email) per change; trigger-fed; drained every 60s. **Why one polymorphic table, not two:** the drain reads the whole queue in `enqueued_at` order; splitting upsert/archive would force two SELECTs and a merge-sort. The CHECK on `op` keeps the discriminator strict.

**Triggers fire from two places.** `students_mc_sync` runs `AFTER INSERT OR UPDATE OF first_name, last_name, parent_emails, parent_names, status` and inserts one outbox row per non-empty `parent_emails` entry. `enrollments_mc_sync` runs on every enrollments INSERT/UPDATE/DELETE, looks up the student's `parent_emails`, and enqueues the same. Both are `security definer` — the trigger is service-role-equivalent so it can write to the outbox even when the user-side INSERT/UPDATE is RLS-restricted (e.g. teacher adding a student via the dk_local flow). Triggers don't try to dedupe within a transaction; idempotent upsert at MC means double-enqueue is just a redundant API call, not a correctness bug. **The trigger column list is load-bearing** — adding a new students column doesn't mean it should re-trigger MC sync. Anything sensitive (allergies, medical_notes, payment_details, waivers) MUST stay off both this list and the drain's allow-list.

**Drain is `dk-mailchimp-drain` (verify_jwt: false, every 60s via pg_cron).** Auth via the `X-Cron-Secret` header compared against the value returned by the `get_mailchimp_drain_cron_secret()` RPC. The RPC is `security definer` + revoked from public/authenticated/anon, granted only to `service_role`. **No Edge Function env var needed** — the secret lives in Postgres vault (`mailchimp_drain_cron_secret`) and the function reads it at request time. This avoids the dashboard-set-secret manual step that the spec originally called out. Both pg_cron and the Edge Function read the same vault entry, so the values agree by construction.

**Drain processing loop:** read up to 50 rows where `completed_at is null AND attempts < 5` ordered by `enqueued_at`. For each row, stamp `attempted_at + attempts++` first (so we don't loop on a poison row); resolve student → most-recent enrollment (active wins, tiebreak by `enrolled_at desc`) → class → school; build the allow-list payload; PUT to MC's `/3.0/lists/<aud>/members/<md5(lower(email))>`; POST tags; stamp `completed_at` + write a `mailchimp_sync_log` row. **Allow-list is enforced twice** — the merge-fields object only has the six keys (FNAME, LNAME, STUDENT, CLASS, SCHOOL, STATUS), and a defensive loop strips anything not in `MC_ALLOWED_MERGE_FIELDS` before send. Adding a new merge field requires editing both the constant and the object construction.

**Tags applied per parent:** `dk-<status>` (e.g. `dk-active`), `class:<slug>` (e.g. `class:wando-tk-fri-3pm`), `school:<slug>` (e.g. `school:wando-elementary`). Slugs lowercase + non-alphanumerics → `-`, capped at 60 chars. **Tags accumulate, they don't replace.** MC's tag POST sets active=true on the listed tags but leaves prior class/school tags in place. v1 accepts that — class tags lingering from old enrollments are harmless until someone manually prunes. A future "tag reconciliation" pass could GET existing tags + diff, but that's another MC API call per parent and the cost wasn't worth v1.

**`statusIfNew` defaults to `pending` (double opt-in).** `dk_config.mailchimp_double_opt_in` defaults to `true`; set it to `false` (via the modal checkbox) to use `subscribed` instead. Don't try to subscribe people without explicit opt-in unless the franchise's MC audience permission setting allows it — MC will reject the request and send a deliverability warning. Pre-existing MC members aren't affected by this setting (only the `status_if_new` field).

**Webhook is `mailchimp-webhook` (verify_jwt: false, public).** Auth is the `?secret=<token>` query param compared constant-time against `dk_config.mailchimp_webhook_secret`. The secret is minted client-side (`crypto.getRandomValues(32 bytes)` → hex) on first save of the modal and persisted to `dk_config` so the Edge Function and the URL Sharon copies into Mailchimp share the same value. **Always returns 200**, even on lookup miss — MC retries non-2xx responses for hours and we don't want stuck queues for parents not yet in DK (e.g., someone who signed up via a Mailchimp form first). MC's "validate URL" GET is a no-body request; we return 200 on GET too.

**Webhook event handling:**
- `subscribe` / `unsubscribe` / `cleaned` → flips `students.marketing_status` + stamps `marketing_status_updated_at` for every student row whose `parent_emails` contains the lowered email.
- `profile` → just stamps `marketing_status_updated_at` (a "no real change" ping).
- `upemail` → looks up by `data[old_email]`, replaces that array element with `data[new_email]` on every matching `students.parent_emails`. The `students_mc_sync` trigger then fires automatically and enqueues an upsert at the new email.

**Status feedback in the drain.** Before a PUT, the drain checks the resolved student's `marketing_status`. If it's `unsubscribed` or `cleaned`, the row is marked complete with `last_error = 'skipped_unsubscribed'` (or `_cleaned`) and a log entry written — saves an MC API call. Mailchimp would honor the unsubscribe anyway, but skipping locally avoids the rate-limit budget burn for a long-unsubscribed parent who keeps generating outbox rows on every enrollment edit.

**`dk-mailchimp-ping` (verify_jwt: true, super_admin only).** Helper for the admin settings modal. Verifies a pasted API key reaches MC (`/3.0/ping`), lists audiences (`/3.0/lists?...`), lists merge fields for a chosen audience, and (with `create_merge_fields: ["TAG"]`) creates missing required merge fields one at a time. **Super_admin gate runs under the user JWT** via `userClient.rpc("is_super_admin")` — same pattern as `dk-send-intake-form` (CLAUDE.md §4.28 + §5). If you call `is_super_admin()` under the service-role admin client, `auth.uid()` is null and it always returns false. Don't refactor this without preserving the user-bound RPC pattern.

**UI surface — `⚙ Mailchimp` button in the Templates tab head (super_admin only).** Visibility gate is `isSuperAdmin()` directly in `applyRoleVisibility()` — same gate as `dk_config` writes. The modal `#mailchimpOverlay` has four sections (Connect / Webhook / Merge fields / Sync status) plus Save. The webhook URL only renders when `mailchimp_webhook_secret` is set — first save mints it. Audience picker hides until Test connection succeeds (or hydrates from `state.dkConfig.mailchimp_audience_id` on open). Merge-fields list re-runs on audience change so picking a different audience refreshes the missing-field check. Sync status pill rolls up `mailchimp_sync_outbox` (pending / stuck / done-in-24h) and reloads on modal open; **realtime updates land via `supabase_realtime` on `mailchimp_sync_outbox` + `mailchimp_sync_log`** (added to the publication by the migration), so a drain run while the modal is open updates the pill within the 300ms debounce.

**Bulk backfill on first connect (T12b — ✅ shipped).** "Resync all students" button in the Mailchimp settings modal (Sync status section, super_admin only). Calls `enqueue_mailchimp_backfill()` RPC which iterates every `students` row with non-empty `parent_emails` and enqueues one outbox row per `(student, parent_email)` pair. Confirms before firing because re-running on a 5k roster burns API budget (idempotent at MC, drain caps at ~50/min). Refuses to run if `mailchimp_api_key` or `mailchimp_audience_id` is null — no point seeding an outbox the drain will silently skip. Returns `{enqueued, students_covered, enqueued_at}` jsonb so the modal can show "✓ Enqueued N rows across M students." Replaces the previous "admin can `update students set parent_emails = parent_emails` after connect" workaround.

**Out of scope for v1 (deliberate, do not bolt on):** template push to MC's `/3.0/templates`; campaign creation from DK ("Send to class" → segment-by-tag); Mailchimp Transactional / Mandrill (paid, separate product); per-class sub-audiences (one audience, tags handle segmentation); inbound lead capture from MC sign-up forms → DK student row (natural extension once Meta→Mailchimp lead-intake is wired).

### 4.30 Nightly housekeeping — install_nonces / closures / intake purge (T14)

Three tables grow unbounded if left alone (CLAUDE.md §5/§6 has called this out since T2/T8/T11 shipped): `install_nonces`, `closures`, `student_intake_requests`. Volume per franchise is small (low hundreds per year), but every spoke install carries the same debt — cheaper to ship one purge job once than to revisit per-franchise.

**One function, four steps, daily at 03:30 UTC.** `nightly_housekeeping()` is `security definer`, runs as the cron postgres role, and:

1. **Marks pending-but-expired intake rows as `'expired'`.** Without this pre-step, a parent intake link whose `expires_at` passed but which was never resent or cancelled would linger in `pending` forever and never enter the purge window.
2. **Deletes `install_nonces` older than 30 days.** Replay protection only needs the 5-minute token expiry window; 30 days is many orders of magnitude past any legitimate replay risk.
3. **Deletes `closures` whose `date < current_date - 90 days`.** Schedule views never look back that far; if an admin needs historical record, the closure was emailed/posted in real time. Per-school + global closures purge identically.
4. **Deletes `student_intake_requests` in `('expired','cancelled')` older than 90 days post-`sent_at`.** **Completed rows are NOT purged** — `submitted_payload` is the only place the parent's original submission survives reconciliation/edits to the resulting student row.

Returns a jsonb summary `{ran_at, intake_marked_expired, install_nonces_purged, closures_purged, intake_requests_purged}` so the values land in `cron.job_run_details` for inspection. Function is locked down — execute revoked from public/anon/authenticated; only the postgres superuser (which cron runs as) can invoke it.

The pg_cron job name is `nightly-housekeeping` (consistent with the existing `dk-mailchimp-drain` / `nightly-jackrabbit-sync` / `role-audit-outbox` naming). Schedule re-create is idempotent — the `do $$ ... $$` block unschedules-then-reschedules, so re-applying the migration won't double up.

**Why the conservative retention windows.** Each table is useful audit trail at short range. 30/90/90 covers "last quarter" for any forensic need (who installed when, what days were closed, what intakes failed) while keeping growth bounded. If a future contributor wants longer or shorter retention, edit the four interval literals and re-apply — no schema change needed.

**Why NOT a per-row TTL or partitioning.** Volume is low enough that a daily DELETE is sub-millisecond per table. Partitioning by month would add operational ceremony with no measurable benefit until volume crosses six figures, which won't happen at franchise scale.

### 4.31 Meta Lead Ads inbox — staging table + webhook + reply/promote (T15)

T15 turns Meta-sourced leads into a first-class DK surface. Mailchimp continues to receive the same leads independently via its native FB Lead Ads connector (configured Sharon-side), so the franchise gets MC's marketing-email side AND DK's enrollable-student side from the same Meta submission. **Direction decided 2026-05-07** (per §6 entry): keep MC for campaign authoring + deliverability; build a thin DK-side intake for the enrollable-student path. T15 is that thin DK side.

**Schema is one staging table, no rewrites elsewhere.** `leads` carries normalized parent/child fields (parent_name/email/phone, child_name/dob, school_of_interest), Meta provenance (`meta_lead_id` UNIQUE for idempotency, plus form/page/ad ids), `raw_meta_payload` jsonb for audit, a `lead_status` enum (`new` / `contacted` / `promoted` / `junk` / `archived`), audit fields for promote (`promoted_student_id`, `promoted_at`, `promoted_by`) and contacted (`contacted_at`, `contacted_by`), and `last_fetch_error` for surfacing webhook-time failures. **Why a staging table instead of `students.source = 'meta_lead'`:** Meta payloads are messy (test submissions, fat-fingered phones, no class selection). Promoting to a real student should be an explicit admin action, not automatic — same rationale as T11's `student_intake_requests` (§4.28).

**Permission: REUSED, not new.** `respond_to_leads` was already in super_admin/admin/manager bundles from earlier phases (visible in T10's `has_permission()`). T15 gates SELECT/INSERT/UPDATE/DELETE on it directly. **Why not split into `manage_leads` + `respond_to_leads`:** v1 doesn't need the granular split. Same §4.5 pattern of consolidate-first-split-later. If a franchise ever wants a delegated bookkeeper-style role that archives but doesn't reply, that's a one-line gate change, not a schema change.

**Two RPCs handle the state transitions worth being atomic:**
- **`promote_lead_to_student(lead_id, first, last, dob?)`** — `security definer`, gates on both `respond_to_leads` AND `edit_students`. Inserts a `students` row with `source='dk_local'`, parent contact arrays carried from the lead, then marks the lead `promoted` + stamps `promoted_student_id` / `promoted_at` / `promoted_by`. Atomic — if the student INSERT fails, the lead doesn't move. **Class assignment is deliberately NOT in this RPC** — Meta forms don't pick a class, and the admin already needs to open the class detail panel to add an enrollment row anyway. Splitting the responsibilities keeps the RPC tight and lets the admin pick the class with full context (terms, capacity, school).
- **`mark_lead_contacted(lead_id)`** — `security definer`, gates on `respond_to_leads`. Stamps `contacted_at` / `contacted_by` and flips status from `new` to `contacted` (preserves any other status — re-replying to an already-promoted lead doesn't demote it). Called from the reply modal's Copy and mailto buttons.

**Edge Function `dk-meta-lead-webhook` (verify_jwt: false).** Auth IS the HMAC signature on POST + the verify token on GET — same pattern as `dk-install-callback` and `mailchimp-webhook`. Three env vars: `META_APP_SECRET` (HMAC verification), `META_VERIFY_TOKEN` (subscription handshake), `META_PAGE_ACCESS_TOKEN` (to fetch field_data — Meta's webhook only carries pointers, the actual lead values come from `GET /{leadgen_id}`). If `META_PAGE_ACCESS_TOKEN` is unset, the row still lands with `last_fetch_error` populated so the admin sees something arrived — same "skip if not configured" pattern as the Mailchimp drain (§4.29).

**Always returns 200 on POST.** Meta retries non-2xx for hours and we don't want stuck queues. Failures land in `leads.last_fetch_error`, not the HTTP status. The function tracks per-request counts (`inserted`, `skipped`, `errors`) and includes them in the 200 body for log-time inspection.

**Idempotency via `meta_lead_id` UNIQUE + `INSERT … ON CONFLICT DO NOTHING`.** Meta retries the same leadgen webhook on non-2xx (or its own internal hiccups), and we always 200 — so retries shouldn't happen often, but when they do they're silent. **Don't change to `ON CONFLICT (meta_lead_id) DO UPDATE`** unless you also gate the UPDATE on `status = 'new'` — otherwise a Meta retry could clobber an admin's notes / status changes.

**UI surface — new "Leads" top-level tab.** Visible to super_admin/admin/manager via `ROLE_TAB_VISIBILITY` (teachers + viewers don't see it). Inbox card grid with filter chips (`new` / `contacted` / `promoted` / `junk` / `archived` / `all`) showing per-status counts, free-text search across parent name/email/child/notes, and per-row action buttons: View / Reply / Promote / Junk / Archive / Reopen (last for junked/archived). Click View → read-only modal showing every column + `raw_meta_payload` collapsible. Click Reply → reuses the existing template machinery: a template picker that substitutes `{lead_parent_name}`, `{lead_parent_first}`, `{lead_email}`, `{lead_phone}`, `{lead_child_name}`, `{lead_child_dob}`, `{lead_school}` via `leadVariableContext()` against the same `substitute()` helper templates use everywhere else. Editable subject + body, Copy-to-clipboard or mailto, and either action calls `mark_lead_contacted` to flip the row to `contacted`. Click Promote → small form (first/last/dob, pre-filled by splitting `child_name`) → calls `promote_lead_to_student` → admin then opens the new student in Classes to add an enrollment.

**Mobile registers the tab as a Tools-sheet overflow item with the 📥 icon** — same pattern as Sub requests / Curriculum (§4.17). Auto-hidden alongside the rest of the overflow tools when no role-visible tools remain.

**Realtime publication: `leads` is in `supabase_realtime`.** A new lead landing via the webhook lights up the inbox live within the 300ms debounce — admins watching the tab on a phone don't need to manually refresh. Cross-device coordination (one admin marks junk, another sees it disappear from `new`) flows through the same channel.

**Sharon-side setup checklist (from earlier conversation, captured here so it survives):**
1. In Meta App Dashboard, add Webhooks + Lead Ads products to a Meta App.
2. Subscribe the webhook on the Page object: callback URL `https://ybolygqdbjqowfoqvnsz.supabase.co/functions/v1/dk-meta-lead-webhook`, verify token = whatever string Sharon picks (paste into both Meta and DK env). Subscribe to the `leadgen` field.
3. Generate a long-lived Page Access Token for the FB Page running the ads (Meta Graph Explorer → Get Page Access Token → extend to long-lived).
4. Set Edge Function env vars on the DK Supabase project: `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_PAGE_ACCESS_TOKEN`.
5. Subscribe the Page to the app: `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen` with the page token.
6. Test with Meta's Lead Ads Testing Tool — submit a fake lead and watch the row land in `leads`.

**Multi-tenant follow-up (T15.5, not yet built).** Today's `META_PAGE_ACCESS_TOKEN` env var works for franchise #1 but doesn't scale to many franchises onboarding without a 2-minute paste-into-Supabase-dashboard step each. T16's spec (§4.32) covers the right pattern: one PAR DK Meta App reviewed once, every franchise connects its own Page via in-app OAuth, page token persists in `dk_config`. T15 should migrate to read the page token from `dk_config` instead of `Deno.env.get()` at the same time T16a lands the OAuth flow — no point shipping the OAuth flow for T16 and leaving T15 on env vars. The current Edge Function will work unedited for Charleston until then; the migration is a small change (read from `dk_config` if present, fall back to env var if not).

**Out of scope for v1 (deliberate, do not bolt on):** auto-sending a T11 student-intake form to the parent on promote (could chain in v2 — admin would still want to pick a class first); a "fetch full lead details" button to re-trigger the Edge Function's Meta GET against an existing row that's stuck on `last_fetch_error` (today's path is to fix the env var and resubmit the lead in Meta's testing tool); per-row `notes` editing in the inbox UI (the column exists in the schema and is surfaced read-only in the card; an inline editor is a v2 affordance). Infographic attachment in the reply modal **is** wired (a horizontal strip of tag-filterable thumbnails below the editor row inserts the public image URL at the textarea's cursor on click) — see the same §4.31 once you scroll up; both copy-to-clipboard and mailto carry the URL through unchanged so any modern email client renders it as an inline preview.

### 4.32 Messenger / Instagram inbox — designed, blocked on Meta App Review (T16)

T15's leads inbox handles Meta Lead Ad form submissions. T16 is the parallel surface for **two-way conversations from Facebook Messenger and Instagram Direct** — same Meta Page subscription model, but the events are richer (full message threads instead of one-shot leads), so the schema needs to be conversation-shaped instead of flat.

**Why two-way isn't a T15 extension.** Lead Ads webhooks fire once per submission and we never write back. Messenger / IG webhooks fire on every inbound message (and require us to send replies through the Graph API — `POST /me/messages` for FB, `POST /{ig-user-id}/messages` for IG). The state model is fundamentally different: a `conversations` row that holds the (page_id, sender_id) thread + per-message rows ordered by timestamp. Trying to overload `leads` would require adding a thread column, a sender column, a direction column, etc. — at which point we've replaced the schema in place. Cleaner to ship as its own slice that reuses the *transport* (Page webhook, Edge Function pattern, Graph API page token) but has its own tables, RPCs, and UI.

**Schema (proposed):**

- **`conversations`** — `(page_id, channel ∈ {messenger, instagram}, sender_psid)` unique, plus `sender_name` / `sender_profile_pic_url` (from the User Profile API), `last_message_at`, `last_message_excerpt`, `unread_count`, `linked_student_id` (nullable FK; admin can manually link a conversation to a known student row, mirroring T15's promote step), `linked_lead_id` (nullable FK to `leads` so an existing lead that turns into a Messenger conversation can carry its context forward).
- **`conversation_messages`** — `conversation_id`, `mid` (Meta's message id, UNIQUE for idempotency), `direction ∈ {inbound, outbound}`, `sender_psid` / `recipient_psid`, `text`, `attachments jsonb` (Meta sends image / video / file URLs here), `template_id` (nullable FK — if the outbound message was sent from a saved template, link it for analytics), `infographic_ids uuid[]` (nullable — same idea for infographic attachments), `created_at`, `delivered_at`, `read_at`, `failed_at`, `error_message`.
- **`messenger_outbox`** — outbound queue, same shape as `mailchimp_sync_outbox` (T12). Sending a message INSERTs an outbox row; a drain Edge Function (or inline send-immediately on first try with retry-via-outbox on failure) calls Graph API `POST /me/messages`. Idempotency via the message's local `mid_local` UUID echoed back in Meta's response (`message_id`) and stored.

Two new permissions: **`read_messenger`** (super_admin / admin / manager — same set as `respond_to_leads`) and **`send_messenger`** (same set; split so a future role could read inbox without sending). Both go in the bundles in `has_permission()` SQL + `PERM_BUNDLES` JS, byte-identical per §4.4.

**Edge Functions (proposed):**

- **`dk-messenger-webhook`** (verify_jwt: false). Same Page subscription as T15's `dk-meta-lead-webhook`, just with `messages` field added to the `subscribed_apps` POST. Handles both subscription handshake and POST events. POST shape: `entry[].messaging[].message` (text, attachments, mid, sender.id, recipient.id, timestamp). Verifies HMAC against `META_APP_SECRET` (reuses the T15 env var — both webhooks use the same App Secret since they're in the same Meta App). Idempotent insert via `conversation_messages.mid` UNIQUE; upserts the parent `conversations` row (creating if missing, bumping `last_message_at` + incrementing `unread_count` if the channel is open elsewhere).
- **`dk-messenger-send`** (verify_jwt: true). Called by the in-app reply UI. Verifies caller has `send_messenger`, then Graph API `POST /me/messages` with the page token, persists the outbound `conversation_messages` row with the returned `message_id`. Image attachments (infographics) go via Meta's attachment upload API — POST a `message_creative` with `attachment.type=image` + `attachment.payload.url` pointing at the public infographic URL.
- **`dk-messenger-mark-read`** (verify_jwt: true). Calls `POST /me/messages` with `sender_action=mark_seen` to flip the read receipt visible to the parent, then resets `unread_count` to 0 locally.

**24-hour standard messaging window — load-bearing constraint.** Meta Messenger only allows free-form replies within 24 hours of the user's last message. Outside that window you need either a **message tag** (e.g. `HUMAN_AGENT` for human-staffed pages, requires Meta-side enablement) or a **non-promotional message template** (highly restricted). T16's UI must surface "(window expires in 4h)" / "(window expired — admin response only)" badges on each conversation, AND `dk-messenger-send` must refuse to send a free-form reply outside the window unless a tag is explicitly chosen. **This is the kind of business-rule gate that has to be enforced on both the client UI AND the Edge Function** — same pattern as T5c's curriculum lead-window check.

**App Review is the blocker.** Production access to `pages_messaging` (and `instagram_manage_messages` for IG) requires Meta App Review: a screencast demonstrating the use case, a written description of how the data is used, and a privacy policy URL. Typical turnaround: 1–2 weeks; first submission often gets bounced for a screencast clarification. The **`pages_show_list` + `pages_manage_metadata` + `pages_messaging`** permission triad is the standard Messenger ask; Instagram adds **`instagram_basic` + `instagram_manage_messages`** and requires the IG account be a Business or Creator account linked to the FB Page. Sharon-side work to drive this can run in parallel with our development against the Meta App's "Development mode" (which works for the connected admins only — fine for our testing but won't reach real parents until App Review approves).

**Critical architecture decision: ONE App Review covers EVERY franchise.** Meta App Review is scoped to the **Meta App ID** (App ID + App Secret pair), NOT to individual Pages. So we create **one** Meta App named "PAR DK" (or similar), get it reviewed **once** for the messaging-permission triad, and every franchise that ever installs PAR DK in the future inherits the approval — they connect their own FB Page to our reviewed app via standard Facebook Login for Business OAuth, which mints a per-Page Access Token scoped to the already-approved permissions. **Do NOT create one Meta App per franchise** — that would mean a 1–2-week App Review delay per spoke install, which would make franchise onboarding unworkable at scale. The same one-Meta-App pattern is how every multi-tenant SaaS (HubSpot, Hootsuite, Buffer, etc.) integrates with Meta. We're a SaaS that happens to call itself a "spoke" of PAR; from Meta's perspective, we're one app.

This has three concrete implications for the schema + flow:

1. **`META_APP_SECRET` and `META_VERIFY_TOKEN` stay as Edge Function env vars** on every DK Supabase project, byte-identical across franchises. They're OUR app's secrets — not per-Page. Same handling as `SPOKE_INSTALL_SIGNING_SECRET` (§4.7).

2. **Page Access Token MUST move from Edge Function env var to per-franchise storage.** T15's current `META_PAGE_ACCESS_TOKEN` env var works for the single Charleston franchise because today there's one DK Supabase project for one franchise. When franchise #2 onboards, its Supabase project will have its own env var with its own page token — also fine, single-tenant per-project. But to make franchise onboarding click-not-paste, we add `dk_config.meta_page_id` + `meta_page_access_token` (encrypted via pgsodium) + `meta_page_name` + `meta_ig_user_id` + `meta_token_expires_at` and write a small in-app **"Connect Facebook Page"** OAuth flow that handles the token mint inline. Sharon (and every future franchise admin) clicks Connect → Facebook OAuth → DK persists the resulting page token. No more "go to Graph Explorer, get a long-lived token, paste into Supabase dashboard." T16's Edge Functions read the token from `dk_config` at request time instead of `Deno.env.get()`.

3. **The webhook resolves the franchise from the inbound `entry[].id` (page_id).** A single Meta App can have many Pages subscribed; webhook deliveries carry the page_id that fired the event. The webhook handler queries `dk_config where meta_page_id = $1` to find which franchise's data to write into. **This works whether DK is one Supabase project per franchise (today's model) or one project for all franchises (future model)** — in the per-project model the lookup just always returns the singleton row, since each project only has its own Page subscribed. Same code path, no branching.

**T15 can migrate to this pattern in a follow-up.** Today's env-var approach for T15's `META_PAGE_ACCESS_TOKEN` is fine for franchise #1, but for franchise #2 onboarding we should ship a small **T15.5** that adds the OAuth flow + persists the page token in `dk_config`, and switches `dk-meta-lead-webhook` + (future) `dk-messenger-*` functions to read it from there. The same OAuth flow serves both T15 and T16 — connect once, both surfaces work — so doing it as part of T16a is the natural place.

**Sharon-side checklist with the multi-tenant pattern (replaces the per-franchise token-paste workflow):**
1. **One-time, our side:** create the "PAR DK" Meta App, configure webhooks for `leadgen` + `messages` fields, submit for App Review covering `pages_messaging` + `pages_show_list` + `pages_manage_metadata` + (optionally) `instagram_basic` + `instagram_manage_messages`. Set `META_APP_SECRET` + `META_VERIFY_TOKEN` env vars on every DK Supabase project.
2. **Per-franchise, Sharon's side:** in DK, click **Connect Facebook Page** → Facebook OAuth dialog → pick the franchise's FB Page (and optionally its linked IG account) → DK persists the page token in `dk_config`. That's it. ~30 seconds, no Graph Explorer.

**Why this matters for franchise economics.** PAR's spoke model is "many franchises × many spokes." If every spoke required its own Meta App Review per franchise, the multiplication would crush onboarding velocity. By treating PAR DK as one app — one Meta App per spoke product, not per spoke install — adding a 50th franchise costs ~30 seconds of OAuth instead of 2 weeks of App Review. This same pattern applies if PAR ever ships other Meta-integrated spokes (a Selectively-branded calendar app integrating Google / Meta calendars, say): one app per spoke, not per franchise.

**UI surface (proposed):**

- New **Messages** top-level tab (super_admin / admin / manager) sitting next to **Leads**. Two-column layout on desktop: conversation list on the left (search + filter by channel + unread/all toggle), thread view on the right (message bubbles, infinite-scroll pagination on history, sticky composer at the bottom).
- **Composer reuses everything from T15.** Template picker + `{var}` substitution against a `messengerVariableContext(conversation, lastInboundMessage)` helper (mirrors `leadVariableContext`), live placeholder preview (yellow chips), click-to-select-in-textarea. Infographics row underneath the composer — same pattern T15 will have once today's commit lands. Difference: instead of copy/mailto, the Send button calls `dk-messenger-send`.
- **Promote-to-student button** on each conversation, same shape as T15's lead promote — opens a modal pre-filled from the conversation's known fields (sender_name → first/last guess), calls a `promote_messenger_thread_to_student(conversation_id, first, last, dob?)` RPC that creates the student + stamps `conversations.linked_student_id`. Messages stay attached to the conversation; future inbound messages auto-resolve to that student.
- **Mobile** registers as a Tools-sheet overflow item with a 💬 icon, body collapses to thread view (conversation-list opens via a back button) — same one-pane-at-a-time pattern as Curriculum / Sub requests at ≤720px.

**Realtime publication: `conversations` + `conversation_messages` + `messenger_outbox`.** Same channel as everything else. New inbound messages light up the inbox live within the 300ms debounce; outbound delivery / read receipts update message bubbles in place.

**Out of scope for v1 (deliberate, do not bolt on):** payment / tip integration (Messenger has it; not relevant to a Drama Kids franchise); message reactions surfaced as their own UI; voice / video calling; bulk broadcast (Meta restricts it heavily and Mailchimp covers the marketing path anyway, see §4.29); auto-replies / chatbots — the franchise wants templated *human-sent* responses, not auto-replies; SMS / WhatsApp (different Meta product, separate App Review).

**Path to ship.** Phase split:
1. **T16a — Schema + webhook receive only + the in-app OAuth flow that mints the per-franchise Page token (also unblocks the T15.5 migration off env vars).** No outbound messaging. Inbox tab shows incoming messages read-only (admin replies via the Meta-native UI). Useful as a "central inbox view" even without the send path. Doesn't require `pages_messaging` write scopes (the read scope is `pages_read_engagement`, much faster to get). Adds the `Connect Facebook Page` button + OAuth handler + per-franchise token storage in `dk_config` — both T15's leadgen webhook and T16's messages webhook switch to reading the token from `dk_config` here.
2. **T16b — Send path + composer.** Adds `dk-messenger-send`, the templated composer, and the infographic attach (mirroring T15's reply modal). Requires `pages_messaging` App Review on the one PAR DK Meta App; once approved, every franchise that connects via T16a's OAuth flow inherits the approval.
3. **T16c — Instagram parity.** Mirrors T16a/b for IG. Same schema (channel column already accommodates), separate App Review for `instagram_manage_messages` on the same Meta App.

Splitting this way means T16a can ship in days once the schema lands and the Page subscription is updated; T16b waits on App Review (which only needs to clear once for every franchise across all time); T16c is independent and can be sequenced after.

---

## 5. Gotchas, quirks, and "don't touch this"

**`is_admin()` matches super_admin OR admin.** See §4.5. Don't refactor it to mean just admin — it still gates the admin-only residue (`class_infographics`, `teacher_invitations`, `dk_config`, `role_audit`, `install_nonces`, etc.) that T3 and T1.5 didn't migrate to `has_permission()`.

**`PERM_BUNDLES` in `app.js` ↔ `has_permission()` in SQL must stay byte-identical.** Any role/permission change requires editing both. If they drift, the UI lies about what the user can do.

**`handle_new_user` does more than create a profile.** It also redeems pending invitations by email. Don't casually replace it. See `migrations/phase_t2_teacher_invitations.sql`.

**`par-identity-proxy` v5 runs auto-promotion inline.** After caching identity, it checks PAR org memberships and promotes role if applicable. If you refactor this function, preserve that logic or the install flow stops auto-promoting.

**`spoke-get-identity` returns `org_memberships[]` across ALL linked auth users.** A person's work email and personal email both map to the same `person_id` via `identity_links`; `spoke-get-identity` collects org memberships from EVERY linked auth user. Don't filter to just the queried email's auth user — you'd miss memberships.

**Install tokens are single-use via `install_nonces`.** Reloading the install page with the same token fails with "Token already consumed (replay detected)." That's intentional. For legitimate re-install, go back to PAR's Connected Apps and click Install again to mint a fresh token.

**Edge Function `verify_jwt` setting matters.** `dk-invite-teacher` has `verify_jwt: true` because it must verify the caller is an admin user (JWT-authed). `par-identity-proxy`, `spoke-get-identity`, `dk-install-callback`, `jackrabbit-sync`, `zapier-enrollment-webhook` all have `verify_jwt: false` because they authenticate via bearer API keys, shared secrets, or signed tokens — not user JWTs. Don't toggle these without knowing why.

**The teacher bento prefers `profiles.teacher_id` (T6d) and falls back to email match.** All lookups go through `mySignedInTeacher()` which checks the FK first, then case-insensitive email match against `teachers.email`. If neither resolves (teacher accepted an invite, no FK linked yet, work email doesn't match any teachers row), the teacher bento shows a "no teacher record" welcome card. Fix path: open the Users tab and use the role-management modal to set the linked teacher (§4.24).

**The realtime channel uses one channel for all tables with a 300ms debounce.** Don't create per-table channels — you'll hit connection limits. Don't remove the debounce — it coalesces burst writes.

**Sidebar (Infographics panel) is visible only on the Templates tab.** See `SIDEBAR_TABS` in `app.js`. (The standalone Infographics tab was retired during T6c — its CRUD UI now lives in a modal off the Templates tab head, see the consolidation gotcha below.) The layout shifts accordingly.

**The 3-day / 7-day / month schedule views all share `classRunsOnDay` + `classStartTimeOn`.** They pass the same cls/date to these helpers — don't introduce view-specific variants.

**The install flow's success page links to `/` (the app root).** DK's root redirects to login if no session is present. Sharon lands on login → types her work email → magic link. Don't change `continue_url` in `dk-install-callback` without also changing the install-page logic.

**Vercel deploys from `github.com/jlyonsld/DK` `main`.** Branch protection is OFF. `git push` on `main` triggers a production deploy within ~30 seconds. Test locally or in a branch first if you're not confident.

**The archived PAR source at `~/Documents/Claude/Projects/Selectively/PAR-NATIVE-archive/source-original/` is NOT the live PAR repo.** The live PAR repo is at `~/selectively` (connected to `git@github.com:jlyonsld/Selectively.git`). Edits to the archive don't deploy. Easy to get wrong when assisting with PAR work.

**PAR and DK share `PAR_SPOKE_API_KEY` and `SPOKE_INSTALL_SIGNING_SECRET`.** If you rotate either, rotate on BOTH Supabase projects simultaneously or the federation breaks.

**The closures + install_nonces + student_intake_requests purge runs nightly (T14).** `nightly_housekeeping()` at 03:30 UTC purges install_nonces > 30d, closures > 90d, and terminal intake_requests > 90d (after first flipping pending-but-expired intakes to `'expired'`). Don't add per-table cleanup logic anywhere else; route any new retention rule through this function so the four interval literals stay co-located. Completed intake rows are intentionally retained (their `submitted_payload` is the audit trail). See §4.30.

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

**Categories AND Infographics tabs are gone — both are managed via modals off the Templates tab head.** The standalone Categories tab was retired during T6b's UI consolidation; the Infographics CRUD tab followed during T6c for the same reason (handful of inline-editable rows that didn't justify a top-level slot, and the Templates tab is the natural place to discover them since both are template-companions). The "⚙ Manage categories" and "🖼 Manage infographics" buttons in the Templates tab head open `#categoriesOverlay` and `#infographicsOverlay` respectively; the existing `renderCategoriesTab()` / `renderInfographicsTab()` functions stayed as-is — they now render into the modals' `#categoryList` / `#infographicsTable` (same ids as before, just relocated) and the modal-open handlers call them. **`ROLE_TAB_VISIBILITY` no longer lists "categories" or "infographics"** for any role; the tools-overflow auto-hide check was updated to match; `SIDEBAR_TABS` shrunk from `{templates, infographics}` to `{templates}`. If you want to bring back a standalone tab, restore those strings AND add a tab panel to `index.html` AND add the panel id back to whatever bento/sidebar logic toggles tab visibility.

**`set_profile_role()` refuses to demote the LAST super_admin.** The RPC counts `profiles where role = 'super_admin' and id <> p_profile_id` and raises `'Cannot demote the last super_admin'` if zero. This protects against a franchise locking itself out (e.g. a super_admin demoting themselves while no other super_admin exists). If you need to actually transfer the super_admin role to a new owner, do it as a TWO-STEP operation through the Users tab: promote the new person to super_admin first, THEN demote the old one. Don't try to bypass the guard with raw SQL — `is_admin()` and `has_permission()` rely on at least one super_admin existing for the install flow's auto-promote (§4.8) to recover the org.

**`profiles.teacher_id` is one-to-one, enforced by a unique partial index.** `profiles_teacher_id_unique where teacher_id is not null` allows multiple NULL profiles but rejects two profiles pointing at the same teachers row. Two profiles claiming the same teacher would silently break the teacher bento (whose shift card?), `canTakeAttendanceFor` (whose attendance window?), and clock-in (whose shift?). If you need to "transfer" a teacher record between profiles, unlink the old one first (`link_profile_to_teacher(old, NULL)`) before linking the new one. Don't relax the index.

**Events render with a DASHED left border; classes render SOLID.** This is the visual rule across every schedule projection (Day spine, Week absolute blocks, Month rows) AND the Events tab cards. If you add a new schedule view or summary surface, follow it — admins look at the schedule a hundred times a day and any drift causes them to misread an event as a class. The kind colors live in `EVENT_KIND_META` (free_class=170 teal, training=270 violet, promotional=38 amber, other=210 slate); never hardcode an event color outside that lookup. If a future kind needs a new hue, add the row to `EVENT_KIND_META` and `EVENT_KIND_OPTIONS` together — they're parallel arrays for editor-dropdown vs. lookup, and adding to one without the other shows the new kind in only half the UI.

**Events SELECT is open to all signed-in users; writes gate on `edit_events` (T9).** This mirrors classes/schools — the schedule must render every event for every viewer (a teacher needs to see a promotional event running on the same day they teach), and promotional events are visible across the team by design. The `edit_events` permission lives in super_admin/admin/manager bundles. Teachers + viewers see events but can't write them. **Don't tighten SELECT to "events the user is staffed on"** — the schedule layer would have to plumb the filter through `eventsForDate()` anyway, and the only data benefit would be hiding a promo event from a teacher who's not running it (which we want them to see).

**The `pendingNewEventStaff[]` buffer exists because new events have no id at staff-add time.** When opening the editor on an existing event, staff add/remove/role-edit writes to `event_staff` immediately so other admins see it via realtime. When opening on a new event (no id yet), staff additions buffer in `pendingNewEventStaff` and only flush to `event_staff` AFTER `events.insert()` returns the new id. **Don't try to insert event_staff with `event_id: null` and patch later** — the FK is NOT NULL and would fail. If staff insert fails after event insert succeeds, the event survives but the staff list is empty; the toast says so and the editor closes (the admin can re-open and add staff manually). This is the same pattern as the curriculum-assignments + class_teachers add-flows.

**Multi-day events appear on every covered day.** `eventsForDate(date)` checks `iso(starts_at) ≤ date ≤ iso(ends_at)`, so a Sat–Sun training renders on both Saturday and Sunday in all three views. Day view's `eventStartTimeOn(ev, date)` returns midnight of `date` for events that started earlier so they sort to the top of that day's list (rather than appearing at their original 9 AM start time on a day they're already in progress). Week view positions them at the actual hour of the day they began the multi-day window — for follow-on days they show at the column top with their full duration. **Don't try to "split" a multi-day event into per-day rendering with separate start/end times** — the event row in the DB is the source of truth and the schedule must reflect that one row, not generate phantom rows. If a franchise wants per-session events (e.g. a 3-day workshop with distinct daily titles), that's three separate event rows.

**Inventory assignments materialize the time window at write time and don't auto-update if the parent class's `times` string changes (T10).** `inventory_assignments.usage_starts_at` / `usage_ends_at` are snapshotted from `classSessionTimeWindow(cls, sessionDate)` (for class assignments) or `events.starts_at`/`ends_at` (for event assignments) when the row is inserted. **This is intentional** — a teacher who already pulled a costume for the original 3 PM slot shouldn't have their assignment silently re-scoped if the admin later edits the class to 4 PM. Conflict overlap math runs against the snapshotted columns, so old assignments stay visible as historical conflicts even after the class moves. If you genuinely want to retime an assignment, delete + re-create it; the editor's Remove button on each assignment row is the one-click path. Don't add a trigger to keep `usage_starts_at` in sync with `classes.times` — same reason RLS doesn't try to evaluate the `times` string (CLAUDE.md §4.22 lead-window rationale).

**Inventory conflicts are detection-only, never DB-blocked except for exact-target duplicates (T10).** Two partial unique indexes prevent the *same item assigned to the same class session twice* (`inventory_assignments_class_unique`) and the *same item assigned to the same event twice* (`inventory_assignments_event_unique`), both excluding returned rows. Cross-target overlaps (same item assigned to a class at 3 PM AND an event at 3 PM the same day) are NOT blocked — admins occasionally need to override double-bookings (e.g. "the tail end of the class overlaps the start of the demo, but we'll grab the prop in between"). The UI surfaces conflicts in five places (Inventory card badges, editor assignment list, assign-picker, class-panel chips, event-editor inventory list) so they can't slip past. **Don't add a CHECK or trigger to block overlaps** — you'd break legitimate admin overrides.

**The `inventory-photos` bucket is PUBLIC, unlike `curriculum-assets` and `teacher-documents`.** Inventory photos are reference shots ("what does this prop look like"), not sensitive PII or licensed corporate curriculum. Public bucket + `getPublicUrl` is the right pattern; the URLs go straight into `inventory_items.photo_urls` and render via `<img>` from anywhere. **Don't add an Edge Function intermediary** — there's no per-row authorization story (everyone signed in can already SELECT the item row + URL via the table policy), no audit log requirement (no compliance angle), and no lead-window. If you ever need to delete a photo from the bucket, use `inventoryStoragePathFromUrl()` to strip the path back out of the public URL — the helper handles the `/object/public/inventory-photos/<path>` URL shape Supabase mints.

**The "+ Assign inventory…" button on the event editor only renders for SAVED events (T10).** New-event creation has no event id yet, and `inventory_assignments.event_id` is NOT NULL. Same shape as `pendingNewEventStaff` for the staff list, but inventory assignments are heavier (capture a time window, conflict-check, multi-select) and the franchise workflow is "create event, then come back to assign inventory" — a click-back is fine. **Don't add a `pendingNewEventInventory[]` buffer** — every conflict check needs the resolved event time window which is only authoritative after `events.insert()` returns. If the admin is in the middle of editing dates, mid-buffer assignments would conflict-check against stale times.

**Mobile header collapses to a single row at ≤720px.** Brand text (the "PAR DK / Response Console" stack) hides — only the logo remains, scaled down to 28px. The standalone `#signOutBtn` is hidden via `display: none !important` and the user-chip becomes a `<button>` that opens a `.user-menu` popover. The popover holds the user's name/email/role/PAR-link CTA + a Sign-out menu item. **`<a>` cannot live inside a `<button>`** — that's why the legacy "Connect to PAR" anchor inside the chip moved to the menu. If you put HTML back inside `#userChip`, keep it span/text only or browsers will silently break the chip's click handling. The popover is positioned absolute against `.header-top` (which sets `position: relative`) — don't remove that or the menu floats relative to the wrong ancestor.

**Student intake tokens: DB stores ONLY sha256(token), never the raw value (T11).** `student_intake_requests.token_hash` is `sha256(raw_token_hex)`. The raw token only ever exists in (a) the URL emailed to the parent and (b) the single response from `dk-send-intake-form` (so the admin can copy/paste in the result modal). Verification re-hashes the URL token and looks up by hash — same defense pattern as a salted password hash, but no salt needed because the token IS 32 random bytes (no rainbow-table risk). **Don't add a `token` column** — a DB leak would then expose every live intake link. Resending uses `resend_intake_id` to rotate the token + push expiry on the existing row, which immediately invalidates the previous emailed link.

**`dk-send-intake-form` calls `has_permission()` under the user-bound supabase-js client (T11).** Because `has_permission(perm text)` reads `auth.uid()` internally — when called via the service-role admin client, `auth.uid()` is NULL and the function always returns false. Fixed once already in `dk-send-intake-form/index.ts` (uses `userClient.rpc("has_permission", { perm: "edit_students" })`). **Don't refactor the permission check to use the admin client** unless you also pass `auth.uid()` explicitly via SQL — easier to keep the user-bound RPC pattern. Same trap exists for any Edge Function that wants to gate on a permission bundle.

**`dk-submit-intake-form` is `verify_jwt: false` and that is correct (T11).** The parent has no Supabase auth session — they're a member of the public, the email link IS their entire credential. Same auth model as `dk-install-callback` (HMAC-signed token). **Don't try to layer manual JWT verification on top** (the curriculum-fetch pattern from §3) — there's no JWT to verify. The token in the body, hashed and compared to the persisted `token_hash`, is the authentication.

**Photo permission on `students` is tri-state, not a boolean (T11).** `students.photo_permission` is `boolean NULL` where `null` means "we never asked." The intake form, the Add Student modal, AND the parent self-fill form all expose three radio options (Yes / No / Not asked) and persist null when the admin/parent picks "Not asked." Any UI that filters or summarizes by this column has to handle three states. The Class detail panel's `📷 no photos` chip renders ONLY when `photo_permission === false` — null doesn't trigger it (we don't yell "we don't know" at the admin every render).

**Renaming the `assign-row` class to `enrollment-row` for student rows in the class panel was deliberate (T11).** Pre-T11 the enrolled-student row used the same `.assign-row` flex layout as the teacher list (single line, name + status pill on the right). T11 needs two-line layout (name row + parent contact row + emergency line) which `.assign-row`'s flexbox fights. The new class is `.enrollment-row` with `display:block` + manual flex on the inner header row. Don't try to make `.assign-row` work for both — they're now different shapes.

**The intake-row "Pending parent forms" subsection is gated on RLS, not role.** Admins see all pending intakes for a class; teachers see them only if they're on `class_teachers` for that class (RLS policy `intake_requests_select_teacher` does the email-match join through `teachers.email`). If a teacher reports they don't see a pending form they expected, check whether their `teachers.email` is set AND matches their `auth.jwt() ->> 'email'`. Same fragility as the teacher-bento "today's shifts" lookup pre-T6d (CLAUDE.md §5).

**Cell-level red hatch on Month view fires ONLY for global closures (T13).** The `closed-full` class on a `.sched-month-cell` and the cell-wide `.closed` modifier on a `.sched-week-daycol` come from `globalClosuresForDate(d)`, NOT `closuresForDate(d)`. This is by design: a per-school closure ("Mt Pleasant ES is on a snow day") shouldn't darken every other school's classes on the grid for that day — it would tell the admin nothing useful. Per-school closures dim only the affected class rows via the `.sched-closed` class. **Don't refactor the cell treatment to use `closuresForDate`** — you'll re-introduce the multi-school noise problem T13 fixed. If you genuinely want a "any closure today" cell hint, add a separate, lighter visual (e.g. a corner dot) — don't overload the red hatch.

**`closuresForClassOnDate` is the only correct way to ask "is this class closed today?" (T13).** Don't filter `state.closures` by date alone — a class at School A is unaffected by a closure scoped to School B, but the naive filter would say it's closed. The helper handles both global (school_id null → affects every class) and scoped (school_id matches `cls.school_id`) cases. If a class has neither `cls.school_id` nor `cls.location` set (a manually-added class with no school), only global closures will show it as closed — which is correct, since there's nothing to scope a per-school closure against.

**Base PAR-card variants must NOT be dismissable (T7b).** Only variants flagged `dismissable: true` in `PAR_VARIANT_COPY` render the `×` button. The four base variants — `unlinked_admin`, `unlinked_teacher`, `linked_admin`, `linked_franchise_owner`, `linked_teacher` — all double as the user's primary nav to PAR; hiding them orphans the link. **Don't add a `dismissable: true` to any base variant** — the only honest UX response to a dismiss on a base would be to render nothing, and there's no replacement nav surface for it. If a future requirement actually wants "hide PAR forever," add it as a profile-level setting, not a per-event dismiss. The dismiss button is also a sibling of the anchor, not nested inside it; nested interactive content is invalid HTML and clicks pass through to the anchor on some browsers, navigating the user to PAR even when they meant to dismiss.

**`isVariantDismissed` reads from `state.parPromoEvents`, not Supabase directly (T7b).** The check runs on every `renderParBridgeCard()` call (once per home tab render). Querying live would mean a Supabase round-trip per render, which the realtime debounce already handles for free — the in-memory cache is rehydrated by `reloadAll()` and updated by the optimistic `_local_*` push on dismiss-click. **Don't refactor the check to query the DB directly** — you'd reintroduce the latency the optimistic push exists to hide. If `state.parPromoEvents` ever grows huge (years of activity at scale), paginate the SELECT in `reloadAll` to "last 60 days" — the dismiss check only needs `PAR_DISMISS_DAYS` of history and the funnel report's date picker tops out at 90 days by preset.

**Mailchimp drain reads its cron secret via the `get_mailchimp_drain_cron_secret()` RPC, NOT a Deno env var (T12).** The vault entry `mailchimp_drain_cron_secret` is the source of truth. Both pg_cron (`select decrypted_secret from vault.decrypted_secrets...`) and the Edge Function (via the public RPC wrapper, which is `security definer` + grant-locked to `service_role`) read the same value. **Don't add a `MAILCHIMP_DRAIN_CRON_SECRET` env var to the Edge Function** — it would either drift from the vault entry (if you only updated one) or duplicate maintenance. The wrapper RPC exists specifically because PostgREST doesn't expose the `vault` schema by default; calling `admin.schema('vault').from('decrypted_secrets')` from supabase-js silently 404s. If you ever need a second cron secret for another function, add a second wrapper RPC (one per secret) — don't try to make a generic `get_vault_secret(name)` RPC because that would let any service-role caller read every vault entry by name.

**Mailchimp drain is "skip if not configured," not "fail if not configured" (T12).** The function returns `{ skipped: 'not_configured' }` with HTTP 200 when `dk_config.mailchimp_api_key` is null, so the schema can ship before Sharon pastes credentials and the cron job doesn't error out every minute meanwhile. The outbox keeps accumulating — that's fine, it just flushes the backlog the first time someone saves a working API key + audience. **Don't change this to a 500** — pg_cron logs every non-2xx as a job failure and the dashboard noise is unnecessary.

**Mailchimp merge-fields are an allow-list enforced TWICE in the drain (T12).** `MC_ALLOWED_MERGE_FIELDS` is a tuple, the merge-fields object literal only has the six keys, AND a defensive `for (const k in mergeFields)` loop strips anything not in the allow-list before the PUT. **Adding a new merge field requires editing both the constant and the object construction** — a one-sided edit either silently sends nothing new (object change without constant change) or no-ops because the new field never gets set (constant change without object change). The triple-redundancy is intentional: anything sensitive (allergies, medical_notes, payment_details, waivers) MUST never reach Mailchimp, and we'd rather have a typo cause "missing field" than "PII leak." If a future contributor wants to add SCHOOL_ZIPCODE or similar, do it in three places: the constant, the object construction in the drain, and the modal's required-merge-fields checklist (which lives in `dk-mailchimp-ping`'s `REQUIRED_MERGE_FIELDS`).

**Mailchimp tags accumulate; old class/school tags don't get auto-removed (T12).** When a parent's child changes class, the next drain adds the new `class:<slug>` tag but leaves the old one in place. v1 accepts that — a parent who's been through three classes shows three `class:` tags, harmless for most segmentation queries. **Don't try to "fix" this by also POSTing the old tags as `status: inactive`** unless you're prepared to GET the existing tag list per parent + diff per drain run, which is one extra MC API call per row × 50 rows per minute. Fine for v2; not worth the cost in v1.

**Mailchimp webhook ALWAYS returns 200, even on lookup miss (T12).** This is intentional — MC retries non-2xx for hours and we don't want stuck queues for parents not yet in DK. The body is just `"ok"`. The actual error (if any) goes into `mailchimp_sync_log` with `direction='inbound'`. **Don't return 4xx for a missing student** — a parent who signed up via a Mailchimp form first (no DK student row yet) is normal flow, not an error. If you genuinely need to detect "rejected webhook events," query the log table for `direction='inbound' AND error IS NOT NULL`.

**Mailchimp webhook secret rotation invalidates the URL pasted into Mailchimp (T12).** Saving a different secret value to `dk_config.mailchimp_webhook_secret` (e.g. via raw SQL or a future "regenerate secret" button) breaks the URL Sharon pasted into Mailchimp. The webhook will start returning 401 until she re-pastes the new URL. The modal's "first save" only mints a new secret if one isn't already there — subsequent saves preserve the existing secret to avoid this trap. **If you ever add a "regenerate" button, surface a clear "you must update Mailchimp's webhook URL after this" warning** and bring the new URL up in a copy-modal flow before the old one stops working. Don't silently rotate.

**`leads.meta_lead_id` is UNIQUE and the webhook uses `ON CONFLICT DO NOTHING` (T15).** Meta retries the same leadgen webhook on non-2xx responses (or its own hiccups) and we always return 200, so duplicates *shouldn't* arrive — but if they do, the second insert is silently skipped and counted in `skipped`. **Don't change to `ON CONFLICT (meta_lead_id) DO UPDATE`** unless you also gate the UPDATE on `status = 'new'` — otherwise a Meta retry can clobber an admin's notes, status flips, or contacted/promoted audit stamps. The current shape is correct for the "first write wins" semantic the inbox depends on.

**`dk-meta-lead-webhook` always returns 200 on POST, even on validation/insert failure (T15).** Meta retries non-2xx for hours, and we don't want a stuck queue for one bad lead. Per-request `inserted`/`skipped`/`errors` counts go into the 200 body for log-time inspection; per-row failures land in `leads.last_fetch_error`. **Don't return 4xx/5xx for "couldn't fetch field_data"** — that's exactly the case where we want the row to land with `last_fetch_error` populated so the admin sees something arrived. The only 4xx paths are `403` on a verify-token mismatch (GET handshake) and `401` on an HMAC signature mismatch (POST) — both of those are real auth failures, not transient errors.

**Promotion is two steps by design: `promote_lead_to_student` THEN class assignment via the existing enrollments flow (T15).** The RPC inserts the student row + carries parent contact + marks the lead promoted, but does NOT add an enrollment. Meta forms don't pick a class, and the admin needs class context (term dates, school, capacity) that's already in the Classes tab. **Don't try to extend `promote_lead_to_student` to take a `class_id` parameter** — you'd either have to surface the entire class picker UI inside the promote modal (heavy, redundant with Classes tab) OR force the admin to pick blind (wrong UX). The two-step shape mirrors §4.28's T11 intake-then-enroll pattern.

**The reply modal's `{lead_*}` substitution piggybacks on `substitute()` from §4.5's template machinery (T15).** `leadVariableContext(lead)` returns `{lead_parent_name, lead_parent_first, lead_email, lead_phone, lead_child_name, lead_child_dob, lead_school}` — those keys feed directly into the same `substitute(body, filled)` helper that powers the Templates tab. Templates designed for class-context (with `{class_name}` / `{day_time}` / etc.) won't have those vars filled when used against a lead — the modal surfaces remaining `{placeholders}` in a yellow hint banner so admin can edit them by hand before send. **Don't add a "lead vs class" template-type discriminator** — let admins pick whichever template fits, and surface unfilled vars as a hint, not a blocker. A franchise that wants lead-specific templates can just create them in the Templates tab with `{lead_*}` placeholders.

**Vercel deploys from `github.com/jlyonsld/DK` `main`, but Edge Functions deploy via Supabase MCP independently (T12 + general).** A new Edge Function (drain / webhook / ping) goes live the moment `mcp__973b87c9...__deploy_edge_function` succeeds — there's no Vercel involvement, no `main` push, no ~30-second propagation. **The repo's `edge-functions/*.ts` files are the SOURCE that's reviewed in PRs**, but the live behavior depends on the deployed function version (visible in the Supabase dashboard). If you edit the .ts file without redeploying, the live function keeps the old behavior; if you redeploy without committing the .ts edit, the next contributor has no PR review trail. Always do BOTH: edit the file, deploy via MCP, then commit. T12 follows this convention — its three .ts files are colocated with the migrations in `response-console-v3/edge-functions/`.

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

- **Phase T6d — role management UI + explicit `profiles.teacher_id` link + returning-user invitation redemption.** ✅ **Shipped.** New admin-only **Users** tab lists every profile with a role-management modal that edits role + linked teacher + per-user grant/revoke lists in one save (the four T6d RPCs run only when their field changed, so a no-op save makes zero RPC calls). `profiles.teacher_id` FK with a unique partial index becomes the source of truth for "who's the signed-in teacher"; `mySignedInTeacher()` prefers the FK and falls back to the email match. `redeem_invitation_for(profile_id)` lets an admin manually redeem a pending `teacher_invitations` row against an existing profile, closing the gap left by `handle_new_user` only firing on first-sign-in. No new permission names — gated entirely on `is_admin_or_above()`. `set_profile_role()` refuses to demote the last super_admin. See `migrations/phase_t6d_role_management.sql` and §4.24.

- **Phase T9 — special events (free classes, trainings, promotional events) + multi-staff assignment.** ✅ **Shipped.** Two new tables (`events`, `event_staff`) and an `event_kind` enum (`free_class` / `training` / `promotional` / `other`). One new permission `edit_events` (super_admin/admin/manager) added to both SQL `has_permission()` and JS `PERM_BUNDLES`. SELECT on both tables is open to any signed-in user so the schedule renders events for everyone. New top-level **Events** tab (visible to every role) with kind + when filters and a card grid; the event editor modal handles all CRUD + inline staff assignment. `eventsForDate()` integrates with all three schedule views (Day spine, Week absolute blocks, Month rows) using a dashed left border + kind-color hue + ★ marker to distinguish events from classes at a glance. Click an event row anywhere → opens the editor. Out of scope for v1: attendance/RSVP, curriculum link, public RSVP page, closure interaction. See `migrations/phase_t9_events.sql` and §4.25.

- **Phase T7 — freemium upgrade prompt + conversion tracking.** Split into two slices.
  - **T7a (✅ shipped):** PAR card has five variants keyed off role × link state (`unlinked_admin` / `unlinked_teacher` / `linked_franchise_owner` / `linked_admin` / `linked_teacher`); every impression and click logs to the new append-only `par_promotion_events` table. Self-INSERT, admin-only SELECT. See `migrations/phase_t7a_par_promo_events.sql`, `T7A_VERIFICATION.md`, and §4.26.
  - **T7b (✅ shipped):** Usage-tier variants `unlinked_teacher_attendance_20` / `_50` (thresholds against unioned attendance + clock-in session counts), 7-day dismiss UX with optimistic local update, admin **PAR funnel** report (Reports-tab entry with summary cards + by-variant table + daily impressions sparkline + CSV export). One small migration (`phase_t7b_par_promo_dismiss.sql`) adds the `par_promo_events_self_read` policy that the dismiss check reads against. No new permission name. See `migrations/phase_t7b_par_promo_dismiss.sql`, `T7B_VERIFICATION.md`, and §4.26.

- **Phase T10 — physical inventory (props/costumes/supplies/equipment) + class/event assignments + conflict detection.** ✅ **Shipped.** Two new tables (`inventory_items`, `inventory_assignments`) with a polymorphic-target shape (assignment carries nullable `class_id` + nullable `event_id`, exactly-one-set check). One new permission `edit_inventory` (super_admin/admin/manager) added to both SQL `has_permission()` and JS `PERM_BUNDLES`. Public `inventory-photos` Storage bucket mirrors the `infographics` pattern. SELECT on both tables open to all signed-in users so the schedule + class detail + event editor can render assignments for everyone. New top-level **Inventory** tab with search + tag-filter chips + card grid (photo, location, tags, status, conflict badge, re-order link). Item editor modal handles CRUD + photo upload + an inline "Current & upcoming assignments" list with mark-returned/remove. Assign-picker modal opens from the class detail panel "📦 Assign inventory" button or the event editor's "+ Assign inventory…" button — multi-select with conflict warnings. Class detail panel surfaces an "Inventory for [date]:" chip row to all roles (teachers see what's been pulled). Conflict math is a timestamp-range overlap on `usage_starts_at` / `usage_ends_at` (materialized at write time from class session_date+times or event starts_at/ends_at). Out of scope for v1: quantity tracking, check-out/check-in workflow, barcode scanning, per-school scoping, home-bento integration. See `migrations/phase_t10_inventory.sql` and §4.27.

- **Phase T11 — student intake form (full PII fields + parent self-fill flow).** ✅ **Shipped.** Adds nine PII columns to `students` (allergies, medical_notes, photo_permission tri-state, emergency_contact_name/phone/relationship, school_name, grade, authorized_pickup) — parent contact arrays were already on the schema. New `student_intake_requests` table stores `sha256(token)` + class_id + parent_email + audit fields; raw token lives only in the URL emailed to the parent. Two Edge Functions: `dk-send-intake-form` (verify_jwt: true; admin gate via `has_permission('edit_students')` called under user-bound supabase-js client; emails via Resend with copy/paste fallback) and `dk-submit-intake-form` (verify_jwt: false; public; auth IS the token; atomically inserts student + enrollment + marks intake completed using service-role). New public page `student-intake.html` parallels `install.html`. Add Student modal expands with full intake fields + parents repeater + "📧 Send form to parent" shortcut. Class detail panel grows a "Pending parent forms" subsection above the enrollments list with Resend / Cancel actions, and enriches each enrolled-student row with parent name(s)/email/phone, emergency contact, and chips for `⚠ allergies`/`⚕ medical`/`📷 no photos`. No new permission name — reuses `edit_students`. `cancel_student_intake(uuid)` RPC powers the admin cancel surface. See `migrations/phase_t11_student_intake.sql`, `T11_VERIFICATION.md`, and §4.28.

- **Phase T12 — Mailchimp sync (one-way DK → MC + MC webhooks back).** ✅ **Code-complete, awaiting Sharon's API key + audience selection.** Adds `dk_config.mailchimp_*` columns + `students.marketing_status` + `mailchimp_sync_outbox` queue + `mailchimp_sync_log` audit. Two triggers (`students_mc_sync` on identity-relevant column updates + `enrollments_mc_sync` on any enrollment change) enqueue one row per `(student, parent_email)` pair. Three Edge Functions: `dk-mailchimp-drain` (verify_jwt: false, every 60s via pg_cron, reads cron secret from vault via the `get_mailchimp_drain_cron_secret()` RPC, no-ops gracefully if MC not configured); `mailchimp-webhook` (verify_jwt: false, public, auth via `?secret=` query param against `dk_config.mailchimp_webhook_secret`, always returns 200); `dk-mailchimp-ping` (verify_jwt: true, super_admin only, ping/list audiences/list+create merge fields). Allow-listed merge fields: FNAME, LNAME, STUDENT, CLASS, SCHOOL, STATUS — sensitive PII (allergies, medical_notes, payment_details, waivers) explicitly excluded by triple-redundant gates. Tags applied per parent: `dk-<status>`, `class:<slug>`, `school:<slug>`. New super_admin-only `⚙ Mailchimp` button on the Templates tab head opens the connect / webhook / merge-fields-checklist / sync-status-pill modal. No new permission name — `dk_config` writes already gate on `is_super_admin()`. See `migrations/phase_t12_mailchimp_sync.sql`, `T12_MAILCHIMP_SYNC.md` (original spec), and §4.29.

### Wave 1 leftovers (pre-freemium ops work)

- **FAQ page on the DK website.** Not started.
- **Jackrabbit email template rewrite.** Not started.
- **Meta → Mailchimp lead-intake automation.** ✅ **DK side shipped (T15) — awaiting Sharon's Meta App + env vars + the Mailchimp-side FB Lead Ads connector setup.** The DK side: `leads` staging table, `dk-meta-lead-webhook` Edge Function (HMAC-verified, idempotent via `meta_lead_id`), Leads inbox tab with reply (template machinery + lead-shaped vars) / promote (atomic RPC into `students`) / junk / archive. The MC side runs in parallel via Mailchimp's native FB Lead Ads connector (Sharon-side: Mailchimp → Integrations → Facebook → connect Page → map fields to merge tags → tag with `meta-lead`). The two paths are decoupled — a Meta submission lands as both a DK `leads` row AND an MC audience entry independently, with no DK ↔ MC handoff for that direction. This closes the "MC → DK student row" gap T12 left open without taking on email infrastructure. **Direction decided 2026-05-07.** See §4.31.

### Known rough edges

- **No sign-up page in the login UI.** First-time users must use the magic-link button (which auto-creates via Supabase OTP) or an admin pre-provisions them via the Supabase dashboard. There's no "click here to create an account" button.

- **Resend email sending is optional.** `dk-invite-teacher` calls Resend only if `RESEND_API_KEY` Edge secret is set AND `dk_config.sender_email` is populated. Otherwise it returns the accept URL and the UI modal prompts the admin to copy-paste into their own email client. Good fallback; could be tighter.

- **No error UI for unknown Edge Function failures on the Classes / Teachers / Templates tabs.** Supabase client errors bubble up to a toast; any un-toasted error shows only in the browser console. If you add a new mutation, ensure it `showToast(error.message, "error")` on failure.

- **Zoom ghost events + recurring-event exception diffs don't apply to DK** (that's a PAR-side concern for the calendar app). DK has no calendar integration beyond Jackrabbit.

- **Zoom/Apple/Outlook sync** — none. DK is not a calendar app.

- ~~**`install_nonces` and `closures` grow unbounded.**~~ Resolved by T14 (`nightly_housekeeping()` cron). See §4.30.

- **Teacher bento matches via email.** See §5. Fragile if a teacher has an alternate email on file; ignored case-insensitively in lookups.

- **The class `times` regex parser is strict.** See §5. Non-JR classes entered manually with unusual time formats may break the Week view (they'd silently not render blocks).

- **Single-class cancellations still go through `class_cancellations`, not closures.** Closures cancel a whole school's classes on a date; the per-class "Cancel class" button on the class detail panel is the right surface for one session no-showing. Don't paper over a per-class issue with a per-school closure — it'll dim every other class at that school for the day too. (T13 made closures per-school-aware; this rough edge no longer applies to multi-school franchises wanting "this whole district is off" — they pick the school in the closure modal.)

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
META_APP_SECRET                  # T15 — Meta App secret for HMAC verification
META_VERIFY_TOKEN                # T15 — shared token for Meta's GET handshake
META_PAGE_ACCESS_TOKEN           # T15 — long-lived Page token to fetch lead field_data
                                 #       (optional — if unset, leads land with last_fetch_error)
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
| T6d — Role management UI + profiles.teacher_id + returning-user invitation redemption | ✅ Shipped |
| T9 — Special events (free classes, trainings, promotional events) + multi-staff assignment | ✅ Shipped |
| T7a — PAR promotion variant copy + impression/click logging | ✅ Shipped |
| T10 — Inventory items + class/event assignments + conflict detection | ✅ Shipped |
| T11 — Student intake (PII columns + parent self-fill enrollment form) | ✅ Shipped |
| T7b — Usage-tier variants (≥20 / ≥50 sessions) + dismiss UX + admin PAR-funnel report | ✅ Shipped |
| T13 — Per-school closures (nullable closures.school_id, scoped vs. global rendering) | ✅ Shipped |
| T12 — Mailchimp sync (per-franchise audience, outbox queue, drain + webhook + ping Edge Functions, settings modal) | ✅ Code-complete, awaiting Sharon's API key + audience selection |
| T12b — Mailchimp roster backfill button (`enqueue_mailchimp_backfill()` RPC + super_admin "Resync all students" button) | ✅ Shipped |
| T14 — Nightly housekeeping (`nightly_housekeeping()` + pg_cron job purging install_nonces > 30d, closures > 90d, terminal intake_requests > 90d) | ✅ Shipped |
| T15 — Meta Lead Ads inbox (DK side: leads staging table + dk-meta-lead-webhook Edge Function + Leads tab with reply / promote / junk / archive) | ✅ DK side shipped, awaiting Sharon's Meta App + env vars + Mailchimp's native FB Lead Ads connector |
| T16 — Messenger / Instagram inbox (two-way conversations from FB Messenger and IG DMs, templated composer, infographic attach, promote-to-student parity with T15) | 📋 Designed (CLAUDE.md §4.32). Not built — gated on Meta App Review for `pages_messaging` (and `instagram_manage_messages` for IG). **App Review is App-ID-scoped, NOT Page-scoped — one PAR DK Meta App reviewed ONCE serves every franchise**, who each connect their own Page via in-app OAuth (~30s) instead of needing per-franchise reviews. Phase split: T16a = receive-only inbox + OAuth flow + T15.5 token-migration (no write scopes needed), T16b = send path + composer (needs App Review), T16c = Instagram parity. |
