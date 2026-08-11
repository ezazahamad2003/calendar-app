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
| `SUPABASE_SECRET_KEY` | same as local (secret) — `provider_connections` is server-only |
| `MS_CLIENT_ID` | same as local |
| `MS_CLIENT_SECRET` | same as local (secret) |
| `MS_TENANT_ID` | `common` |
| `MS_SCOPES` | `offline_access User.Read Mail.Send Calendars.ReadWrite` |
| `MS_REDIRECT_URI` | **differs from local:** `https://calendar-app-nine-brown.vercel.app/api/microsoft/callback` |
| `GOOGLE_CLIENT_ID` | same as local |
| `GOOGLE_CLIENT_SECRET` | same as local (secret) |
| `GOOGLE_SCOPES` | `openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events` |
| `GOOGLE_REDIRECT_URI` | **differs from local:** `https://calendar-app-nine-brown.vercel.app/api/google/callback` |

The two providers are independent. Set only the `MS_*` block and users see
Outlook alone; set only `GOOGLE_*` and they see Gmail alone; set both and each
user picks on **/connections**. Set neither and every send is *simulated*.

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

## 4. Google Cloud — console.cloud.google.com → your project

**APIs & Services → Library** — enable both, or the calls 403 with
`accessNotConfigured`:

```
Gmail API        Google Calendar API
```

**Credentials → Create credentials → OAuth client ID → Web application →
Authorized redirect URIs** — both, byte-exact:

```
http://localhost:3000/api/google/callback
https://calendar-app-nine-brown.vercel.app/api/google/callback
```

A mismatch fails with `redirect_uri_mismatch`, Google's equivalent of
`AADSTS50011`.

**OAuth consent screen → Scopes** — the two the app requests, plus identity:

```
openid   email
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/calendar.events
```

**`gmail.send` is a *sensitive* scope — this is the one real asymmetry with
Outlook.** While the consent screen is in **Testing**, it works for up to 100
users you list by hand under **Test users**, with no review. Publishing it so
any customer can connect Gmail requires Google's app verification: a privacy
policy, a verified domain, and a demo video, reviewed over weeks. Plan for that
lead time before promising Gmail to a customer; Outlook has no equivalent gate.

Test users' refresh tokens also expire after 7 days while the app is unpublished
— a tester who returns the following week gets the reconnect banner, which is
Google's behaviour, not a bug in the app.

---

## 5. Smoke test

1. `/` → 307 to `/login`
2. Create an account → `/onboarding` → company + timezone → dashboard
3. **Seed a demo project** → Gantt with six trades, a milestone and crew
4. Drag a bar → dependents cascade, dates stay on working days
5. Voice bar: type *"Push framing back two weeks and let Tom know"* → read the
   diff → **Confirm**
6. **Outbox** → the queued email is there → **Send**
7. **Connections** in the left rail → **Connect Outlook** → consent → the card
   reads *Connected as …* and the rail reads *Sending via Outlook*
8. Outbox → send again → arrives in a real inbox
9. Back to **Connections** → **Connect Gmail** → consent → both cards now show
   connected, Outlook still badged *Sends from here*
10. **Send from Gmail** on the Gmail card → the badge moves → Outbox header
    reads *Sending via Gmail* → send → arrives from the Google account
11. **Disconnect** Gmail → confirm → the badge falls back to Outlook

Steps 1–6 work with no connection at all; sends are labelled *simulated*.
Step 7 needs Azure, steps 9–11 need Google Cloud, and neither is required for
the other.

If step 5's email points at localhost, `NEXT_PUBLIC_APP_URL` is stale — set it
and redeploy.

---

## What is built

Phases 0–8 are complete. The OAuth round-trip is the one thing never executed
from a development machine — a consent screen cannot be clicked headlessly — so
`tests/providers/providers.integration.test.ts` holds `describe.skip` tests
naming exactly what to run against a live consented account, for either
provider.

Phase 8 added Google alongside Microsoft behind one interface
(`src/lib/providers/client.ts`). The migration
`20260810160000_provider_connections.sql` renames `ms_connections` to
`provider_connections` and must be pushed (`pnpm db:push`) before the deploy
that ships it — the app queries the new name.
