# Deploying Foreman to Vercel

Repo: <https://github.com/ezazahamad2003/calendar-app> (branch `main`)

## 1. Import the repo (do this in the dashboard)

Vercel → **Add New → Project → Import Git Repository → `calendar-app`**.

Framework detection picks up Next.js on its own; leave the build settings alone.
Do not use a direct file upload — importing from git is what gets you automatic
deploys on push and preview deployments per branch.

## 2. Environment variables

Set these under **Settings → Environment Variables** before the first deploy.
The build inlines `NEXT_PUBLIC_*` at build time, and `src/instrumentation.ts`
validates the rest at boot, so a deploy with these missing fails rather than
starting up broken.

### Required now (Phase 2)

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://<your-project>.vercel.app` | **Must change from localhost.** Magic links and email confirmations are built from this. |
| `NEXT_PUBLIC_SUPABASE_URL` | same as local | Public by design. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | same as local | Public by design; RLS is what protects the data. |
| `TOKEN_ENCRYPTION_KEY` | same as local | Secret. |
| `CRON_SECRET` | same as local | Secret. |

Leave `NODE_ENV` alone — Vercel sets it.

### Deliberately *not* set yet

Fewer secrets in more places is worse, so hold these until the phase that needs
them:

| Variable | Add at | Why not now |
|---|---|---|
| `SUPABASE_SECRET_KEY` | when `createAdminClient()` is first imported | Nothing imports it today. Onboarding goes through the `create_org_with_owner()` RPC, so no code path needs the secret key. |
| `DATABASE_URL`, `DIRECT_URL` | never, probably | Only migrations use them, and those run from your machine. The app talks to Supabase over HTTP via PostgREST and holds no Postgres connections. |
| `OPENAI_API_KEY` | Phase 5 | Voice pipeline isn't built. |
| `MS_*` | Phase 7 | Graph isn't wired. |

## 3. Point Supabase Auth at the deployed URL

**This is the step that is easy to miss and breaks sign-in in a way that looks
like a bug in the app.** Supabase only redirects to URLs on its allow-list; the
`emailRedirectTo` the code sends is ignored otherwise, and users land back on
`localhost:3000` from their email.

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL** → `https://<your-project>.vercel.app`
- **Redirect URLs** → add both:
  - `https://<your-project>.vercel.app/auth/callback`
  - `https://*-<your-team>.vercel.app/auth/callback` (preview deployments)

Keep `http://localhost:3000/auth/callback` in the list so local dev keeps working.

## 4. Email confirmation

Supabase ships with "Confirm email" on. With it on, signup stops at *"check your
email"* until the user clicks the link — which is correct behaviour, but means
the register → org → dashboard flow can't be completed without inbox access.

Turn it off under **Authentication → Sign In / Providers → Email** while
developing, and turn it back on before real users.

## 5. Redeploying after env changes

Environment variables are read at build time for `NEXT_PUBLIC_*` and at boot for
the rest. Changing either requires a **redeploy**, not just a restart — Vercel
does not retroactively apply them to an existing deployment.

## Known gap

The prototype API routes under `src/app/api/` still ship in the build. They
write to the local filesystem via `src/lib/schedule-store.ts`, which is
read-only on Vercel, so every one of them 500s if called. They are unreachable
from the UI (nothing links to them) and are removed in Phase 3. They also read
`OPENAI_TTS_MODEL` and `OPENAI_TTS_VOICE`, which are not declared in
`.env.example` or `src/lib/env.ts`.
