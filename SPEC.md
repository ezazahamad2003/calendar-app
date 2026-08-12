# Foreman — what it is and why it is built this way

This replaces the original brief. That document described a multi-tenant SaaS
for contractors juggling four to twelve jobs, on Supabase with row level
security, Microsoft Graph mail and a two-way Outlook calendar sync. After the
client conversation of **12 August 2026** almost none of that survived.

What actually exists: one contractor, one job, a JSON file, and a button he
talks to. No sign-in of any kind — the main URL is open, and the read-only
`/s/<token>` link is what the crew get.

## 0. The user

A general contractor standing on a concrete slab, holding a phone, in
California sun. Sometimes in a truck. That single fact decides most of what
follows: press-to-talk rather than an open mic, one big button in thumb reach,
a light palette because a dark one is unreadable outdoors, and never an
irreversible action without a confirmation he can read at arm's length.

His schedule lives on a printed grid taped to the trailer wall. The app is that
grid.

## 1. What changed, and why

| Was | Is | Why |
|---|---|---|
| Supabase Postgres, RLS, 8 migrations | One JSON document | One job, thirty-five activities. The whole schedule is smaller than a photograph and every screen reads all of it. |
| Email sign-in, orgs, memberships | Nothing at all | There is one user. Accounts were ceremony for a table with one row in it, and the passcode that briefly replaced them was one more thing to do on a phone with wet hands. |
| Outlook + Gmail OAuth, calendar sync | Email via one API key | The client dropped the calendar outright: *"when something changed, email should be sent to them, and the reason."* No per-user OAuth also means no sign-in to remove. |
| Month-grid calendar, Gantt | The wall chart | The client sent the spreadsheet and said the overview should look like that. |
| Multi-project dashboard | One project | *"this is just one project."* |
| — | Read-only share link | The crew needs to see the schedule and must not be able to change it or spend money on the microphone. It is now the only access control in the app. |

## 2. Stack

Next.js (App Router, TypeScript strict), Vercel, Vercel Blob, OpenAI Whisper +
GPT, Resend. That is the whole list. There is no database, no ORM, no auth at
all, and no UI framework beyond hand-authored CSS.

## 3. The data model

One document, `src/lib/store/types.ts`:

```
project     name, client, address, timezone
calendar    workingDays (ISO 1..7), holidays
sections    the chart's banners — "AG SHOP BUILDING", "ORDERS"
tasks       activity, team, contact, startDate, durationDays, status, order
deps        predecessor → successor, FS/SS/FF/SF, lagDays
contacts    the trades, and their addresses
changeLog   append-only: what moved, why, and who was told
share       the crew's token
```

`durationDays` is **work days**, always. `startDate` is a civil date — "the
18th", not an instant — and every computation goes through the org calendar.

### Status is the chart's own shorthand

`confirmed` is an X, `tentative` is a ?, `done` is a D, `planned` is a real
activity with no date yet, `blocked` cannot proceed. Half the wall chart is
`planned`; that column is what the contractor scans for what to chase, and it
must survive every import and every cascade.

## 4. The date engine

`src/lib/schedule/` — pure functions, no I/O, exhaustively tested. Unchanged
from the original build except for one fix, and it is the important one:

> **An undated activity is never given a date by a cascade.** A dated
> predecessor is not enough. The code used to invent one, contradicting its own
> documentation. With half the chart undated and the app now emailing on every
> change, that bug would have mailed subcontractors bookings no human ever made.

Dependencies are **rigid in the forward direction**, MS Project style: a linked
successor keeps its gap and moves with its predecessor. The gap is not slack, it
is fitted lag — `scripts/extract-client-files.py` computes each link's lag from
the dates already on the wall, so the seed is a fixed point of `cascade()`. A
test asserts exactly that, because a schedule that reshuffles itself the moment
you speak to it is one nobody trusts.

## 5. The assistant

A tool-calling loop with exactly one tool, `propose_changes`, which returns a
proposal and writes nothing. The asymmetry is the design:

1. **Nothing writes without a confirm.** `commitPlan()` is the only writer, and
   only the Confirm button reaches it.
2. **It never claims a completed action.** "That'll move the downspouts", never
   "I've moved the downspouts."
3. **It never describes a change it cannot express.** The vocabulary in
   `src/lib/ops/schema.ts` is small on purpose; anything outside it must be
   refused, not approximated.
4. **Adding is not moving.** `add_activity` and `move_activity` are separate.
   "Put plumbing in Tuesday" creates one even when a similar row exists —
   a duplicate is an easy delete, a silently moved crew booking is a wasted day.
5. **Ids are validated in code**, against the document, never trusted. A
   hallucinated id fails the whole plan rather than being skipped.
6. **The preview comes from the engine.** Every date on the confirm screen is
   `cascade()`'s output via `applyOperations`, the same path the write takes.
7. **It never guesses an email address.** The model is told whether a contact
   has one, never what it is.

Note that (1) is now the *only* thing standing between a stray visitor and a
schedule change: with the gate gone, the confirm step is not merely a courtesy,
it is the safety mechanism.

### The request the whole thing is built around

> *"if the user says this thing changed, they didn't come, so push forward two
> days — it should happen, but also adjust everything accordingly, it should
> know which will push forward when."*

That is `push_activity` plus `cascade`. The model says how far in working days;
the app does the arithmetic and works out what follows. It is tested against the
real chart in `tests/playbook.test.ts`.

## 6. Email

One channel, replacing the calendar entirely. When dates move, the trades whose
dates moved are emailed — grouped one message per trade, not one per activity —
and the message quotes the **reason**, above the dates, because that is what
decides whether the reader is annoyed or informed.

Deliberately silent about: an activity with no contact, a contact with no
address, an activity left with no date. Each is recorded as a skip with its
reason and shown in the app, so "who did we tell?" has an answer that includes
the people we did not.

No key configured means the console driver: composed, recorded, shown, not sent.
That is the default.

## 7. Interface

The chart is the product. Rows are activities with the trade beside each,
columns are days, weekends shaded, sections as full-width banners. The signature
is the today line — one hot vertical rule through the whole chart, the
highlighter mark the foreman draws every morning.

Below 900px the grid is **replaced**, not shrunk: sixty columns cannot be made
legible on a phone, and the on-site question is "who is here today", which is a
list. Both layouts render server-side and one is hidden by a media query, so the
right one is in the first paint on a bad connection.

Non-negotiables: the talk button in thumb reach, visible keyboard focus,
`prefers-reduced-motion` respected, no page-level horizontal scroll at 375px.

## 8. Standing rules

- TypeScript strict. No `any`. No non-null assertions on network data.
- Zod-validate every external input and every model response before use.
- Errors say what happened and what to do.
- The store is read-modify-write with a version check. Two writers — a phone in
  the truck and a laptop in the office — must not silently revert each other.
- `data/seed.json` is a faithful transcription of the client's file. App-shaped
  assembly happens in `src/lib/store/seed.ts`, so re-importing an updated chart
  never has to think about ids, contacts or share tokens.
