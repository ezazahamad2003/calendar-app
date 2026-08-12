# Foreman

The wall chart from the jobsite trailer, on a phone you can talk to.

One contractor, one job. He opens it with coffee, and he changes it from the
truck by saying what happened: *"Harvpro never showed for the fire riser, push
it back two days."* The app works out everything that has to move with it, shows
him the consequences, and — once he taps Confirm — emails the trades whose dates
changed, with the reason.

## How it works

```
talk  →  Whisper  →  assistant proposes  →  schedule engine computes the real dates
      →  you read the diff  →  Confirm  →  saved, and the trades are emailed
```

The assistant **cannot change anything**. It has one tool, `propose_changes`,
which returns a proposal. Every date on the confirmation screen comes from
`cascade()` in `src/lib/schedule/`, not from the model. `commitPlan()` is the
only function in the app that writes.

## Running it

```bash
pnpm install
pnpm dev
```

That is the whole setup. With no environment configured the app seeds itself
from the client's wall chart, stores the schedule in `data/schedule.json`, runs
ungated, and composes emails without sending them. Add an `OPENAI_API_KEY` to
`.env` to use the microphone. See `.env.example` for the rest.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Where things are

| Path | What it is |
|---|---|
| `src/lib/schedule/` | The date engine. Pure, no I/O, work days and dependency cascade. |
| `src/lib/store/` | The whole schedule as one JSON document. Vercel Blob in production, a file locally. |
| `src/lib/ops/` | The vocabulary of changes: schema, validation, apply, preview, commit. |
| `src/lib/assistant/` | The tool-calling loop and the two server actions. |
| `src/lib/mail/` | Composing and sending the "your dates changed" notes. |
| `src/lib/chart.ts` | The document projected into the wall chart, and into the phone's agenda. |
| `data/seed.json` | The client's chart, transcribed. Regenerate with `scripts/extract-client-files.py`. |
| `data/master-plan.json` | The Microsoft Project sequence, kept for reference. |

## The data

Both come from the client and are committed as JSON:

- **`AG SHOP 8.10.26.xls`** — the printed wall chart. It is the live schedule
  and the shape of the UI: activities down the left with the trade beside each,
  days across the top, weekends shaded, a mark in every day a crew is expected.
- **`SHOP.mpp`** — the Microsoft Project master sequence, authored a year
  earlier. Reference only. Its value now is the *shape* of a construction
  chain, which is what the dependency links encode.

`scripts/extract-client-files.py` converts both. It needs `xlrd`, `mpxj`,
`jpype1` and a JVM, none of which the app itself depends on — it runs by hand
and its output is committed.

## Access

There is no sign-in, no accounts, and **no passcode**. Whoever opens the app is
treated as the contractor: they can talk to it, edit it, and send email.

That is a deliberate choice, and it has consequences worth knowing:

- Anyone who finds the URL can change the schedule and spend OpenAI credit.
- Once mail is configured, they can cause email to reach real subcontractors.
  Confirming still means reading a diff and tapping a button — but the button is
  there for anyone.

The **read-only link** from the Crew page is unaffected and still does its job:
`/s/<token>` renders the chart and nothing else. It does not import the
assistant, so the microphone and the confirm button are absent from that page's
bundle rather than disabled in it. That is the link to hand the crew.

To put a gate back, `requireOwner()` in `src/lib/auth.ts` is the single seam —
every mutation already calls it.

## What it deliberately does not do

No calendar integration — the client dropped it in favour of email. No
multi-project support: this is one job, and the data model says so. No dark
mode: it is a paper chart, read in California sun.
