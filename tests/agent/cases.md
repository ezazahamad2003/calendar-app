# Assistant behaviour — test cases

Each case is a transcript, the state it assumes, what must happen, and what must
**not**. The "must not" line is the point of the case: every bug found so far
has been the assistant doing something plausible that nobody asked for.

Seeded from bugs that actually shipped. Add a case when you find a new one —
before fixing it.

Each case is tagged:

- **[auto]** — assertable against the schema, the validator or the preview
  builder with no live model. These live in `plan-ids.test.ts` and
  `preview.test.ts` beside this file.
- **[manual]** — needs a real model actually choosing an operation, or a real
  provider account. Run these by hand; the case is the script.

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

### A4. "Book someone on a day" is still adding *[manual]*
- **Context:** "Framing" exists on Chico, dated Tue 18 Aug, Alex already on it
- **Say:** "book Alex on Thursday"
- **Expect:** a `create_task` dated Thursday with Alex assigned
- **Must not:** `move_task` Framing to Thursday. Alex's existing Tuesday booking
  must still read Tue 18 Aug in the diff

### A5. Longer, not later *[manual]*
- **Context:** "Framing" starts Mon 17 Aug, two days
- **Say:** "make framing three days instead of two"
- **Expect:** one `resize_task`, `durationDays: 3`; the start date unchanged
- **Must not:** `move_task`, `shift_task`, or a second framing task. The start
  must not move to absorb the extra day

### A6. The whole job slips *[manual]*
- **Context:** Chico has fifteen dated tasks; a second job also has tasks
- **Say:** "the whole Chico job slips a week"
- **Expect:** one `shift_project`, `byDays: 5` on a five-day calendar
- **Must not:** fifteen `move_task`s; must not touch the other job's tasks

### A7. A backward project shift lands on a working day *[auto]*
- **Context:** a task on Fri 21 Aug, five-day week
- **Plan:** `shift_project` with `byDays: -5`
- **Expect:** Fri 14 Aug
- **Must not:** Sat/Sun, and must not round *forward* into the week it came from
  — a shift back that lands later than asked is the destructive misread

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

### B4. Deleting a task *[manual]*
- **Say:** "delete the plumbing task"
- **Context:** "Plumbing" exists on Chico, dated
- **Expect:** it says plainly there is no way to delete yet
- **Must not:** `set_status: done` as a substitute, `resize_task` to 1 day, or
  `move_task` it far into the future to get it out of the way. Any of those
  leaves a task the user believes is gone

### B5. Taking someone off a job *[manual]*
- **Say:** "take Tom off the framing"
- **Context:** Tom is assigned to Framing
- **Expect:** it says it cannot remove an assignment yet
- **Must not:** `assign_task` someone else onto it, and must not create a
  replacement task without Tom. Tom must still be on Framing afterwards

### B6. Removing a dependency *[manual]*
- **Say:** "framing doesn't need to wait for the slab any more"
- **Expect:** it says it cannot remove a link yet
- **Must not:** `add_dependency` in the reverse direction, and must not
  `add_dependency` with a large negative lag to fake the link away — both leave
  the original link in place and add a second one

### B7. Putting a job on hold *[manual]*
- **Say:** "put Chico on hold"
- **Expect:** `update_project` with `status: on_hold` and nothing else set
- **Must not:** `create_project`; must not blank the client or job number

### B8. Marking work done *[manual]*
- **Say:** "the inspection passed"
- **Expect:** `set_status` on the inspection, `done`
- **Must not:** move it, resize it, or mark the whole project complete

### B9. Something outside the app entirely *[manual]*
- **Say:** "email me a Gantt chart as a PDF"
- **Expect:** a plain reply that it cannot
- **Must not:** a `send_email` operation containing a made-up description of an
  attachment that does not exist

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

### C5. Assignment to undated work sends nothing *[auto]*
- **Plan:** `assign_task` where the task has no start date
- **Expect:** the assignment appears in the diff; **zero** notifications
- **Must not:** a "Sends on confirm" line, which would become "You're scheduled
  for X: not yet scheduled"

### C6. The notified dates come from the engine, not the plan *[auto]*
- **Plan:** `move_task` to Sat 22 Aug plus `assign_task` on the same task
- **Expect:** one notification reading **Mon 24 Aug** — the cascade's normalised
  date
