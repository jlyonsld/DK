# DK Leads flow — streamlined

## The old flow (manual)

```
Meta Lead Ad ─→ Google Sheet ─→ (Sharon exports + uploads) ─→ Mailchimp ─→ (Sharon replies in MC)
                                                                              └─ no record of who was answered
```

Three manual steps and no tracking of who's been responded to.

## The new flow (automated)

```
Meta Lead Ad ─→ Google Sheet ─→ [Apps Script, every 5 min] ─→ dk-lead-intake ─┬─→ DK Leads inbox  ─→ Sharon replies w/ template
                                                                              │     (auto-marked "Contacted" on reply)
                                                                              └─→ Mailchimp (tag: dk-lead)  ─→ nurture campaigns
```

Sharon does nothing but answer leads from the DK **Leads** tab. The Google Sheet
stays as the Meta intake (no Meta App Review needed) but becomes invisible plumbing.

## What's deployed (live on DK Supabase `ybolygqdbjqowfoqvnsz`)

- **`dk-lead-intake`** Edge Function (`verify_jwt=false`, auth = `X-Lead-Secret`
  header vs vault `lead_intake_secret`). Idempotent on `leads.meta_lead_id`.
  Inserts the lead (`source='sheet_bridge'`) and best-effort upserts the parent
  into Mailchimp (merge fields FNAME/LNAME/STUDENT/SCHOOL/STATUS=lead, tags
  `dk-lead` + `school:<slug>`). A Mailchimp failure is logged to
  `mailchimp_sync_log` and never blocks the lead landing in the inbox.
- **`get_lead_intake_secret()`** RPC (service-role only) — lets the function read
  the shared secret from vault, so there's no out-of-band env var to set.
- The **Leads inbox** (T15) was already shipped in `app.js` — inbox with
  status filters + search, a reply modal that fills response templates with the
  lead's name/child/school, Promote-to-student, and the **auto check-off**:
  hitting reply calls `mark_lead_contacted`, flipping the lead `new → Contacted`.

## Sharon-side setup (one time)

### 1. Wire the Sheet (replaces the manual MC upload)
- Open the Google Sheet Meta writes leads into → **Extensions → Apps Script**.
- Paste `leads-sheet-bridge.gs` (in this folder). Set `SHEET_NAME` to the tab and
  glance at `HEADER_MATCHERS` (they match column headers loosely — usually no edit).
- Run `installTrigger` once (approve permissions), then `syncNow` once to pull in
  any existing rows. From then on it auto-forwards new rows every 5 minutes and
  stamps a **"DK Synced"** column so nothing is sent twice.

### 2. Respond from DK
- Leads now appear under the **Leads** tab. Open one → **Reply** → pick a
  template → Copy or send via your mail client. The lead flips to **Contacted**
  automatically — that's the check-off.
- When a lead enrolls, hit **Promote** to turn it into a student (which then
  syncs to Mailchimp as `dk-active` via the existing student sync).

### 3. Mailchimp nurture (unchanged for Sharon)
- Leads now arrive in the audience automatically, tagged **`dk-lead`**. Point any
  existing/lead nurture automation at the `dk-lead` tag. No more CSV exports.
- Note: the bridge uses your `dk_config` opt-in setting (currently auto-subscribe).
  If a lead form didn't include email-marketing consent, set
  `dk_config.mailchimp_double_opt_in = true` so MC sends its own confirmation.

## Test plan (do once after setup)

1. Submit a test lead via Meta's Lead Ads Testing Tool (or add a row to the Sheet).
2. Within ~5 min it appears in the DK **Leads** tab as **New**.
3. Confirm it's in Mailchimp tagged `dk-lead` (check `mailchimp_sync_log` for an
   `event='lead_upsert'` row with `status=200`).
4. Reply to it in DK → it flips to **Contacted** with a timestamp.
5. Promote it → a student row is created and syncs to MC as `dk-active`.

## Later: cut over to direct Meta → DK (retire the Sheet)

The direct path (`dk-meta-lead-webhook`, already deployed) removes the Sheet hop
entirely but needs Meta approval first. Run this track in parallel:

1. Complete **Meta Business Verification** (pending as of 2026-05-23) and submit
   the DK Meta app for **App Review** of `leads_retrieval` (+ `pages_show_list`,
   `pages_read_engagement`). Screencast + privacy policy URL required.
2. Set the function's env vars on DK Supabase: `META_APP_SECRET`,
   `META_VERIFY_TOKEN`, `META_PAGE_ACCESS_TOKEN`.
3. Subscribe the Page: `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen`.
4. Verify a real lead lands via the webhook (`source='meta_lead_ad'`).
5. Turn off the Apps Script trigger (`ScriptApp` → delete the `syncNow` trigger).
   Everything downstream — inbox, reply, check-off, MC nurture — is identical;
   only the intake hop changes.

Best batched with the **T16 Messenger/Instagram** App Review and the **PAR Spoke
Skeleton** Meta-app model (one reviewed Meta app for all spokes) — see CLAUDE.md
§4.31/§4.32.
