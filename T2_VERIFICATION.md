# Phase T2 — Teacher invitations verification & next steps

## What's shipped

| Layer | What | Status |
| --- | --- | --- |
| DB schema | `teacher_invitations` + `dk_config` tables, RLS, realtime | ✓ migrated |
| Trigger | `handle_new_user` extended to auto-redeem pending invitations on first sign-in | ✓ |
| Edge Function | `dk-invite-teacher` (calls PAR's `spoke-create-org-invitation`, persists DK row, optionally emails via Resend) | ✓ deployed v1, ACTIVE |
| UI | "Invite" / "Re-invite" / "Copy link" button per teacher row, status badges, copy-link result modal | ✓ in `app.js` / `index.html` / `styles.css` |
| Realtime | `teacher_invitations` + `dk_config` watched by the console | ✓ |

## What you (Jason) and Sharon need to do — three manual steps

These cannot be done from this side. T2 ships *code-complete* but won't actually issue an invitation until all three are done.

### 1. Sharon creates a PAR account
- Go to https://get-on-par.com/
- Sign up with the email she'll use for ops (probably the same one that's on her existing Drama Kids accounts)

### 2. Sharon creates her franchise org on PAR
- Inside PAR, create a new org (probably "Drama Kids — Charleston" or similar)
- Sharon should be the **owner** of this org

### 3. Capture the org_id and write it to `dk_config`
After Sharon creates the org, get the `org_id`. Two ways:

**Easiest:** ask PAR to query and send back. Or:

```sql
-- Run against PAR's project (dzcmfiahnxxqqeheimis)
select id, name, owner_id, created_at
from public.organizations
where name ilike '%drama%'
order by created_at desc;
```

Then update DK's config singleton:

```sql
-- Run against DK's project (ybolygqdbjqowfoqvnsz)
update public.dk_config
set par_franchise_org_id = '<the-uuid-from-PAR>',
    sender_name = 'Sharon at Drama Kids',  -- optional override
    sender_email = NULL,                    -- leave NULL unless email-sending is set up
    updated_at = now()
where id = 1;
```

Once `par_franchise_org_id` is set, the invite button will start working end-to-end. Until then, clicking Invite returns a 409 with a clear "Franchise PAR org_id not yet configured" message.

## Optional: enable email sending via Resend

If you want invitation emails to actually be delivered (vs Sharon copy-pasting the URL each time):

1. Sign up at https://resend.com (free tier: 100 emails/day, 3000/mo)
2. Verify a sender domain (or use Resend's `onboarding@resend.dev` for testing)
3. Set the API key as an Edge secret on DK's Supabase project:
   - Dashboard → Edge Functions → Settings → Add `RESEND_API_KEY=<your_key>`
4. Update `dk_config.sender_email` to whatever address Resend's verified domain accepts:
   ```sql
   update public.dk_config
   set sender_email = 'sharon@your-verified-domain.com'
   where id = 1;
   ```

If `RESEND_API_KEY` is unset OR `sender_email` is NULL, the Edge Function gracefully degrades: it still returns the `accept_url`, the modal shows "Email not sent — copy the link below," and Sharon can email it manually from her own client.

## How to test once org_id is wired

1. Hard-reload the deployed console
2. On the Teachers tab, find a teacher with an email that's NOT already PAR-linked
3. Click **Invite** in the action column
4. The result modal pops up with the accept URL
5. The teacher row gets an "INVITED" badge
6. (Optional, if email enabled) Resend dashboard shows a delivered email to that address

To test the acceptance side without involving a real third party, use a private email address:
- Send the invitation to one of your own emails
- Click the URL → completes the PAR sign-in/sign-up flow → returns
- Open the DK console at the deployed URL while signed-in to that PAR session
- The teacher row's badge flips from "INVITED" to "ACCEPTED"
- The new auth user lands as a fresh DK profile — `handle_new_user` redeems the invite, sets `role='teacher'`, marks `accepted_at`

Spot-check in SQL:

```sql
select email, dk_role, sent_at, accepted_at, email_status
from public.teacher_invitations
order by sent_at desc;
```

## Known limits / what's deferred

- **Acceptance only fires on a brand-new sign-up.** If the invitee already had a DK account before the invite, `handle_new_user` doesn't re-fire on subsequent sign-ins. T6 will add an explicit "Redeem pending invitation" RPC for this edge case. Rare in practice for v1.
- **No re-invite flow yet.** If an invitation expires, clicking "Re-invite" creates a fresh invitation row but doesn't archive the old one. Still works, just leaves orphans in `teacher_invitations`. Cleanup is a Phase T6 polish item.
- **Email status is a snapshot.** If Resend later bounces a delivered email, DK won't know. For v1 the modal lets Sharon copy-paste as a fallback.
- **`profiles.teacher_id` link is implicit.** When a teacher invitation has `teacher_id` set, `handle_new_user` ensures that teacher row's email matches; but it doesn't write a `profiles.teacher_id` column (none exists yet). Phase T6 adds that explicit link.