- **Must not:** the Saturday the plan named. The diff and the email must never
  disagree

### C7. Said twice, told once *[auto]*
- **Plan:** `create_task` with `assigneeId` **and** an `assign_task` naming the
  same person and task
- **Expect:** one notification
- **Must not:** two emails for one day's work

### C8. Assigned but unreachable *[auto]*
- **Plan:** `assign_task` of a dated task to a contact with `hasEmail: false`
- **Expect:** the assignment shown; **no** notification line
- **Must not:** promise a send that cannot happen

### C9. A dead connection mid-plan *[manual]*
- **Context:** a connected account whose grant has been revoked
  (`provider_connections.status = 'needs_reauth'`)
- **Do:** confirm a plan that assigns someone to a dated task
- **Expect:** the outbox row reads **failed**, with a message saying to
  reconnect; the confirmation does not claim anyone was notified
- **Must not:** the row reading `sent` with a `mock-` id against it. A message
  recorded as sent that never left is worse than one that failed loudly
- *Shipped broken: the stale grant fell back to the mock client.*

### C10. No connection at all *[manual]*
- **Context:** a fresh environment, no provider connected
- **Do:** confirm a plan that assigns someone to a dated task
- **Expect:** "notices simulated" in the confirmation; nothing on any calendar
- **Must not:** the word "notified" without "simulated"

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

### E3. A forward temp reference fails *[auto]*
- **Plan:** `create_task` at index 0 with `assigneeId: "$c1"`, `create_contact`
  at index 1
- **Expect:** rejected — the batch inserts in order, so `$c1` resolves to
  nothing when the task is written
- **Must not:** accept it and insert the task with a null assignee. A silently
  unassigned task is a person who never gets told

### E4. A backward temp reference is legal *[auto]*
- **Plan:** `create_contact` at index 0, `create_task` at index 1 with
  `assigneeId: "$c0"`
- **Expect:** accepted, and the diff names the new contact
- **Must not:** reject it — this is how "start a job with Dave on plumbing"
  works at all

### E5. A temp id of the wrong kind fails *[auto]*
- **Plan:** `create_project` at index 0, then `assign_task` with
  `contactId: "$p0"`
- **Expect:** rejected as an unknown contact
- **Must not:** accept it because "$p0" happens to exist as *some* temp id.
  Downstream that becomes an assignment row pointing at a project
- *Was broken: all temp ids shared one set with no kind attached.*

### E6. A task's project must be a project *[auto]*
- **Plan:** `create_contact` at index 0, `create_task` at index 1 with
  `projectId: "$c0"`
- **Expect:** rejected
- **Must not:** create the task under a contact id

### E7. A task cannot depend on itself *[auto]*
- **Plan:** `create_task` at index 0 with `deps: ["$t0"]`
- **Expect:** rejected — its own temp id does not exist until after it is made
- **Must not:** reach the cascade, which would throw a cycle error much later

### E8. Nothing to shift *[auto]*
- **Plan:** `create_project` at index 0, `shift_project` on `"$p0"` at index 1
- **Expect:** rejected — a project created in this same plan has no tasks yet
- **Must not:** silently shift nothing and report success

### E9. Mailing someone with no address *[auto]*
- **Plan:** `send_email` to a contact with `hasEmail: false`
- **Expect:** a `PlannerError` naming the person and the Crew page
- **Must not:** queue the message anyway

### E10. Mailing a contact this plan is creating without one *[auto]*
- **Plan:** `create_contact` with no email at index 0, `send_email` to `"$c0"`
- **Expect:** rejected for the same reason as E9
- **Must not:** pass because there is no row to check yet. That gap is exactly
  where an unsendable message gets written
- *Was broken: the check only ran for contacts already in the context.*

### E11. A hallucinated id in a dependency *[auto]*
- **Plan:** `add_dependency` with a predecessor id that is not in the context
- **Expect:** rejected, the message quoting the id
- **Must not:** drop the operation and apply the rest

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

---

## Clarification versus notes

The distinction is load-bearing: a clarification cancels everything, a note
does not. Collapsing them is what made "a job with times on it" create nothing.

### G3. A clarification with operations attached collapses *[auto]*
- **Plan:** a clarification *and* two valid operations
- **Expect:** the operations are stripped; the preview is empty and the
  clarification is shown
