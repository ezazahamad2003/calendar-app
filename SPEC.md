# Foreman — build brief for Claude Code

Paste this whole file into Claude Code as the opening message, or save it as `SPEC.md`
in an empty repo and open with: *"Read SPEC.md and start at Phase 0."*

---

## 0. What you are building

**Foreman** — a voice-driven construction scheduling app for general contractors.

A contractor running four to twelve jobs at once currently keeps his schedule in
Microsoft Project on an office desktop and re-types it into emails from his truck.
Foreman lets him talk to the schedule from a phone on a jobsite:

> "Push framing on Hillcrest back two weeks and let Tom know."

The app parses that, moves the bar, cascades every dependent task, drafts the email
to the framer, and — once he confirms — sends it from his own Outlook and updates
his Outlook calendar.

**The user is standing on a concrete slab holding a phone.** Every design decision
follows from that: push-to-talk not open mic, big touch targets, works on bad signal,
and never takes an irreversible action without a confirmation he can read.

---

## 1. Stack — do not substitute

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router), TypeScript, strict mode |
| Hosting | Vercel |
| Database | Supabase Postgres |
| Auth | Supabase Auth (email/password + magic link) |
| Tenancy | Postgres Row Level Security |
| Voice → text | OpenAI Whisper (`whisper-1`) |
| Text → operations | OpenAI `gpt-4o`, JSON mode |
| Mail + calendar | Microsoft Graph (delegated) |
| UI | Tailwind + shadcn/ui |
| Tests | Vitest (unit), Playwright (e2e) |

Read `.env.example` for every variable. Never invent new env var names without
adding them there first. Never commit a `.env`.

**Not in scope:** GCP, a separate backend service, OpenAI Realtime API, websockets,
React Native, Redis. If you think you need one, stop and ask.

---

## 2. Build order — stop at each gate

Work one phase at a time. At the end of each phase, run the checks, commit, print a
short summary, and **stop and wait for me**. Do not roll into the next phase.

```
Phase 0  Scaffold + env validation
Phase 1  Schema, migrations, RLS
Phase 2  Auth + org onboarding
Phase 3  Dashboard, Gantt, calendar (real data, no voice)
Phase 4  Date engine — work days + dependency cascade
Phase 5  Voice → plan → confirm → apply
Phase 6  Email + calendar (mocked Graph)
Phase 7  Real Graph wiring
```

Graph is last on purpose. Publisher verification is pending on my side and will
block it. Nothing else may depend on it.

---

## 3. Data model

Every business table carries `org_id`. Every table has RLS. No exceptions.

### Tenancy

```sql
orgs            id, name, company_name, timezone, created_at
memberships     id, org_id, user_id, role ('owner'|'admin'|'member'), created_at
```

A user reaches data only through `memberships`. Build a
`SECURITY DEFINER` helper `auth_org_ids()` returning the caller's org ids, and use
it in every policy — a subquery against `memberships` inside a policy on
`memberships` will recurse.

### Scheduling

```sql
projects        id, org_id, name, job_number, client_name, address,
                status ('active'|'complete'|'on_hold'), starts_on, meta jsonb
tasks           id, org_id, project_id, name, trade, start_date, duration_days,
                status ('planned'|'active'|'blocked'|'done'), notes,
                is_milestone bool, sort_order int, meta jsonb
task_deps       id, org_id, predecessor_id, successor_id,
                dep_type ('FS'|'SS'|'FF'|'SF') default 'FS', lag_days int default 0
                -- unique (predecessor_id, successor_id)
contacts        id, org_id, name, company, trade, email, phone, meta jsonb
assignments     id, org_id, task_id, contact_id, role  -- unique (task_id, contact_id)
```

`duration_days` is **work days**, always. Never calendar days. `start_date` and every
derived finish date are real `date` columns — not JSONB — because the Gantt and
calendar filter and sort on them.

### Work calendar

```sql
work_calendars  id, org_id, name, working_days int[]   -- ISO 1=Mon..7=Sun
holidays        id, org_id, calendar_id, date, label
```

Default `working_days` = `{1,2,3,4,5}`. Every date computation goes through the org's
calendar. A task starting Friday with 3 work days finishes Tuesday.

### Microsoft + audit

