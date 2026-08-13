# Deploying Foreman

Vercel, one project, two environment variables. There is no database to
provision, no OAuth app to register, and no passcode to choose.

## 1. Create a Blob store

**Storage → Create → Blob**, connect it to the project. Vercel injects
`BLOB_READ_WRITE_TOKEN` for you.

In the create dialog:

| Field | Value |
|---|---|
| Store Name | Anything — `foreman-schedule` |
| Region | `iad1`, matching where the functions deploy |
| Access | **Private** |

**Private matters.** The document carries every subcontractor's email address,
and a public blob is readable by anyone who ever sees its URL. Nothing needs
that — the app is the only reader and it reads server-side with the token.
`BLOB_ACCESS` in `src/lib/store/driver.ts` is set to `private` to match; a
public store makes the reads fail, so change one or the other.

This is not optional in production. A serverless function's filesystem is
discarded between invocations, so without it every change is silently lost —
the app shows a setup screen rather than let that happen quietly.

## 2. Set the environment variables

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://your-domain.com` — no trailing slash |
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

## 3. Deploy

```bash
vercel --prod
```

On first request the app seeds itself from `data/seed.json` and writes the
document to Blob. From then on Blob is the source of truth and the seed is
never read again.

## After deploying

1. Open the site — it goes straight to the chart. There is no sign-in.
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

> **The main URL is public.** Anyone with it has full edit access. Treat the
> domain itself as the secret, or put a gate back via `requireOwner()`.

## Rotating things

- **The share link** — Crew → *Issue a new link*. The old URL 404s immediately.
- **Nothing else.** There is no passcode and no session to rotate. The share
  token is the only secret the app holds.

## Recovering the schedule

The whole thing is one JSON document. Download it from the Blob dashboard to
take a backup; upload a replacement to roll back. It validates on read, so a
malformed document fails at boot with a message naming the problem rather than
half-loading.
