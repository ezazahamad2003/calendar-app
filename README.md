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

There is no sign-in and no accounts.

- **The contractor** knows one passcode (`ADMIN_PASSCODE`), types it once, and
  the device is remembered for a year.
- **Everyone else** gets the read-only link from the Crew page. They see the
  chart and nothing else: no microphone, no editing, no addresses, no history.
  The share page does not import the assistant, so those are absent from the
  bundle rather than disabled in it.

## What it deliberately does not do

No calendar integration — the client dropped it in favour of email. No
multi-project support: this is one job, and the data model says so. No dark
mode: it is a paper chart, read in California sun.