- **Must not:** half-execute. Whatever it was unsure about could be the thing
  that makes those operations wrong

### G4. The collapse does not depend on the ids being bad *[auto]*
- **Plan:** a clarification plus operations whose ids are all real
- **Expect:** still stripped
- **Must not:** apply them because they happened to validate

### G5. A note leaves the operations alone *[auto]*
- **Plan:** `notes` plus two valid operations
- **Expect:** both operations survive validation and reach the preview
- **Must not:** be treated as a clarification

### G6. Times of day alongside a real request *[manual]*
- **Say:** "pour the slab 7am Tuesday and tell Alex"
- **Expect:** a task on Tuesday, Alex notified, and a **note** that the time was
  dropped. Confirm stays available
- **Must not:** a clarification, which would create nothing and send nothing

---

## Dependencies, lag and milestones

### I1. A dependency loop is refused by name *[auto]*
- **Context:** A → B already linked
- **Plan:** `add_dependency` B → A
- **Expect:** a `PlannerError` naming both tasks, nothing changed
- **Must not:** a preview showing dates. There is no correct schedule to show

### I2. FS lag counts working days *[auto]*
- **Context:** A starts Mon 17 Aug, 1 day; B linked FS with `lagDays: 2`
- **Expect:** B lands Thu 20 Aug
- **Must not:** count calendar days, and must not land on a weekend

### I3. Negative lag is a lead, not a shift *[auto]*
- **Context:** A starts Mon 17 Aug, 3 days (finishing Wed 19); B linked FS with
  `lagDays: -1`
- **Expect:** B starts Wed 19 Aug — the day A finishes, one working day earlier
  than a plain FS link would put it
- **Must not:** move A. A lead pulls the successor in; the predecessor is fixed

### I4. A cascade is labelled as a cascade *[auto]*
- **Plan:** `move_task` on a predecessor
- **Expect:** the successor appears with `direct: false` (rendered "Knock-on")
- **Must not:** present a knock-on as something the user asked for — that is how
  an unwanted move gets waved through

### I5. Start-to-start moves together *[auto]*
- **Context:** A and B linked SS, no lag
- **Plan:** `move_task` A to Wed 19 Aug
- **Expect:** B also Wed 19 Aug
- **Must not:** push B to the day after A finishes

### I6. A milestone has no duration *[auto]*
- **Plan:** `create_task` with `isMilestone: true, durationDays: 5`
- **Expect:** one day; start equals end in the diff
- **Must not:** occupy five days on the calendar

### I7. A new task with a predecessor and no date *[auto]*
- **Plan:** `create_task` with `deps: [existing task]` and `startDate: null`
- **Expect:** it appears in the diff tagged **New**, dated by the cascade off
  its predecessor
- **Must not:** appear undated, and must not appear at all if it were silently
  dropped

### I8. Resizing a predecessor pushes its successor *[auto]*
- **Context:** A Mon 17 Aug 2 days, B linked FS
- **Plan:** `resize_task` A to 4 days
- **Expect:** A's new length is stated in the diff, **and** B moves out
- **Must not:** an empty diff. A resize the user cannot confirm is a resize that
  never happens
- *Was broken: the engine compared A's new end against its new end.*

### I9. "Right after" is a link, not a date *[manual]*
- **Say:** "the inspection goes right after drywall"
- **Expect:** `add_dependency` drywall → inspection
- **Must not:** `move_task` the inspection to the day after drywall's current
  end, which silently unlinks the two and breaks the next time drywall moves

---

## Invariant 6 — the preview is the whole plan

Everything the plan will do has to be visible before Confirm, and every date in
it has to come out of the engine. A diff that renders empty hides its own
Confirm button, so a plan that produces one cannot be applied at all.

### J1. A task with no date is still a change *[auto]*
- **Plan:** `create_task` with `startDate: null` and no dependencies
- **Expect:** the preview is **not** empty; the task is listed as new work with
  no date
- **Must not:** an empty preview. "Add a plumbing task, I'll date it later"
  becomes unconfirmable
- *Was broken: an undated task never reaches the cascade, and nothing else
  looked for it.*

### J2. A resize is a change *[auto]*
- **Plan:** `resize_task` on a dated task with no dependents
- **Expect:** the preview is **not** empty and states the old and new lengths
- **Must not:** an empty preview
- *Was broken.*

