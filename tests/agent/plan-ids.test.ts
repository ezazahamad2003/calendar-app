import { describe, expect, it } from "vitest";

import { PlannerError, validatePlanIds } from "@/lib/voice/validate";
import { makeContext, makePlan, MON } from "./fixture";

/**
 * The [auto] cases from `cases.md` that live at the validator: invariant 5
 * (ids are checked in code, never trusted from the model) and the
 * clarification-versus-notes distinction.
 *
 * Every one of these is a question about what happens when the model gets it
 * wrong. The right answer is always a loud failure — a plan that half-applies
 * is worse than one that does not apply at all.
 */

const ctx = makeContext();

describe("invariant 5 — temp ids", () => {
  it("E3: rejects a forward reference to a row created later", () => {
    const plan = makePlan([
      { type: "create_task", projectId: "p1", name: "Pour", startDate: MON, assigneeId: "$c1" },
      { type: "create_contact", name: "Sam", email: "sam@example.com" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(PlannerError);
  });

  it("E4: accepts a backward reference to a row created earlier", () => {
    const plan = makePlan([
      { type: "create_contact", name: "Sam", email: "sam@example.com" },
      { type: "create_task", projectId: "p1", name: "Pour", startDate: MON, assigneeId: "$c0" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).not.toThrow();
  });

  it("E5: rejects a project temp id used as a contact", () => {
    const plan = makePlan([
      { type: "create_project", name: "Chico Flats" },
      { type: "assign_task", taskId: "t1", contactId: "$p0" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/contact/i);
  });

  it("E6: rejects a contact temp id used as a project", () => {
    const plan = makePlan([
      { type: "create_contact", name: "Sam" },
      { type: "create_task", projectId: "$c0", name: "Pour" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/project/i);
  });

  it("E7: rejects a task that depends on itself", () => {
    const plan = makePlan([
      { type: "create_task", projectId: "p1", name: "Pour", deps: ["$t0"] },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(PlannerError);
  });

  it("E8: rejects shifting a project this same plan is creating", () => {
    const plan = makePlan([
      { type: "create_project", name: "Chico Flats" },
      { type: "shift_project", projectId: "$p0", byDays: 5 },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(PlannerError);
  });

  it("E11: names the hallucinated id it refused", () => {
    const plan = makePlan([
      { type: "add_dependency", predecessorId: "t9-does-not-exist", successorId: "t2" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/t9-does-not-exist/);
  });

  it("accepts a plan whose ids are all real", () => {
    const plan = makePlan([
      { type: "move_task", taskId: "t1", startDate: MON },
      { type: "assign_task", taskId: "t1", contactId: "c1" },
      { type: "add_dependency", predecessorId: "t1", successorId: "t2" },
      { type: "update_contact", contactId: "c2", email: "dave@example.com" },
      { type: "update_project", projectId: "p1", name: "Chico Real Estate Ltd" },
      { type: "set_status", taskId: "t2", status: "done" },
      { type: "resize_task", taskId: "t1", durationDays: 3 },
      { type: "shift_task", taskId: "t2", byDays: -2 },
      { type: "shift_project", projectId: "p1", byDays: 5 },
      { type: "update_task", taskId: "t3", name: "Snag list" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).not.toThrow();
  });
});

describe("invariant 5 — Foreman never guesses an address", () => {
  it("E9: refuses to mail a contact with no address on file", () => {
    const plan = makePlan([
      { type: "send_email", contactIds: ["c2"], subject: "Tuesday", body: "You're on." },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/Dave has no email address/);
  });

  it("E10: refuses to mail a contact this plan creates without one", () => {
    const plan = makePlan([
      { type: "create_contact", name: "Sam" },
      { type: "send_email", contactIds: ["$c0"], subject: "Tuesday", body: "You're on." },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/Sam has no email address/);
  });

  it("E10b: allows it when the plan supplies the address", () => {
    const plan = makePlan([
      { type: "create_contact", name: "Sam", email: "sam@example.com" },
      { type: "send_email", contactIds: ["$c0"], subject: "Tuesday", body: "You're on." },
    ]);
    expect(() => validatePlanIds(plan, ctx)).not.toThrow();
  });
});

describe("clarification versus notes", () => {
  it("G3: a clarification strips the operations it arrived with", () => {
    const plan = makePlan(
      [
        { type: "move_task", taskId: "t1", startDate: MON },
        { type: "assign_task", taskId: "t1", contactId: "c1" },
      ],
      { clarification: "Two people called Alex — which one?" },
    );
    const out = validatePlanIds(plan, ctx);
    expect(out.operations).toHaveLength(0);
    expect(out.clarification).toContain("which one");
  });

  it("G4: strips them even though every id in them was real", () => {
    const plan = makePlan([{ type: "set_status", taskId: "t1", status: "done" }], {
      clarification: "Which framing did you mean?",
    });
    expect(validatePlanIds(plan, ctx).operations).toHaveLength(0);
  });

  it("G5: a note leaves the operations alone", () => {
    const plan = makePlan(
      [
        { type: "create_task", projectId: "p1", name: "Pour", startDate: MON },
        { type: "assign_task", taskId: "t1", contactId: "c1" },
      ],
      { notes: "Times of day were dropped — Foreman schedules whole days." },
    );
    const out = validatePlanIds(plan, ctx);
    expect(out.operations).toHaveLength(2);
    expect(out.notes).toContain("whole days");
  });
});
