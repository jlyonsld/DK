# T24 — Per-class semester calendars (verification)

Per-class semester calendar (the printed "20XX <Season> CALENDAR" parents
get), available from **both** the admin console and a public parent page, and
downloadable as a branded PDF that mirrors the reference design.

## What shipped

| Piece | Where |
|---|---|
| Schema + RLS + parent-read RPC + branding columns + default pointers seed | `migrations/phase_t24_semester_calendars.sql` |
| Calendar engine (meeting-date math, HTML preview, branded PDF via jsPDF) | `calendar-core.js` (global `window.DKCalendar`) |
| Light "paper" preview styles (shared admin + parent) | `calendar.css` |
| Admin Schedule Manager (Programs → **Calendars** tab) | `app.js` `renderCalendarsTab()` + editor/modals |
| Public parent page (no login) | `class-calendar.html` |
| Studio branding editor | Settings → **Studio branding** card + modal |
| Per-class deep link | "📅 Calendar" button on the class detail panel |

## 1. Apply the migration

Apply `migrations/phase_t24_semester_calendars.sql` (Supabase SQL editor or
`apply_migration`). Idempotent — safe to re-run. It creates `semesters`,
`class_meeting_patterns`, `schedule_exceptions`, `parent_pointers`; adds
`dk_config` branding columns; creates the `get_class_calendar(uuid,uuid)`
security-definer RPC (granted to `anon, authenticated`); and seeds a default
Parent Pointers template (`class_id IS NULL`).

Spot checks:
```sql
select count(*) from parent_pointers where class_id is null;   -- 8 (default set)
select proname from pg_proc where proname = 'get_class_calendar'; -- 1 row
```

## 2. Admin — build a calendar

1. Sign in as super_admin/admin/manager → **Programs → Calendars**.
2. Click **＋** → create a semester ("2025 Fall", Fall, Sept 1 → Dec 19).
3. Pick a class. In the editor: check the meeting weekday(s), set start/end
   time, optional location/room/teacher → **Save schedule**.
4. Add a holiday (No class) and a Makeup date under **Holidays & makeups**.
   Scope = "This class" or "All classes".
5. **📝 Pointers** → customize per-class, or edit the studio default. Save.
6. The right-hand **preview** updates live and matches the PDF.
7. **⬇ PDF** downloads a branded multi-month PDF + Parent Pointers page.
8. **Publish** the semester, then **🔗 Parent link** to copy the share URL.

Expected: meeting weekdays are red-circled; the holiday date is NOT circled;
the makeup date is a filled red circle. Months span the semester (Sept–Dec
→ 4 grids).

## 3. Parent — view + download (no login)

Open the copied link: `/class-calendar.html?class=<id>&semester=<id>`.
- Renders the same calendar + Parent Pointers.
- Semester selector appears if the class has >1 published semester.
- **⬇ Download PDF** produces the identical branded PDF.
- An **unpublished** semester returns "No calendar published yet"; an
  unknown class returns a friendly error (never a crash).

## 4. Branding

Settings → **Studio branding** (admin+): studio name, owner, phone, email,
website, socials, address, logo URL, header color, meeting-day color. Saves
to `dk_config`; flows into the preview, the PDF, and the parent page.

## 5. Security checks

- `get_class_calendar` only returns **published** semesters — anon cannot
  read drafts.
- anon never gets table SELECT; all parent reads go through the RPC.
- Writes to all four tables require `has_permission('edit_classes')` (manager+).

## Verified during build (static server)

- Engine math: 15 meeting days for Wed Sep 1–Dec 19 minus Thanksgiving plus a
  makeup, 4 month grids, makeup flagged. ✓
- Preview visually matches the reference (header, red "FALL CALENDAR", legend,
  circled Wednesdays, footer). ✓
- PDF generates (~220 KB; logo downscaled before embedding). ✓
- Public page loads and degrades gracefully when the RPC is absent. ✓

## Notes / deliberate scope

- Meeting-date math lives only in `calendar-core.js` (one source of truth for
  preview + PDF + parent page) — the RPC returns raw patterns/exceptions and
  the JS computes dates, so SQL never parses recurrence.
- One shared `model` shape is produced by `buildCalendarModel()` (admin, from
  tables) and `get_class_calendar` (parent, from RPC) so the two can't drift.
- Edge Functions: none added. jsPDF is lazy-loaded from CDN only when a PDF is
  generated.
