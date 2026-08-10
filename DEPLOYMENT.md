# Deploying Foreman

- Repo: <https://github.com/ezazahamad2003/calendar-app> (`main`)
- Production: <https://calendar-app-nine-brown.vercel.app>
- Supabase project: `iksrtkijgsemqhixgtoz` (ca-central-1)

Vercel redeploys on every push to `main`.

---

## 1. Vercel environment variables

**Settings → Environment Variables**, scope **Production**. `NEXT_PUBLIC_*` is
inlined at build time and the rest is validated at boot by
`src/instrumentation.ts`, so a missing value fails the deploy rather than
starting up broken.

| Variable | Production value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://calendar-app-nine-brown.vercel.app` |
| `NEXT_PUBLIC_SUPABASE_URL` | same as local |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | same as local |
| `TOKEN_ENCRYPTION_KEY` | same as local (secret) |
| `CRON_SECRET` | same as local (secret) |
| `OPENAI_API_KEY` | same as local (secret) — voice + planner |
| `SUPABASE_SECRET_KEY` | same as local (secret) — `ms_connections` is server-only |
| `MS_CLIENT_ID` | same as local |
| `MS_CLIENT_SECRET` | same as local (secret) |
| `MS_TENANT_ID` | `common` |
| `MS_SCOPES` | `offline_access User.Read Mail.Send Calendars.ReadWrite` |
| `MS_REDIRECT_URI` | **differs from local:** `https://calendar-app-nine-brown.vercel.app/api/microsoft/callback` |

> **No trailing slash on `NEXT_PUBLIC_APP_URL`.** It is concatenated with
> `/auth/callback`.

Do not set `NODE_ENV`, `VERCEL_ENV` or `VERCEL_URL` — the platform provides them.

`DATABASE_URL` / `DIRECT_URL` stay off Vercel: migrations only, run from your
machine. The app reaches Supabase over HTTP and holds no Postgres connections.

**Changing any variable requires a redeploy.** Vercel does not apply them
retroactively.

---

## 2. Supabase — Authentication → URL Configuration

Supabase only redirects to URLs on its allow-list; anything else is silently
replaced with the Site URL, so users land on `localhost:3000` from their email.

**Site URL**

```
https://calendar-app-nine-brown.vercel.app
```

**Redirect URLs**

```
https://calendar-app-nine-brown.vercel.app/auth/callback
https://calendar-app-*-ezazahamad2003s-projects.vercel.app/auth/callback
http://localhost:3000/auth/callback
```

The wildcard covers preview deployments; `src/lib/app-url.ts` points a
preview's magic links back at that same preview rather than production.

**Authentication → Sign In / Providers → Email**: keep "Confirm email" **off**
while testing, back **on** before real users.

---

## 3. Azure — Entra admin center → App registrations → your app

**Authentication → Redirect URIs (Web)** — both, byte-exact:

```
http://localhost:3000/api/microsoft/callback
https://calendar-app-nine-brown.vercel.app/api/microsoft/callback
```

Entra compares the whole string. A trailing slash, or `http` where the
registration says `https`, fails with `AADSTS50011`.

**API permissions → Microsoft Graph → Delegated** — all four, all
self-consentable (no admin consent needed):

```
User.Read   Mail.Send   Calendars.ReadWrite   offline_access
```

**Supported account types** must include personal Microsoft accounts, matching
`MS_TENANT_ID=common`.

Publisher verification is not required to test with a personal Microsoft
account; it only removes the unverified-publisher warning on the consent screen.

---

## 4. Smoke test

1. `/` → 307 to `/login`
2. Create an account → `/onboarding` → company + timezone → dashboard
3. **Seed a demo project** → Gantt with six trades, a milestone and crew
4. Drag a bar → dependents cascade, dates stay on working days
5. Voice bar: type *"Push framing back two weeks and let Tom know"* → read the
   diff → **Confirm**
6. **Outbox** → the queued email is there → **Send**
7. **Connect Outlook** in the left rail → consent → banner shows connected
8. Outbox → send again → arrives in a real inbox

Steps 1–6 work with no Microsoft connection at all; sends are labelled
*simulated*. Step 7 is the only part that needs Azure.

If step 5's email points at localhost, `NEXT_PUBLIC_APP_URL` is stale — set it
and redeploy.

---

## What is built

Phases 0–7 are complete. Phase 7's OAuth round-trip is the one thing never
executed from a development machine — a consent screen cannot be clicked
headlessly — so `tests/graph/real.integration.test.ts` holds `describe.skip`
tests naming exactly what to run against a live consented account.