```sql
ms_connections  id, org_id, user_id, ms_user_id, email,
                refresh_token_encrypted text, scopes text[],
                connected_at, last_refreshed_at, status ('active'|'needs_reauth')
outbound_messages id, org_id, task_id, contact_id, channel ('email'|'calendar'),
                  subject, body, status ('draft'|'queued'|'sent'|'failed'),
                  idempotency_key text unique, ms_message_id, ms_event_id,
                  error text, created_at, sent_at
change_log      id, org_id, actor_user_id, entity_type, entity_id,
                action, before jsonb, after jsonb, source ('voice'|'ui'|'system'),
                transcript text, created_at
```

`refresh_token_encrypted` is AES-256-GCM using `TOKEN_ENCRYPTION_KEY`. **No RLS
policy may ever expose `ms_connections` to the client role.** Server-side access only,
through the secret key. Write a test that asserts a client-side select returns zero rows.

`change_log` is append-only. Contractors have date disputes constantly and this is the
record that settles them — treat it as a product feature, not debug logging.

### JSONB rules

`meta` columns only, for genuinely open-shaped data: raw transcripts, parsed operation
payloads, Graph API responses kept for debugging. Anything you filter, sort, join, or
index on is a real typed column. If you find yourself writing `meta->>'start_date'`,
you have made a mistake.

---

## 4. Date engine — build this before voice

`lib/schedule/` — pure functions, no database, no network, fully unit-tested. This is
the core of the product and the easiest thing to get subtly wrong.

```ts
addWorkDays(start: Date, n: number, cal: WorkCalendar): Date
workDaysBetween(a: Date, b: Date, cal: WorkCalendar): number
finishDate(startDate: Date, durationDays: number, cal: WorkCalendar): Date
cascade(tasks: Task[], deps: TaskDep[], changed: TaskId[], cal: WorkCalendar): TaskChange[]
detectCycle(deps: TaskDep[]): TaskId[] | null
criticalPath(tasks: Task[], deps: TaskDep[], cal: WorkCalendar): TaskId[]
```

Rules:

- A task never starts on a non-working day. Push forward to the next working day.
- `cascade` returns *proposed* changes. It never writes. The caller decides.
- FS with lag is the common case; implement all four types but optimize for FS.
- Reject cycles at write time with a clear error naming the two tasks involved.
- Dates are stored and computed as calendar dates in the org's timezone. Never
  `new Date()` on an ISO string without pinning the timezone — off-by-one from UTC
  drift is the bug that will make a contractor stop trusting the app.

Tests must cover: Friday start rolling over a weekend, a holiday inside a span, a
duration of 1, cascading three levels deep, negative lag, and a cycle.

---

## 5. Voice pipeline

```
push-to-talk → audio blob → /api/voice/transcribe (Whisper)
  → /api/voice/plan (gpt-4o, JSON mode) → Plan object
  → cascade() computes knock-on effects
  → UI renders the plan as a readable diff
  → user taps Confirm
  → /api/voice/apply → transaction → change_log
```

### Never auto-execute

The planner proposes. The user disposes. A sub who gets an email committing his crew
to the wrong week because Whisper heard "two months" instead of "two weeks" is a real
cost to a real business. Show the diff, wait for the tap.

The diff must be readable at arm's length in sunlight:

```
Framing              Mar 3 → Mar 17     (+14d)
  ↳ Roof dry-in      Mar 23 → Apr 6     (cascaded)
  ↳ Rough plumbing   Mar 25 → Apr 8     (cascaded)
Email → Tom Brady Jr., Northstate Framing
```

### Plan schema

```ts
type Plan = {
  summary: string;                    // one sentence, read back to the user
  operations: Operation[];
  clarification?: string;             // set when the request is ambiguous
  confidence: 'high' | 'low';
}

type Operation =
  | { type: 'create_task'; projectId; name; trade; startDate; durationDays; assigneeId?; deps? }
  | { type: 'move_task'; taskId; startDate }
  | { type: 'shift_task'; taskId; byDays }
  | { type: 'resize_task'; taskId; durationDays }
  | { type: 'assign_task'; taskId; contactId }
  | { type: 'set_status'; taskId; status }
  | { type: 'add_dependency'; predecessorId; successorId; depType; lagDays }
  | { type: 'shift_project'; projectId; byDays }
  | { type: 'send_email'; contactIds: string[]; subject; body; taskId? }
  | { type: 'create_contact'; name; company; trade; email; phone }
```

### Planner prompt requirements

- Pass today's date, the org timezone, and only the *relevant* project's tasks and
  contacts — not the whole database. Trim by active project first.
- Entity IDs must come from the supplied context. Validate every returned ID exists
  before applying; a hallucinated ID is a hard failure, not a silent skip.
