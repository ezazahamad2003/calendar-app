---
name: foreman-qa
description: Test Foreman end to end — static checks, the schedule engine, the read-only share view, and the assistant's behaviour against a corpus of transcripts. Use when asked to test the app, run QA, check a release, verify the assistant plans correctly, or investigate a report that it "did the wrong thing".
---

# Testing Foreman

Foreman is a construction schedule for one job, driven by an assistant you talk
to. There is no sign-in: the main URL is open, and `/s/<token>` is a read-only
view for the crew. Most of its bugs have not been crashes — they have been the assistant
confidently doing the wrong thing and saying it did the right thing, or the
schedule quietly reshaping itself. Test accordingly: static checks catch almost
none of the interesting failures.

## The invariants

A violation of any one is a P1 regardless of how small the diff that caused it.

1. **Nothing writes without a confirm.** `commitPlan()` is the only writer, and
   only the Confirm button reaches it. The assistant has exactly one tool and it
   returns a proposal. If a tool ever gains a write, that is the bug.
2. **The assistant never claims a completed action.** "That'll move the
   downspouts", never "I've moved the downspouts". Nothing is real until
   confirmed. It also must not ask "shall I proceed?" — the app asks, with a
   diff, and asking twice makes him say it twice.
3. **It never describes a change it cannot express**, and never names an
   activity that is not in its context. Inventing a consequence in prose is
   worse than silence, because he reads the line and not the diff.
4. **Adding is not moving.** "Add downspouts Tuesday" creates an activity even
   when a similarly-named one exists. Only an explicit reference to an existing
   activity plus a date change may move one.
5. **Ids are validated in code**, not trusted from the model. A hallucinated id
   fails the *whole* plan; it never silently skips one operation.
6. **The preview comes from the schedule engine**, never from the model. Every
   date shown before confirming is `applyOperations` → `cascade()`.
7. **An undated activity is never given a date by a cascade.** Half the chart is
   undated on purpose. Dating it from a predecessor is a guess that mails a
   subcontractor a booking nobody made.
8. **The seed is a fixed point.** Cascading a schedule nobody touched moves
   nothing. `tests/playbook.test.ts` asserts it.
9. **No notification about an undated activity**, no guessed email address, and
   one message per trade rather than one per activity.
10. **The share page cannot write and cannot spend money.** No microphone, no
    Confirm, no addresses, no history. It does not import the assistant at all.
    With the passcode gone this is the app's only access control, so a
    regression here is a P1 rather than a nuisance.

## Layers, cheapest first

Stop and report as soon as a layer fails — a broken build makes behavioural
results meaningless.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm build` is not redundant with `typecheck`: it catches `"use server"`
violations (a server-actions file may only export async functions) that `tsc`
does not.

There is no database and no RLS suite any more. `tests/store.test.ts` covers
what the database used to: a malformed document, a broken reference, and two
writers racing.

## Behavioural testing — the part that matters

The assistant's behaviour is where the real defects live, and running the loop
needs a live model and costs money per case. Test at the seam instead.

**Testable without a model:** take a transcript and the plan a model *would*
return, and assert the app handles it correctly — `planSchema` parsing,
`validatePlan` accepting or rejecting, `buildPreview` producing the right diff,
`composeNotifications` deciding who is told. That catches every class of bug
except "the model chose wrong". These live in `tests/safety.test.ts`,
`tests/notify.test.ts` and `tests/playbook.test.ts`, off the shared fixture in
`tests/fixture.ts` — which is the client's real chart, with its real awkward
shapes, not a synthetic toy.

**Needs a model:** whether it picks `add_activity` over `move_activity`, whether
it captures a reason, whether it proposes instead of asking permission. Only a
person running the app catches these. Produce a precise, checkable script — the
exact words to say and the exact expected outcome — rather than running it.

### Writing a behavioural case

Every case needs all four parts. A case without an expected *rejection* is half
a case.

```
Say:      "add downspouts for Tuesday"
Context:  "Install Downspouts" already exists, dated Wed 26 Aug
Expect:   ONE add_activity, dated Tuesday. Diff line tagged "New".
Must not: move, shift or rename the existing one. No line tagged "Moved".
```

Bias every case toward the destructive misreading. The question is never "does
it work" — it is "when it misunderstands, does it fail toward the harmless
option". A duplicate row is harmless; silently moving a crew booking wastes a
day on site.

## Manual passes that need a person

Flag these clearly rather than attempting them:

- **The microphone.** Press-to-start, press-to-stop, silence auto-stop, the
  level ring, live captions. Needs a real mic and a real consent prompt.
  Captions are Chrome/Edge only — check Safari and Firefox fall back to the
  meter rather than breaking.
- **Real email.** With `RESEND_API_KEY` set, a confirmed change sends for real.
  Use an address you control. Check the reason appears above the dates.
- **The share link.** Open it in a private window and confirm there is no
  microphone, no Confirm button and no addresses anywhere in the page source.
- **The phone.** The chart is replaced by the agenda below 900px. Check there is
  no horizontal page scroll at 375px and the talk button clears the home bar.

## Safety when testing against a real deployment

Confirming a plan **sends real email** if `RESEND_API_KEY` is set.

- Unset it, or set `FEATURE_SEND_EMAIL=false`, and everything is composed,
  recorded and shown without sending. Prefer that.
- Use contacts whose addresses you control. Never a real subcontractor.
- Reads are free — every question is safe to ask. Only Confirm has effects.
- History shows exactly what was sent, what was skipped, and why.

## Reporting

For each failure: what you said, what you expected, what happened, and which
invariant it violates. Point at the file and line where you can. Do not fix
anything unless asked — a QA pass that also rewrites the code cannot be trusted
about what it found.

State plainly what you did not test. "The mic is untested" is a useful result;
silence about it is not.
