# Phase T7a — Verification

> Foundation slice for freemium-conversion tracking. Logs every
> impression / click of the home-bento PAR card to
> `par_promotion_events` so T7b's smart-trigger work has data to
> calibrate against.

---

## 0. Apply the migration

Apply `migrations/phase_t7a_par_promo_events.sql` to the DK Supabase
project (`ybolygqdbjqowfoqvnsz`) via the MCP `apply_migration` or the
Supabase dashboard SQL editor. It's idempotent — safe to re-run.

Sanity-check schema:

```sql
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'par_promotion_events'
 order by ordinal_position;

select polname, cmd
  from pg_policy
 where polrelid = 'public.par_promotion_events'::regclass
 order by polname;
```

Expected: 7 columns; 2 policies (`par_promo_events_self_insert` for
INSERT, `par_promo_events_admin_read` for SELECT). No UPDATE/DELETE
policies.

## 1. Variant resolution per role × link state

Sign in as each user below and confirm the home-bento "On PAR" card
renders with the expected variant. Inspect the `<a class="par-user">`
element in DevTools — the `data-par-variant` attribute is the variant
key that gets logged.

| Sign-in identity | Expected `data-par-variant` | Expected copy |
|---|---|---|
| super_admin, PAR-linked (Sharon, owner of franchise org) | `linked_franchise_owner` | 👤 + display name + → |
| admin, PAR-linked | `linked_admin` | 👤 + display name + → |
| manager, PAR-linked | `linked_admin` | 👤 + display name + → |
| teacher, PAR-linked | `linked_teacher` | 👤 + display name + "Try the family planner" |
| Any admin/manager/super_admin, NOT PAR-linked | `unlinked_admin` | 🔗 "Connect to PAR" |
| Teacher, NOT PAR-linked | `unlinked_teacher` | 🔗 "Link DK to PAR" + "Try the family planner" |

Notes:
- Teachers with no `teachers` row see the small fallback PAR card on
  their welcome state; same variant logic applies (it's rendered by
  `renderParBridgeCard()` regardless of teacher-row presence).
- Viewers and null-role profiles fold into `linked_admin` /
  `unlinked_admin` (no separate variant). They don't see the home
  bento very often, but the card handles them gracefully if they do.

## 2. Impression logging — once per session

Sign in as any role with a PAR-linked profile.

```sql
-- Run as super_admin / admin (RLS gates SELECT to is_admin_or_above)
select variant_key, event_kind, count(*) as n, max(created_at) as last_at
  from par_promotion_events
 where profile_id = '<your-profile-id>'
   and created_at > now() - interval '1 hour'
 group by 1, 2
 order by 1, 2;
```

Expected:
- Exactly **one** `impression` row for the variant the user actually
  saw on this session.
- Trigger a re-render (e.g. switch to Schedule and back to Home, or
  edit a class so realtime fires `reloadAll`) — impression count
  should stay at **1**. The dedup is keyed on `state._parPromoImpressions`,
  cleared only on full page reload.
- Reload the page → re-sign-in not required → impression row count
  should now be **2** (one per session).

## 3. Click logging — every click counts

From the home tab, click the PAR card once. Run the same query above.

Expected:
- New `click` row with the same `variant_key` as the impression.
- Click again → second `click` row. Clicks are NOT deduped (we want to
  count repeat clicks as repeat intent signals).
- The `click` row's `created_at` must be ≥ the impression's. If it
  isn't, the dedup or render order is broken.

The new tab to PAR opens in parallel with the INSERT — verify both:

1. Network tab: a `POST .../rest/v1/par_promotion_events` request
   fires synchronously on click.
2. New tab navigates to the variant's `href` (linked → `https://get-on-par.com/`,
   unlinked → `https://get-on-par.com/?view=settings&tab=linked-accounts`).

If the new tab fails to open but the POST fires, that's a popup
blocker — not a T7a regression.

## 4. RLS spot-checks

### Self-INSERT can't impersonate another profile

Sign in as a teacher. Open DevTools console:

```js
const otherProfileId = "00000000-0000-0000-0000-000000000000"; // any other profile
await sb.from("par_promotion_events").insert({
  profile_id: otherProfileId,
  variant_key: "linked_teacher",
  event_kind: "click"
});
```

Expected: `error.message` contains "row violates row-level security
policy" (or PostgREST's equivalent — the `with check (profile_id =
auth.uid())` rejects).

### SELECT denied to non-admins

As a teacher in DevTools console:

```js
const { data, error } = await sb.from("par_promotion_events").select("id").limit(1);
console.log({ data, error });
```

Expected: `data` is an empty array (no rows visible), no error. The
`par_promo_events_admin_read` policy denies the SELECT silently —
PostgREST returns 200 with `[]`, which is the standard RLS denial
shape.

As a super_admin or admin in the same console:
- `data` returns rows (your own + everyone else's).

### Append-only

```js
// As any user — there's no UPDATE/DELETE policy at all.
const { error } = await sb
  .from("par_promotion_events")
  .update({ event_kind: "dismiss" })
  .eq("profile_id", "<your-profile-id>");
console.log(error);
```

Expected: silent no-op (zero rows updated) — RLS denies UPDATE because
no permissive policy matches. Same for DELETE. The POSTREST response is
not an explicit error; `data: []` and 0 affected rows is the success
signal.

## 5. Funnel-sanity query (admin)

After a few minutes of mixed traffic across roles, this query gives a
crude impression/click conversion per variant:

```sql
select variant_key,
       count(*) filter (where event_kind = 'impression') as impressions,
       count(*) filter (where event_kind = 'click')      as clicks,
       round(100.0 * count(*) filter (where event_kind = 'click')
                   / nullif(count(*) filter (where event_kind = 'impression'), 0), 1) as ctr_pct
  from par_promotion_events
 where created_at > now() - interval '7 days'
 group by 1
 order by impressions desc;
```

You're not yet looking for a target CTR — T7b's smart-trigger work
will calibrate that. The point is: rows exist, both kinds, across
multiple variants.

## What's intentionally NOT in T7a

- **Usage-based triggers** ("you've taken attendance 20 times…"). Lands
  in T7b. The schema already supports it via `metadata` jsonb — new
  variant keys (`unlinked_teacher_usage_attendance_20` etc.) just
  start appearing in resolveParVariant.
- **Dismiss UX**. The enum already includes `dismiss` so a future
  "× hide for a week" affordance can use the same surface. Not wired
  in v1.
- **Admin-side funnel dashboard**. T7b can render aggregates against
  the already-collected data — read-only SQL today, in-app card later.
- **Per-impression metadata**. We log `metadata: {}` for every event
  in v1. T7b can start carrying threshold values, copy-test ids, etc.
