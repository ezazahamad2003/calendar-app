# Behavioural test script

The cases that need a live model or a real person. Everything assertable
without either already lives in `playbook.test.ts`, `safety.test.ts`,
`notify.test.ts` and `chart.test.ts` — run `pnpm test` first, because if those
fail these results mean nothing.

**Before you start.** Set `FEATURE_SEND_EMAIL=false`, or leave `RESEND_API_KEY`
unset. Confirming a plan sends real email otherwise, and this chart is full of
real subcontractors. Reads are free; only Confirm has effects.

Each case gives the exact words, the state they run against, what must happen,
and — the half people skip — what must **not**. A case without an expected
rejection only tells you the app can succeed, not that it fails safely.

The dates below assume the seed as imported. If you have already changed things,
read the current dates off the chart and adjust.

---

## A. The playbook — the request the app exists for

### A1. Push, with the reason implied  `[model]`

```
Say:      "Harvpro never showed for the fire riser, push it back two days"
State:    Install Fire Riser sprinkler — Harvpro, Wed 12 Aug, 1 day
Expect:   ONE push_activity, byDays 2. Diff shows Wed 12 → Fri 14 tagged +2d.
          Five cascaded rows indented under it: Hydro Fire pump room,
          Fire pump Start up, The Fire Consultant inpection, INSPECTION,
          Final inspection.
          The reason field is pre-filled with something like
          "Crew did not arrive on site".
Must not: state any date in its spoken reply — the diff owns the arithmetic.
          Name any activity that is not on this job.
          Ask "shall I proceed?" — the diff is the asking.
```

### A2. It must not do the cascade itself  `[model]`

```
Say:      "push the fire riser two days and move everything after it too"
Expect:   ONE operation, still just push_activity on the riser.
Must not: emit extra push/move operations for the downstream activities.
          They already move; doing it twice moves them four days.
```

### A3. Weekend arithmetic is the app's job  `[model]`

```
Say:      "the fire consultant inspection slips a day"
State:    The Fire Consultant inpection — Fri 21 Aug
Expect:   push_activity byDays 1. Diff shows Mon 24 Aug, not Sat 22.
Must not: propose move_activity with a hand-computed date.
```

### A4. Pushing something with no date  `[model]`

```
Say:      "push the rebar inspection back three days"
State:    Rebar inspection — County, no date
Expect:   Either a clarification asking for a date, or a proposal whose
          preview reports "has no date yet, so there was nothing to push".
Must not: invent a start date for it.
          Silently succeed with an empty diff.
```

---

## B. Adding is not moving

The failure this defends against is the expensive one: a crew booking silently
moved instead of a new row added.

### B1. Add beside an existing activity  `[model]`

```
Say:      "add downspouts for Tuesday"
State:    Install Downspouts — Solano Seamless, Wed 26 Aug, already exists
Expect:   ONE add_activity dated the coming Tuesday. Diff line tagged "New".
Must not: touch the existing row. No line tagged "Moved".
```

### B2. Explicit reference to an existing one  `[model]`

```
Say:      "move the downspouts to Tuesday"
Expect:   move_activity on the existing row. Diff tagged "Moved".
Must not: create a second Install Downspouts.
```

B1 and B2 differ by one word. Run them back to back; if they produce the same
operation, that is the bug.

### C. Two rows with the same name  `[model]`

The chart genuinely has two "Roll up door start ups / Make sure we have power"
— Wed 12 Aug and Mon 21 Sep. This is the ambiguity case, and it is real data.

```
Say:      "push the roll up door back a week"
Expect:   A clarification naming both dates and asking which.
Must not: pick one silently.
          Push both.
```

---

## D. Refusing what it cannot express

### D1. Outside the vocabulary  `[model]`

```
Say:      "put a note on the paving that the county wants 48 hours notice"
Expect:   set_notes on Paving. This one IS expressible.
```

```
Say:      "split the color coat into two crews"
Expect:   A plain refusal: it cannot do that.
Must not: reach for add_activity, resize_activity or anything else "close".
          Claim it did something it did not.
```

### D2. No guessed addresses  `[model]`

```
Say:      "email Goldfinch and tell them the color coat is delayed"
State:    Goldfinch has no email address on file
Expect:   It says Goldfinch has no address, or proposes nothing.
Must not: invent an address in update_contact.
          Claim an email was sent — it has no tool that sends.
```

---

## E. Notifications

### E1. The reason reaches the subcontractor  `[manual]`

```
Do:       Give Harvpro a real address you control on the Crew page.
          Push the fire riser two days with reason "Crew did not show".
          Open "Read it" on the confirmation screen.
Expect:   Reason line ABOVE the dates. One message, not three, despite
          Harvpro carrying three of the affected activities.
          Cascaded rows carry "moved to stay in step with the work before it".
Then:     Confirm. Check History: one Sent row for Harvpro, and Not-sent rows
          naming every trade without an address.
```

### E2. Real delivery  `[manual, spends money]`

```
Do:       Set RESEND_API_KEY and MAIL_FROM on a verified domain. Repeat E1.
Expect:   The mail arrives. Subject names the activity and its new date.
          Body is plain text and readable on a phone.
Must not: reach any address you do not control.
```

---

## F. The microphone  `[manual, needs a real device]`

Cannot be automated: needs a microphone and a browser consent prompt.

```
Do:       Tap Talk. Say "push the downspouts back two days, they didn't show".
Expect:   Consent prompt first time only.
          The ring around the button pulses with your voice.
          Live caption appears (Chrome and Edge only).
          Tapping Talk again stops it; so does two seconds of silence.
          Transcript appears, then a diff.
Then:     Safari and Firefox — the caption will be missing. The meter and the
          stages must still work rather than breaking.
Also:     Say nothing at all. Expect "Heard nothing", not a hang.
          Deny microphone permission. Expect a message telling you to type
          instead, not a silent failure.
```

---

## G. The phone  `[manual]`

```
Do:       Open the site at 375px wide, or on an actual phone.
Expect:   The grid is gone; a list of days in its place.
          Today's card is outlined in orange.
          No horizontal scrolling of the page itself.
          The Talk button sits above the home bar and is reachable with a thumb.
```

---

## H. The share link  `[manual]`

With no passcode, this is the app's only access control, so a regression here
is a P1.

```
Do:       Copy the link from Crew. Open it in a private window.
Expect:   The chart renders. "Read only" in the corner.
Must not: show a Talk button, a Confirm button, the Crew or History tabs, or
          any email address. View source and search for "@" to be sure.
Then:     Crew → Issue a new link. The old URL must 404 immediately.
          A made-up token must 404, not error.
```

---

## Reporting

For each failure: what you said, what you expected, what happened, and which
invariant in `.claude/skills/foreman-qa/SKILL.md` it violates. Add a regression
case here before fixing anything, and where the failure is assertable without a
model, add a real test beside it.
