# Assistant behaviour — test cases

Each case is a transcript, the state it assumes, what must happen, and what must
**not**. The "must not" line is the point of the case: every bug found so far
has been the assistant doing something plausible that nobody asked for.

Seeded from bugs that actually shipped. Add a case when you find a new one —
before fixing it.

---

## Invariant 4 — adding is not moving

### A1. Add next to a similarly-named existing task
- **Say:** "add plumbing for Chico Real Estate today"
- **Context:** Chico Real Estate has a task "Plumberry" dated Fri 14 Aug
- **Expect:** one `create_task` on Chico, dated today, diff line tagged **New**
- **Must not:** move, shift or rename Plumberry; no line tagged **Moved**
- *Shipped broken once: fuzzy matching was applied to whether a new task was
  wanted, not just to which thing was meant.*

### A2. Explicit move still moves
- **Say:** "move Plumberry to next Monday"
- **Expect:** one `move_task`, diff tagged **Moved**, old date struck through
- **Must not:** create a second Plumberry

### A3. Relative move uses working days
- **Say:** "push framing back two weeks"
- **Expect:** `shift_task` with `byDays: 10` on a five-day calendar — not 14
- **Must not:** land the task on a Saturday or Sunday

---

## Invariant 3 — never describe a change it cannot express

### B1. Rename a project
- **Say:** "rename Bargaining Real Estate to Barney Real Estate"
- **Expect:** `update_project` with only `name` set; diff shows
  `Bargaining Real Estate → Barney Real Estate` with the old value struck out
- **Must not:** `create_project`; must not produce a second job in the rail
- *Shipped broken once: it said "that'll change the name" and made a duplicate.*

### B2. Rename preserves the other fields
- **Say:** "rename it to X" on a project with a client and a job number
- **Expect:** client and job number unchanged afterwards
- **Must not:** blank any field the sentence did not mention

### B3. Something genuinely unsupported
- **Say:** "set the budget for Chico to 40 grand"
- **Expect:** a plain reply that it cannot do budgets
- **Must not:** propose anything at all — no nearest-fit operation, no note
  pretending it was handled

---

## Invariant 8 — notifications and calendar events

### C1. Undated task, assigned
- **Say:** "put Alex on the plumbing" where the task has no dates
- **Expect:** the assignment; no email
- **Must not:** send "You're scheduled for X: not yet scheduled"
- *Shipped broken once.*

### C2. Two people on one task
- **Say:** "put Alex and Tom on Tuesday's framing"
- **Expect:** two emails, **one** calendar event with both as attendees
- **Must not:** two calendar events for the same day's work

### C3. Moving a synced task
- **Say:** "move that to Friday" on a task already on the calendar
- **Expect:** the existing event moves
- **Must not:** a second event appear; the old date must not be left behind

### C4. Person with no email
- **Say:** "let Dave know" where Dave has no address on file
- **Expect:** it says so and asks for the address
- **Must not:** invent an address; must not silently skip the notification

---

## Invariant 2 — never claim a completed action

### D1. Wording before confirm
- **Say:** anything that produces a proposal
- **Expect:** "that'll…", "this would…"
- **Must not:** "I've moved…", "done", "I sent…" — nothing is real until
  Confirm

### D2. Discard means nothing happened
- **Do:** propose a change, then Discard, then ask "what did you just change?"
- **Expect:** it knows nothing was applied
- **Must not:** describe the discarded change as done

---

## Invariant 5 — ids are validated

### E1. Unknown person
- **Say:** "put Jennifer on framing" where no Jennifer exists
- **Expect:** it says she isn't in the crew, or offers to add her
- **Must not:** invent a contact id; must not silently assign someone else

### E2. Ambiguous name
- **Context:** two contacts named Alex
- **Say:** "put Alex on framing"
- **Expect:** a clarification naming both, and **no** operations
- **Must not:** pick one

---

## Conversation

### F1. Follow-up correction
- **Say:** "push framing back two weeks" → then "actually make it one week"
- **Expect:** a fresh proposal for one week
- **Must not:** treat the second as unrelated, or stack both shifts

### F2. Question, not command
- **Say:** "is Alex free on Tuesday?"
- **Expect:** a prose answer from `person_schedule`
- **Must not:** propose anything

### F3. Question about history
- **Say:** "what did I change yesterday?"
- **Expect:** an answer from `recent_changes`
- **Must not:** claim it cannot see history

---

## Capability limits

### G1. Times of day
- **Say:** "schedule plumbing 8pm to 9pm on the 18th"
- **Expect:** a day-level task on the 18th, plus a **note** that times were
  dropped; Confirm stays available
- **Must not:** a `clarification`, which cancels everything and creates nothing
- *Shipped broken once: it refused the whole request.*

### G2. Empty account
- **Context:** a brand-new org with no projects
- **Say:** "start a job called Chico Flats with plumbing on the 18th"
- **Expect:** `create_project` + `create_task` referencing `$p0`, one
  transaction
- **Must not:** refuse for lack of an existing project
- *Shipped broken once.*

---

## Colour and display

### H1. Distinct project colours
- **Context:** three or more projects
- **Expect:** every project a different colour; rail dot matches its calendar
  chips
- **Must not:** two jobs sharing a colour below eight projects

### H2. Colour survives a new job
- **Do:** note two projects' colours, add a third
- **Expect:** the first two keep their colours