- Resolve relative dates server-side against the org calendar, not in the model.
  The model returns intent; your code does the arithmetic.
- Fuzzy-match people and tasks by name, trade, or company. Ambiguity between two
  candidates sets `clarification` and returns zero operations.
- Never guess an email address. Unknown contact → `clarification`.

Build `/api/voice/plan` so it accepts typed text too. Voice is the headline feature,
typing is the fallback when the site is loud, and both go through the same path.

---

## 6. Microsoft Graph

### Phase 6 — mocked

Define `lib/graph/client.ts` as an interface. Ship a `MockGraphClient` that logs and
returns fixture responses. Every feature above it must be complete and testable
against the mock.

```ts
interface GraphClient {
  sendMail(opts: SendMailOptions): Promise<{ messageId: string }>;
  createEvent(opts: CreateEventOptions): Promise<{ eventId: string }>;
  updateEvent(eventId: string, opts: Partial<CreateEventOptions>): Promise<void>;
  listCalendars(): Promise<Calendar[]>;
}
```

### Phase 7 — real

- OAuth authorization code + PKCE. Scopes from `MS_SCOPES`.
- Refresh token encrypted before it touches the database. Refresh proactively on a
  margin, not on 401.
- Refresh failure sets `status = 'needs_reauth'` and surfaces a banner in the app.
  It must never fail silently into a queue of mail that never sends.
- Add subcontractors to `attendees` on calendar events rather than emailing them
  separately. They get a real invite in their own inbox and accept/decline flows back
  — that is the confirmation loop, for free.
- Create a dedicated calendar per project via `/me/calendars` so job dates don't bury
  his personal calendar.
- **Idempotency:** write the `outbound_messages` row with its `idempotency_key`
  *before* calling Graph. On retry, check for an existing sent row first. A duplicate
  invite to a subcontractor is a support call.
- v1 is one-way. App is source of truth, Outlook is a mirror. Say so in the UI.
  Change notifications and subscription renewal are out of scope.

I will do the manual OAuth test myself — you cannot click a consent screen. Write the
integration tests, mark them `skip` with a comment naming what needs a live account.

---

## 7. Interface

Read `/mnt/skills/public/frontend-design/SKILL.md` before writing any component.

**Dashboard** — every active project, each with a health line: tasks in flight,
what's late, what's blocked, next milestone. This is the screen he opens in the
morning with coffee.

**Project view** — Gantt with draggable bars, trade colors, a today line, critical
path highlighted, dependency arrows. Zoom: year / quarter / week.

**Calendar** — month grid, everything active on each day.

**Crew** — contacts, their trade, and which scopes they're carrying.

**Outbox** — queued and sent messages, editable before send.

Non-negotiables: push-to-talk button reachable with a thumb on mobile; visible
keyboard focus; responsive to 375px; `prefers-reduced-motion` respected; optimistic
UI with rollback on failure.

Do not build a settings page nobody asked for. Do not build notifications. Do not
build a landing page.

---

## 8. Standing rules

- TypeScript strict. No `any`. No non-null assertions on data from the network.
- Server actions or route handlers for mutations. Never write to Postgres from the
  browser with the secret key.
- Zod-validate every API input and every OpenAI response before use.
- Errors say what happened and what to do. Never a bare toast reading "Error".
- Commit at each phase gate with a real message. Never `git push --force`.
- If a requirement here conflicts with what you find while building, **stop and ask.**
  Do not resolve it silently.
- Do not add dependencies not listed in §1 without asking first.

---

## 9. Definition of done, per phase

| Phase | Done when |
|---|---|
| 0 | `pnpm dev` runs; env validated at boot with a clear error listing missing vars |
| 1 | Migrations apply clean; RLS test proves org A cannot read org B; `ms_connections` unreadable from the client role |
| 2 | Register → create org → land on empty dashboard, end to end |
| 3 | Seeded project renders in Gantt and calendar; drag a bar, it persists |
| 4 | Every date-engine test in §4 passes |
| 5 | Typed *and* spoken command produce a diff; confirm applies in one transaction; `change_log` row written |
| 6 | Full flow works against `MockGraphClient`; `outbound_messages` rows correct |
| 7 | Real OAuth round-trip; one mail sent; one event created with an attendee |

---

## 10. Start here

Phase 0. Scaffold, wire env validation, confirm `pnpm dev` boots. Then stop and show
me what you've got.
