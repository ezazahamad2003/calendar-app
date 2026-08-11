---
name: foreman-qa
description: Test Foreman end to end — static checks, the schedule engine, RLS, and the assistant's behaviour against a corpus of transcripts. Use when asked to test the app, run QA, check a release, verify the assistant plans correctly, or investigate a report that it "did the wrong thing".
---

# Testing Foreman

Foreman is a construction scheduling app whose headline feature is an assistant
you talk to. Most of its bugs have not been crashes — they have been the
assistant confidently doing the wrong thing and saying it did the right thing.
Test accordingly: static checks catch almost none of the interesting failures.

## The invariants

These are the properties that must hold. A violation of any one is a P1
regardless of how small the diff that caused it.

1. **Nothing writes without a confirm.** The assistant proposes; `applyPlan`
   is the only thing that writes, and only the Confirm button calls it. No
   tool may mutate. If a tool ever gains a write, that is the bug.
2. **The assistant never claims a completed action.** It says "that'll move
   framing", never "I've moved framing". Nothing is real until confirmed.
3. **It never describes a change it cannot express.** If there is no operation
   for what was asked, it must say so, not reach for the nearest one. This is
   what made "rename the job" create a second job.
4. **Adding is not moving.** "Add plumbing today" creates a task even when a
   similarly-named one exists. Only an explicit reference to an existing task
   plus a date change may move one.
5. **Ids are validated in code**, not trusted from the model. A hallucinated
   id fails; it never silently skips or invents a row.
6. **The preview comes from the schedule engine**, never from the model. Every
   date shown before confirming is `cascade()`'s output.
7. **`provider_connections` is unreachable by the client role.** RLS enabled,
   zero policies, grants revoked. Never add a policy.
8. **No notification about an undated task**, and one calendar event per task,
   not one per assignee.

## Layers, cheapest first

Run in this order. Stop and report as soon as a layer fails — a broken build
makes behavioural results meaningless.

```bash
pnpm typecheck
pnpm lint
pnpm vitest run --exclude "tests/rls/**"
pnpm build
```

`pnpm build` is not redundant with typecheck: it catches `"use server"`
violations (a server-actions file may only export async functions) that `tsc`
does not.

RLS tests need a database and will reset it — **never run them against
production**:

```bash
pnpm test:rls
```

## Behavioural testing — the part that matters

The assistant's behaviour is where the real defects live, and it cannot be
tested by running the loop (that needs a live model and costs money per case).
Test it at the seam instead.

**What you can test without a model:** take a transcript and the plan a model
*would* return, and assert the app handles it correctly — `planSchema` parsing,
`validatePlanIds` accepting or rejecting, `buildPreview` producing the right
diff. This catches every class of bug except "the model chose wrong".

**What needs a model:** whether the model picks `create_task` over `move_task`.
Only a human running the app catches this. Your job for these is to produce a
precise, checkable script — the exact words to say and the exact expected
outcome — not to run it.

### Writing a behavioural case

Every case needs all four parts. A case without an expected *rejection* is half
a case.

```
Say:      "add plumbing for Chico today"
Context:  a task named "Plumberry" already exists on Chico, dated Fri 14 Aug
Expect:   ONE create_task on Chico, dated today. Diff line tagged "New".
Must not: move, shift or rename Plumberry. No line tagged "Moved".
```

Bias every case toward the destructive misreading. The interesting question is
never "does it work" — it is "when it misunderstands, does it fail toward the
harmless option". Creating a duplicate is harmless; silently moving a crew
booking wastes a day on site.

### Where cases live

`tests/agent/cases.md`, grouped by the invariant each one defends. If it does
not exist, create it. When a real bug is found, add the case that would have
caught it *before* fixing the bug.

## Manual passes that need a person

Flag these clearly rather than attempting them:

- **The microphone.** Silence detection, auto-stop, live captions. Needs a real
  mic and a real consent prompt. Captions are Chrome/Edge only — verify Safari
  and Firefox degrade to the meter and stages rather than breaking.
- **OAuth.** Consent screens cannot be clicked headlessly. Test Outlook *and*
  Gmail; they share one code path, so a break in it breaks both.
- **Calendar writes.** Confirm a dated task, check the event appears, then move
  the task and check the *same* event moved rather than a second appearing.
  The update path is the one most likely to be wrong.

## Safety when testing against a real deployment

Confirming a plan **sends real email** and **writes to a real calendar**.

- Use contacts whose addresses you control. Never a real subcontractor.
- Prefer a throwaway org over the one with real jobs in it.
- Anything under `/outbox` marked queued has not sent yet; sent has.
- Reads are free — every question is safe to ask. Only Confirm has effects.

## Reporting

For each failure give: what you said, what you expected, what happened, and
which invariant it violates. If you can point at the file and line, do. Do not
fix anything unless asked — a QA pass that also rewrites the code cannot be
trusted about what it found.

State plainly what you did not test. "The mic is untested" is a useful result;
silence about it is not.
