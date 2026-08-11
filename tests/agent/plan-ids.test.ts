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

describe("invariant 3 — no operation for it means no operation", () => {
  it("I11: a milestone has no length to change", () => {
    const milestones = makeContext();
    milestones.tasks[0].isMilestone = true;
    milestones.tasks[0].durationDays = 1;
    const plan = makePlan([{ type: "resize_task", taskId: "t1", durationDays: 5 }]);
    expect(() => validatePlanIds(plan, milestones)).toThrow(/milestone/i);
  });

  it("still allows a resize of ordinary work", () => {
    const plan = makePlan([{ type: "resize_task", taskId: "t1", durationDays: 5 }]);
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

describe("deletes are checked as hard as everything else", () => {
  it("refuses to delete something the same plan is creating", () => {
    const plan = makePlan([
      { type: "create_project", name: "Chico Flats" },
      { type: "delete_project", projectId: "$p0" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/creating in the same breath/);
  });

  it("refuses to delete a task that does not exist", () => {
    const plan = makePlan([{ type: "delete_task", taskId: "t99" }]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/t99/);
  });

  it("refuses to edit and delete the same thing in one plan", () => {
    const plan = makePlan([
      { type: "update_task", taskId: "t1", name: "Framing v2" },
      { type: "delete_task", taskId: "t1" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/Pick one/);
  });

  it("refuses to move a task whose whole job this plan deletes", () => {
    const plan = makePlan([
      { type: "delete_project", projectId: "p1" },
      { type: "move_task", taskId: "t1", startDate: MON },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/Pick one/);
  });

  it("refuses to take someone off work they were never on", () => {
    const plan = makePlan([{ type: "unassign_task", taskId: "t1", contactId: "c2" }]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/Dave is not on Framing/);
  });

  it("allows taking someone off work they are actually on", () => {
    const plan = makePlan([{ type: "unassign_task", taskId: "t4", contactId: "c1" }]);
    expect(() => validatePlanIds(plan, ctx)).not.toThrow();
  });

  it("refuses to unlink two tasks that were never linked", () => {
    const plan = makePlan([
      { type: "remove_dependency", predecessorId: "t1", successorId: "t2" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/no link to remove/);
  });

  it("allows unlinking a dependency that exists", () => {
    const linked = makeContext({
      deps: [{ predecessorId: "t1", successorId: "t2", depType: "FS", lagDays: 0 }],
    });
    const plan = makePlan([
      { type: "remove_dependency", predecessorId: "t1", successorId: "t2" },
    ]);
    expect(() => validatePlanIds(plan, linked)).not.toThrow();
  });

  it("accepts an ordinary delete of a real job", () => {
    const plan = makePlan([{ type: "delete_project", projectId: "p1" }]);
    expect(() => validatePlanIds(plan, ctx)).not.toThrow();
  });
});

describe("time windows are one day's shift", () => {
  it("refuses a finish time with no start", () => {
    const plan = makePlan([
      { type: "create_task", projectId: "p1", name: "Pour", startDate: MON, endTime: "15:00" },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/no start time/);
  });

  it("refuses a window that runs through midnight", () => {
    const plan = makePlan([
      {
        type: "create_task",
        projectId: "p1",
        name: "Night pour",
        startDate: MON,
        startTime: "22:00",
        endTime: "04:00",
      },
    ]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/two tasks/);
  });

  it("checks a one-sided edit against the time already on the task", () => {
    // Inspection finishes at 15:00; starting it at 16:00 is backwards.
    const plan = makePlan([{ type: "update_task", taskId: "t4", startTime: "16:00" }]);
    expect(() => validatePlanIds(plan, ctx)).toThrow(/not after/);
  });

  it("allows clearing the times back to all day", () => {
    const plan = makePlan([{ type: "update_task", taskId: "t4", clearTimes: true }]);
    expect(() => validatePlanIds(plan, ctx)).not.toThrow();
  });

  it("allows an ordinary window", () => {
    const plan = makePlan([
      {
        type: "create_task",
        projectId: "p1",
        name: "Pour",
        startDate: MON,
        startTime: "06:00",
        endTime: "10:30",
      },
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