### J3. A weekend date in the plan is normalised *[auto]*
- **Plan:** `create_task` with `startDate` on a Saturday
- **Expect:** the diff shows the following Monday
- **Must not:** echo the model's Saturday back. The preview is the engine's
  output, never the model's

### J4. A holiday is normalised too *[auto]*
- **Context:** calendar with a holiday on Mon 17 Aug
- **Plan:** `move_task` to Mon 17 Aug
- **Expect:** the diff shows Tue 18 Aug
- **Must not:** the holiday

### J5. A new task on an ordinary working day *[auto]*
- **Plan:** `create_task` dated Mon 17 Aug, a normal working day
- **Expect:** one diff line tagged **New**, dated Mon 17 Aug; the preview is not
  empty, so Confirm is offered
- **Must not:** an empty preview. This is the single most common thing anyone
  asks the assistant to do, and an empty diff hides its own Confirm button
- *Was broken: a task that does not exist yet was fed to the engine already
  carrying the date being asked for, so the engine compared that date against
  itself and reported no change. It only ever showed up when the date needed
  normalising off a weekend.*

### J6. The assignee of a brand-new task still gets told *[auto]*
- **Plan:** `create_task` dated Mon 17 Aug with `assigneeId`
- **Expect:** one notification
- **Must not:** silence. Same root cause as J5 — no diff line meant no resolved
  date, and no resolved date meant no notification

### J7. An update that changes nothing *[auto]*
- **Plan:** `update_project` with every field null
- **Expect:** an empty preview, so the UI offers Dismiss rather than Confirm
- **Must not:** a Confirm that writes an UPDATE with no columns in it

---

## Between propose and confirm

The plan crosses to the client and comes back. The world can move underneath it.

### K1. The task went away *[manual]*
- **Do:** propose "push framing back two days", delete Framing in another tab,
  then Confirm
- **Expect:** "The schedule changed since this plan was made. Ask again."
- **Must not:** apply the rest of the plan; must not report success

### K2. The person went away *[manual]*
- **Do:** propose an assignment, delete the contact elsewhere, then Confirm
- **Expect:** "That person no longer exists. Ask again."
- **Must not:** create the task and skip the assignment

### K3. The job left the active set *[manual]*
- **Do:** propose a task on Chico, mark Chico complete elsewhere, then Confirm
- **Expect:** "That project no longer exists. Ask again."
- **Must not:** insert an orphan task onto a completed job

### K4. The dates moved underneath it *[manual]*
- **Do:** propose "move framing to Friday", drag its predecessor two weeks out
  by hand, then Confirm
- **Expect:** what is written matches a fresh cascade over current data, not the
  dates shown in the old diff
- **Must not:** write the stale preview's dates

### K5. Confirm twice *[manual]*
- **Do:** confirm a plan, then confirm the same proposal again
- **Expect:** the second is refused, or is a no-op
- **Must not:** two tasks, two emails, two calendar events

---

## Conversation, continued

### F4. A contradiction later in the turn *[manual]*
- **Say:** "move framing to Friday" → then "no, leave framing where it is, move
  drywall instead"
- **Expect:** one proposal, drywall only
- **Must not:** include framing in the new proposal, and must not treat the
  first proposal as still standing

### F5. A stale reference after a discard *[manual]*
- **Do:** propose a move, Discard, then say "make that Thursday"
- **Expect:** it asks what "that" refers to, or re-proposes the whole change
  from scratch
- **Must not:** describe the discarded change as though it exists

### F6. A question about a confirmed change *[manual]*
- **Do:** confirm "push framing back two days", then ask "when's framing?"
- **Expect:** the new dates, in prose
- **Must not:** the old dates, and must not re-propose the same move

### F7. Undo *[manual]*
- **Do:** confirm a move, then say "undo that"
- **Expect:** it reads `recent_changes` and **proposes** the reverse
- **Must not:** say "I've undone it" — an undo is a change like any other and
  needs its own Confirm

### F8. Did it send? *[manual]*
- **Do:** confirm an assignment, then ask "did Alex get told?"
- **Expect:** an answer from `list_messages`, reporting the row's real status
- **Must not:** assert it sent without looking, and must not report a simulated
  send as a real one
