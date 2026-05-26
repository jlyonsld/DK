# DK console → Roster (system of record) integration

Roster is now the system of record for DK's **classes, students, and enrollments**.
The DK console reads them through a server-side proxy so Roster's API key never
touches the browser:

```
DK console (browser, authed DK user)
   └─ supabase.functions.invoke("dk-roster", { resource })   [DK project]
        └─ dk-roster edge fn  (holds ROSTER_API_KEY)
             └─ Roster roster-api  (org-scoped to DK)        [Roster project]
                  └─ { data: [...] }
```

## Status
- ✅ `dk-roster` edge fn deployed to the DK project (`ybolygqdbjqowfoqvnsz`), `verify_jwt=true`. **Dormant** until `ROSTER_API_KEY` is set — returns `roster_not_configured`.
- ✅ Roster's `roster-api` read endpoint is live and was tested end-to-end returning DK's real classes.
- ✅ `roster-client.js` — drop-in browser client (`window.Roster`).
- ⏳ **You: mint the key + set the secret** (below), then wire a view in the console.

## Steps to turn it on

1. **Mint a Roster API key for DK** — on the **ROSTER** project (`yhcacngcxpoblofstjpj`), run (so the raw key only appears in your session, never in chat):
   ```sql
   select mint_roster_api_key('dk-console', '7dd0c748-b0d3-41af-80b9-752a836172e5');
   ```
   Copy the returned raw key (shown once).

2. **Set it as a secret on the DK project:**
   ```bash
   supabase secrets set ROSTER_API_KEY='<raw key from step 1>' --project-ref ybolygqdbjqowfoqvnsz
   ```
   (Optional: `ROSTER_API_URL` override; defaults to Roster's roster-api URL.) Takes effect immediately — no redeploy.

3. **Wire it into the console.** Include `roster-client.js` after your Supabase client is created, init it, and call it where you want Roster-backed data:
   ```html
   <script src="roster-client.js"></script>
   <script>
     Roster.init(supabase);                 // your DK Supabase client
     const classes = await Roster.classes(); // live from Roster
   </script>
   ```

## API (`window.Roster`)
- `Roster.classes()` → `[{ id, name, status, session_length, programs:{name,program_type,default_price_cents}, enrollments:[{count}] }]`
- `Roster.students()` → `[{ id, first_name, last_name, status, families:{name} }]`
- `Roster.enrollments()` → `[{ id, status, enrolled_on, dropped_on, student_id, offering_id }]`
- `Roster.roster(offeringId)` → `[{ status, students:{first_name,last_name} }]`

All read-only and org-scoped to DK. Writes (add class, enroll, etc.) stay in the
Roster app for now — the DK console keeps its own DK-specific layer (curriculum,
templates, infographics, teacher/personnel, engagements).

## Recommended migration path
This is the **read bridge**. To make Roster the full system of record:
1. Start by rendering a read-only "Classes (from Roster)" panel using `Roster.classes()` — proves the loop in the live console with zero risk to existing data.
2. Migrate any DK views that currently read a Jackrabbit mirror to read from `Roster.*` instead, one view at a time.
3. Retire the JR-mirror tables/sync once nothing reads them.
4. Later: add Roster *write* endpoints (or a `dk-roster` write proxy) so the console can create/enroll through Roster too.
