# Deploying Foreman

Vercel, one project. There is no database to provision and no passcode to
choose. There IS an OAuth app to register, on one side — see §2 — because
mail sends through the contractor's own Gmail or Outlook.

## 1. Create a Blob store

**Storage → Create → Blob**, connect it to the project. Vercel injects a
read-write token for you.

**Use the classic "Connect to Project" button, not "Connect Database".** Both
appear on the Storage tab now. Connect Database is Vercel's newer unified flow
and can inject the token under a *prefixed* name to avoid colliding with a
second store — `MYSTORE_BLOB_READ_WRITE_TOKEN` instead of
`BLOB_READ_WRITE_TOKEN` — which is invisible in the UI and looks identical to
the store not being connected at all. The app's `resolveBlobToken()` finds a
prefixed name too, so either button works; the classic one just avoids the
confusion of a store that is clearly connected and still shows "Almost there".

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

### Sending from a real mailbox

The preferred way to send is the contractor's own Gmail or Outlook, connected
once on `/connections`. One mailbox, not per-user — there is one contractor.
Register an OAuth app with whichever provider he actually uses:

**Outlook** — portal.azure.com → App registrations → New registration.
Redirect URI, Web: `https://your-domain.com/api/microsoft/callback`. Under
API permissions add `Mail.Send` (delegated); `offline_access` and `User.Read`
are included by default. Create a client secret.

| Variable | Value |
|---|---|
| `MS_CLIENT_ID` | Application (client) ID |
| `MS_CLIENT_SECRET` | The client secret's value, not its ID |
| `MS_TENANT_ID` | `common`, unless the org restricts sign-in to one tenant |
| `MS_REDIRECT_URI` | Exactly the URI registered above |

**Gmail** — console.cloud.google.com → APIs & Services → Credentials → Create
OAuth client ID (Web application). Redirect URI:
`https://your-domain.com/api/google/callback`. The OAuth consent screen only
needs the `gmail.send` scope, which is not a restricted scope, so it does not
need Google's security review.

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | From the OAuth client |
| `GOOGLE_CLIENT_SECRET` | From the OAuth client |
| `GOOGLE_REDIRECT_URI` | Exactly the URI registered above |

Both need:

| Variable | Value |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` |

A provider with any of its variables unset shows "Not set up on this
deployment" on `/connections` rather than a broken Connect button — you can
fill in just the one he uses.

### The fallback

Used only when no mailbox is connected:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | From resend.com |
| `MAIL_FROM` | An address on a domain **verified with Resend** |
| `MAIL_REPLY_TO` | Where a subcontractor's reply should land |

**Leave all the mail variables unset until you mean it.** With nothing
configured the app composes every notification, records it, and shows it in
History — but sends nothing. That is the right default for a schedule full of
real subcontractors, and it lets you exercise the whole flow safely before
connecting a real account.

`FEATURE_SEND_EMAIL=false` is the same brake with everything already in place.

## 3. Deploy

```bash
vercel --prod
```

On first request the app seeds itself from `data/seed.json` and writes the
document to Blob. From then on Blob is the source of truth and the seed is
never read again.

## After deploying

1. Open the site — it goes straight to the chart. There is no sign-in.
2. Go to **Mail** (`/connections`) and connect the mailbox. He signs in and
   approves sending mail — nothing else is requested, no reading, no calendar.
3. Go to **Crew** and fill in email addresses. Every trade came off the wall
   chart without one, and until an address is there that trade cannot be told
   anything — the app never guesses. The page says how many are missing.
4. Copy the read-only link from the same page and send it to the crew.

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

> **The main URL is public.** Anyone with it has full edit access — including
> `/connections`, where they could disconnect the mailbox, connect their own,
> or trigger a send from your account. Treat the domain itself as the secret,
> or put a gate back via `requireOwner()`.

## Rotating things

- **The share link** — Crew → *Issue a new link*. The old URL 404s immediately.
- **The mailbox** — Mail → *Disconnect*, then connect again. Confirms first,
  since disconnecting silently stops every future notification.
- **Nothing else needs a passcode or a session — there isn't one.**

## Recovering the schedule

The whole thing is one JSON document. Download it from the Blob dashboard to
take a backup; upload a replacement to roll back. It validates on read, so a
malformed document fails at boot with a message naming the problem rather than
half-loading.
