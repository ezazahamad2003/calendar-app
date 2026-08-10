# Deploying Foreman

- Repo: <https://github.com/ezazahamad2003/calendar-app> (`main`)
- Production: <https://calendar-app-nine-brown.vercel.app>
- Supabase project: `iksrtkijgsemqhixgtoz` (ca-central-1)

Vercel redeploys on every push to `main`.

---

## 1. Vercel environment variables

**Settings → Environment Variables.** `NEXT_PUBLIC_*` is inlined at build time
and the rest is validated at boot by `src/instrumentation.ts`, so a missing
value fails the deploy rather than starting up broken.

| Variable | Production value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://calendar-app-nine-brown.vercel.app` |
| `NEXT_PUBLIC_SUPABASE_URL` | same as local |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | same as local |
| `TOKEN_ENCRYPTION_KEY` | same as local (secret) |
| `CRON_SECRET` | same as local (secret) |

> **No trailing slash on `NEXT_PUBLIC_APP_URL`.** It is concatenated with
> `/auth/callback`, and a double slash will not match Supabase's allow-list.

Do not set `NODE_ENV`, `VERCEL_ENV` or `VERCEL_URL` — the platform provides all
three.

### Deliberately not set yet

| Variable | Add at | Why not now |
|---|---|---|
| `SUPABASE_SECRET_KEY` | when `createAdminClient()` is first imported | Nothing imports it. Onboarding uses the `create_org_with_owner()` RPC. |
| `DATABASE_URL`, `DIRECT_URL` | probably never | Migrations only, run from your machine. The app talks to Supabase over HTTP. |
| `OPENAI_API_KEY` | Phase 5 | Voice pipeline not built. |
| `MS_*` | Phase 7 | Graph not wired. |

**Changing any variable requires a redeploy**, not a restart. Vercel does not
apply them retroactively.

---

## 2. Supabase — Authentication → URL Configuration

This is the step whose absence looks exactly like an application bug. Supabase
only redirects to URLs on its allow-list; anything else is silently replaced
with the Site URL, so users land on `localhost:3000` from their email.

**Site URL**

```
https://calendar-app-nine-brown.vercel.app
```

**Redirect URLs** — add all three, keep localhost so local dev keeps working:

```
https://calendar-app-nine-brown.vercel.app/auth/callback
https://calendar-app-*-ezazahamad2003s-projects.vercel.app/auth/callback
http://localhost:3000/auth/callback
```

The middle entry covers preview deployments. `src/lib/app-url.ts` points a
preview's magic links back at that same preview rather than at production, and
this is what allow-lists them.

---

## 3. Supabase — email confirmation

**Authentication → Sign In / Providers → Email.**

With "Confirm email" on, signup stops at *"check your email"* until the link is
clicked. That is correct behaviour, but it makes the register → org → dashboard
flow untestable without inbox access.

Turn it **off** while testing. Turn it back **on** before real users.

Magic-link sign-in works either way, and is the better thing to test first.

---

## 4. Azure — only needed at Phase 7

Graph is not wired yet, so nothing here affects the app today. Registering the
redirect URIs now is harmless and saves a round trip later.

**Entra admin center → App registrations → your app → Authentication →
Redirect URIs (Web):**

```
http://localhost:3000/api/microsoft/callback
https://calendar-app-nine-brown.vercel.app/api/microsoft/callback
```

Entra compares the whole string exactly. A trailing slash, or `http` where the
registration says `https`, fails with `AADSTS50011`.

Set `MS_REDIRECT_URI` to whichever one matches the environment. Phase 7 is also
blocked on publisher verification, per SPEC §2.

---

## 5. Smoke test after configuring

1. `https://calendar-app-nine-brown.vercel.app/` → should 307 to `/login`
2. Sign up with a real address → lands on `/onboarding`
3. Create a company, pick a timezone → lands on the dashboard, empty state
4. Sign out → back to `/login`
5. Sign in via **Email link** → the email should point at
   `calendar-app-nine-brown.vercel.app`, not `localhost`

If step 5 sends you to localhost, the Site URL in §2 is wrong or the deploy
predates the `NEXT_PUBLIC_APP_URL` change.

---

## Known state

Phases 0–2 and 4 are complete. Phase 3 (dashboard, Gantt, calendar on real
data) is not built, so the dashboard is an empty state by design. Phases 5–6
are not started. Phase 7 is blocked externally.
