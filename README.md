# Drama Kids Response Console — v3 (Supabase-backed)

Cloud-backed version of the response console. Multi-device, no file editing, no localStorage friction. Login-gated.

---

## Folder contents

```
response-console-v3/
├── index.html    ← structure
├── styles.css    ← styling
├── app.js        ← app logic + Supabase client
├── config.js     ← Supabase URL + publishable key (safe to expose)
├── logo.png      ← Drama Kids logo (you add this — drop the PNG here)
└── README.md
```

No `templates.js` / `classes.js` / `infographics.js` anymore — that data now lives in the Supabase database.

---

## Your credentials

**URL (once deployed):** will be something like `https://dk-response-console.vercel.app` (see deployment steps below)

**Supabase project:** `dk-response-console` · [dashboard](https://supabase.com/dashboard/project/ybolygqdbjqowfoqvnsz)

**Login — initial admin:**
- Email: `jlyonsld@gmail.com`
- Temp password: `DramaKids2026!`
- **Change the password immediately on first login.** Use the Supabase dashboard → Auth → Users → click your row → "Send recovery email" (or update password directly). A self-serve password-change UI is a follow-up build.

---

## Deploy steps (pick one)

### Option A — Drag & drop (easiest, no CLI)

1. Go to [vercel.com/new](https://vercel.com/new) (signed in).
2. Scroll to the bottom and click **"Deploy a template"** → **"Deploy without a repository"** — or on the main page, look for "Upload folder".
3. Drag the entire `response-console-v3` folder into the drop zone.
4. Name the project `dk-response-console`. Leave framework preset as "Other". No build command, no output directory.
5. Deploy. You'll get a URL like `dk-response-console.vercel.app` within a minute.

### Option B — Vercel CLI

From your terminal:

```bash
cd "DK Optimization/response-console-v3"
npm i -g vercel              # one-time
vercel deploy --prod          # first run asks you to log in via browser
```

It'll remember the project in `.vercel/project.json` — subsequent deploys are just `vercel deploy --prod`.

### Option C — Git-backed (recommended long-term)

If you want continuous deploys whenever we change code:

1. Create a repo (GitHub / GitLab / Bitbucket), push this folder to it.
2. On vercel.com, click **New Project** → import the repo.
3. Every push to `main` triggers a new deploy.

We can set this up later when the churn slows down.

---

## How to use it (the 30-second version)

1. Open your deployed URL in a browser. Bookmark it.
2. Log in with your email and password.
3. You land on **Templates**. Click any card → personalize → copy.
4. Use **Classes** to add your real classes (replaces the example seed data). Once real classes are in, the class dropdown inside templates auto-fills `{class_name}`, `{day_time}`, `{location}`, `{registration_link}`.
5. Use **Infographics** to upload real image files (PNG / JPG / GIF / WebP / SVG, up to 5 MB). These show up in the left sidebar — click a thumbnail to copy the image to your clipboard, paste straight into Messenger.
6. Use **Categories** to rename or add the buckets (FAQ, Camps, etc.).

Changes save **instantly** to the cloud. No save button, no export.

---

## Branding

Save the Drama Kids logo as `logo.png` in this folder. It shows up in the login screen and header automatically. Text-only fallback if missing.

---

## Inviting Sharon (and teachers later)

For now, only `jlyonsld@gmail.com` has access. To add Sharon:

1. Go to the [Supabase Auth dashboard](https://supabase.com/dashboard/project/ybolygqdbjqowfoqvnsz/auth/users).
2. Click **Invite user** → enter Sharon's email. She'll get a signup link via email.
3. After she signs up, go to **SQL Editor** and run:
   ```sql
   update public.profiles
   set role = 'admin', full_name = 'Sharon'
   where id = (select id from auth.users where email = 'sharon@…');
   ```
4. She can now log in at the deployed URL.

By default new signups get `role = null` — **no access until an admin grants them a role**. This is intentional: it means nobody can self-grant admin even if they somehow create an account.

For teachers in the future, use `role = 'teacher'` instead of `'admin'`. Teacher permissions are placeholder-only right now (read-only on classes & templates) — we'll build the teacher UI when that's a priority.

---

## Architecture notes (for when we build the next tools)

- **Tables:** `profiles` (linked to `auth.users`), `categories`, `templates`, `classes`, `infographics`.
- **Storage bucket:** `infographics` (public-read, admin-write).
- **RLS policies** enforce admin-only writes on every table and the storage bucket. The publishable key in `config.js` can't bypass them.
- **`is_admin()`** helper function (SECURITY DEFINER) drives the policies — queries `profiles` without recursing through RLS.
- **Auto-profile trigger:** every new `auth.users` row auto-creates a matching `profiles` row with `role = null` (safer default than auto-admin).

The portability principle holds: everything's a Postgres row. Dump to CSV / JSON at any time. When the future unified DK system comes, the import is straightforward.

---

## What's next on the roadmap

Wave 1 (remaining):
- FAQ page for the DK website (cuts Messenger inbound via better auto-reply)
- Jackrabbit email template rewrite (port copy from here into JR's template editor)
- Meta → Mailchimp lead pipeline (stop the manual re-keying)

Wave 2:
- Non-payment 3-step sequence (day 0 / 7 / 14) as automated Mailchimp journeys
- Contracted-class roster intake
- Retention automations

With the backbone in place, each of these is a new table/view on top of the existing schema — not a from-scratch rebuild.

---

## Rollback

The v2 console is still at `../response-console/` if you need to go back to the file-based version. Same domain of data just frozen as a v2 snapshot.
