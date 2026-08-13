import { describe, expect, it } from "vitest";

import { soundsLikeACommitment } from "@/lib/assistant/agent";
import { planSchema } from "@/lib/ops/schema";
import { validatePlan } from "@/lib/ops/validate";
import { buildPreview } from "@/lib/ops/preview";
import { doc, ID } from "./fixture";

/**
 * The invariants that stop the assistant from confidently doing the wrong
 * thing.
 *
 * These are not tests of the model — a model cannot be pinned down by a unit
 * test. They are tests of the code that sits between the model and the
 * schedule, which is what actually has to hold when the model is wrong.
 */

const plan = (operations: unknown[], extra: Record<string, unknown> = {}) => ({
  summary: "test",
  operations,
  confidence: "high" as const,
  ...extra,
});

describe("ids are checked, not trusted", () => {
  it("rejects an activity id that does not exist", () => {
    const d = doc();
    const parsed = planSchema.parse(
      plan([{ type: "push_activity", taskId: "framing-that-never-existed", byDays: 2 }]),
    );

    const result = validatePlan(d, parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/does not exist/i);
  });

  it("fails the whole plan rather than skipping the bad operation", () => {
    // The failure this defends against: "push the riser and the roofing back
    // two days" quietly becoming "push the riser back two days", reported as
    // success, with the roofers turning up on a day nobody expects.
    const d = doc();
    const parsed = planSchema.parse(
      plan([
        { type: "push_activity", taskId: ID.fireRiser, byDays: 2 },
        { type: "push_activity", taskId: "invented", byDays: 2 },
      ]),
    );

    const result = validatePlan(d, parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(1);
  });

  it("rejects an unknown contact and an unknown section", () => {
    const d = doc();
    const parsed = planSchema.parse(
      plan([
        { type: "update_contact", contactId: "nobody", email: "x@example.test" },
        {
          type: "add_activity",
          name: "Something",
          sectionId: "no-such-section",
          durationDays: 1,
          after: [],
        },
      ]),
    );

    const result = validatePlan(d, parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(2);
  });

  it("accepts a plan whose ids are all real", () => {
    const d = doc();
    const parsed = planSchema.parse(
      plan([{ type: "push_activity", taskId: ID.fireRiser, byDays: 2 }]),
    );
    expect(validatePlan(d, parsed).ok).toBe(true);
  });
});

describe("dependency loops", () => {
  it("refuses a link that would close a loop, naming the activities", () => {
    const d = doc();
    // The riser already leads to the hydro test; the reverse closes it.
    const parsed = planSchema.parse(
      plan([
        {
          type: "add_dependency",
          predecessorId: ID.hydro,
          successorId: ID.fireRiser,
          depType: "FS",
          lagDays: 0,
        },
      ]),
    );

    const result = validatePlan(d, parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toMatch(/depend on each other/i);
      // Named by activity, not by id — the error is read by a contractor.
      expect(result.problems[0]).toMatch(/Hydro Fire pump room/);
    }
  });

  it("catches a loop formed by two operations that are each fine alone", () => {
    const d = doc();
    const parsed = planSchema.parse(
      plan([
        {
          type: "add_dependency",
          predecessorId: ID.consultant,
          successorId: ID.electrical,
          depType: "FS",
          lagDays: 0,
        },
        {
          type: "add_dependency",
          predecessorId: ID.electrical,
          successorId: ID.fireRiser,
          depType: "FS",
          lagDays: 0,
        },
      ]),
    );

    expect(validatePlan(d, parsed).ok).toBe(false);
  });

  it("refuses to remove a link that is not there", () => {
    const d = doc();
    const parsed = planSchema.parse(
      plan([
        {
          type: "remove_dependency",
          predecessorId: ID.colorCoat,
          successorId: ID.finalInspection,
        },
      ]),
    );
    expect(validatePlan(d, parsed).ok).toBe(false);
  });
});

describe("a question and a change are mutually exclusive", () => {
  it("rejects a plan that asks something and also proposes changes", () => {
    const d = doc();
    const parsed = planSchema.parse(
      plan([{ type: "push_activity", taskId: ID.fireRiser, byDays: 2 }], {
        clarification: "Which inspection did you mean?",
      }),
    );

    const result = validatePlan(d, parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/one or the other/i);
  });

  it("accepts a pure question with no operations", () => {
    const d = doc();
    const parsed = planSchema.parse(
      plan([], { clarification: "Which inspection did you mean?" }),
    );
    expect(validatePlan(d, parsed).ok).toBe(true);
  });
});

describe("the schema is the vocabulary", () => {
  it("has no operation that sends mail directly", () => {
    // Notifying is a consequence of a date changing, decided by the app. If
    // the model could compose and address a message itself, it could tell a
    // subcontractor anything at all.
    const shapes = planSchema.shape.operations.element.options.map(
      (o) => (o.shape.type as { value: string }).value,
    );
    expect(shapes).not.toContain("send_email");
    expect(shapes.some((s) => /mail|send|notify/i.test(s))).toBe(false);
  });

  it("rejects a push of zero days", () => {
    const parsed = planSchema.safeParse(
      plan([{ type: "push_activity", taskId: ID.fireRiser, byDays: 0 }]),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects an email address that is not one", () => {
    const parsed = planSchema.safeParse(
      plan([{ type: "add_contact", name: "Tom", email: "tom at northstate" }]),
    );
    expect(parsed.success).toBe(false);
  });

  it("caps the number of operations in one plan", () => {
    const parsed = planSchema.safeParse(
      plan(
        Array.from({ length: 25 }, () => ({
          type: "push_activity",
          taskId: ID.fireRiser,
          byDays: 1,
        })),
      ),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("every change is visible before it is confirmed", () => {
  it("shows a rename, which moves no dates", () => {
    const d = doc();
    const preview = buildPreview(d, {
      summary: "Fix the spelling",
      reason: null,
      operations: [
        { type: "rename_activity", taskId: ID.consultant, name: "Fire consultant inspection" },
      ],
    });
    expect(preview.empty).toBe(false);
    expect(preview.lines.some((l) => l.tag === "Renamed")).toBe(true);
  });

  it("shows a status change", () => {
    const d = doc();
    const preview = buildPreview(d, {
      summary: "Mark it done",
      reason: null,
      operations: [{ type: "set_status", taskId: ID.fireRiser, status: "done" }],
    });
    expect(preview.lines.some((l) => l.tag === "Status")).toBe(true);
  });

  it("shows a removal as a removal", () => {
    const d = doc();
    const preview = buildPreview(d, {
      summary: "Drop it",
      reason: null,
      operations: [{ type: "remove_activity", taskId: ID.fireRiser }],
    });
    expect(preview.lines.some((l) => l.tag === "Removed")).toBe(true);
  });

  it("reports an empty preview when nothing would change", () => {
    const d = doc();
    const preview = buildPreview(d, {
      summary: "No-op",
      reason: null,
      operations: [
        { type: "move_activity", taskId: ID.fireRiser, startDate: "2026-08-12" },
      ],
    });
    expect(preview.empty).toBe(true);
  });
});

describe("the commitment backstop", () => {
  // The most damaging thing the assistant can do is say "I'll add downspouts
  // for Tuesday" without calling propose_changes: he puts the phone down and
  // nothing has happened. The prompt forbids it; this is what catches it when
  // the model does it anyway.
  it("spots a reply that promises a change", () => {
    for (const reply of [
      "I'll add Install Downspouts for Tuesday, August 18th.",
      "I've moved the fire riser back two days.",
      "I have pushed the downspouts.",
      "I will book Whirco for Friday.",
      "I'm adding the punch list walk now.",
      "Moved it to Tuesday.",
      "Done.",
      "Consider it done.",
      "That's booked.",
    ]) {
      expect(soundsLikeACommitment(reply), reply).toBe(true);
    }
  });

  it("leaves proposals and answers alone", () => {
    for (const reply of [
      "That'll push the fire riser back two days.",
      "That would move the downspouts to Tuesday.",
      "Here's what that would change — have a look before confirming.",
      "The downspouts are booked for Wed 26 Aug with Solano Seamless.",
      "Nothing is scheduled for that week.",
      "Harvpro has no email address on file.",
      // A question is a different failure, and the prompt handles it.
      "Which roll up door did you mean — the 12th or the 21st?",
      "Shall I move it?",
    ]) {
      expect(soundsLikeACommitment(reply), reply).toBe(false);
    }
  });
});
