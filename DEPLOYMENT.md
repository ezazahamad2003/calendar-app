# Deploying Foreman

Vercel, one project, four environment variables. There is no database to
provision and no OAuth app to register — both went away with the rewrite.

## 1. Create a Blob store

**Storage → Create → Blob**, connect it to the project. Vercel injects
`BLOB_READ_WRITE_TOKEN` for you.

This is not optional in production. A serverless function's filesystem is
discarded between invocations, so without it every change is silently lost —
the app refuses to start rather than let that happen quietly.

## 2. Set the environment variables

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://your-domain.com` — no trailing slash |
| `ADMIN_PASSCODE` | The passcode. At least 16 characters. |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `OPENAI_API_KEY` | For the microphone and the assistant |

Optional, for real email:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | From resend.com |
| `MAIL_FROM` | An address on a domain **verified with Resend** |
| `MAIL_REPLY_TO` | Where a subcontractor's reply should land |

**Leave the mail variables unset until you mean it.** Without them the app
composes every notification, records it, and shows it in History — but sends
nothing. That is the right default for a schedule full of real subcontractors,
and it lets you exercise the whole flow safely.

`FEATURE_SEND_EMAIL=false` is the same brake with the key already in place.

### Choosing the passcode

It is the only thing between a public URL and a button that emails
subcontractors. `env.ts` enforces a 16-character floor; `auth.ts` throttles
wrong guesses per instance, but that throttle is a nuisance to an attacker, not
a defence. Use a passphrase he can say out loud and type once a year.

## 3. Deploy

```bash
vercel --prod
```

On first request the app seeds itself from `data/seed.json` and writes the
document to Blob. From then on Blob is the source of truth and the seed is
never read again.

## After deploying

1. Open the site, enter the passcode.
2. Go to **Crew** and fill in email addresses. Every trade came off the wall
   chart without one, and until an address is there that trade cannot be told
   anything — the app never guesses. The page says how many are missing.
3. Copy the read-only link from the same page and send it to the crew.

## Verifying a release

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm build` is not redundant with `typecheck`: it catches `"use server"`
violations — a server-actions file may only export async functions — that `tsc`
does not.

Then, against the deployment:

- Say something that changes a date and check the diff before confirming.
- Check **History** shows the change, the reason, and who was told.
- Open the share link in a private window: chart visible, no microphone, no
  Confirm, no addresses.

## Rotating things

- **The share link** — Crew → *Issue a new link*. The old URL 404s immediately.
- **The passcode** — change `ADMIN_PASSCODE` and redeploy. Existing sessions
  survive, because the cookie is signed with `SESSION_SECRET`, not the passcode.
- **Every session** — change `SESSION_SECRET`. Everyone is signed out.

## Recovering the schedule

The whole thing is one JSON document. Download it from the Blob dashboard to
take a backup; upload a replacement to roll back. It validates on read, so a
malformed document fails at boot with a message naming the problem rather than
half-loading.
