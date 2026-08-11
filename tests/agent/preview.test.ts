import { beforeAll, describe, expect, it } from "vitest";

import { PlannerError } from "@/lib/voice/validate";
import { buildPreview } from "@/lib/voice/preview";
import {
  makeContext,
  makePlan,
  MON,
  TUE,
  WED,
  THU,
  FRI,
  SAT,
  NEXT_MON,
  NEXT_TUE,
  PREV_FRI,
} from "./fixture";

/**
 * The [auto] cases from `cases.md` that live at the preview builder:
 * invariant 6 (every date shown comes out of the schedule engine) and
 * invariant 8 (who gets told, and about what).
 *
 * The preview is also the gate on Confirm — the UI hides the button when the
 * diff is empty — so "the preview describes nothing" and "the change cannot be
 * made at all" are the same bug, and several cases below are about exactly
 * that.
 */

beforeAll(() => {
  // getEnv() validates the whole server environment; these are the three it
  // requires to boot. Never the developer's own .env.
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.CRON_SECRET = "test-cron-secret";
});

const preview = (ops: unknown[], ctx = makeContext()) =>
  buildPreview(makePlan(ops), ctx).preview;

describe("invariant 6 — the preview is the whole plan", () => {
  it("J1: an undated new task is still a change worth confirming", () => {
    const p = preview([{ type: "create_task", projectId: "p1", name: "Plumbing" }]);
    expect(p.empty).toBe(false);
    expect(p.newTasks).toHaveLength(1);
    expect(p.newTasks[0]).toMatchObject({
      name: "Plumbing",
      projectName: "Chico Real Estate",
    });
  });

  it("J2: a resize is a change worth confirming, and says how long it was", () => {
    const p = preview([{ type: "resize_task", taskId: "t1", durationDays: 4 }]);
    expect(p.empty).toBe(false);
    expect(p.edits).toContainEqual({
      what: "Framing duration",
      from: "2 days",
      to: "4 days",
    });
  });

  it("J3: a weekend start in the plan is normalised by the engine", () => {
    const p = preview([
      { type: "create_task", projectId: "p1", name: "Pour", startDate: SAT },
    ]);
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0].toStart).toBe(NEXT_MON);
    expect(p.moves[0].isNew).toBe(true);
  });

  it("J4: a holiday is normalised too", () => {
    const ctx = makeContext({
      calendar: { workingDays: [1, 2, 3, 4, 5], holidays: [MON] },
    });
    const p = preview([{ type: "move_task", taskId: "t1", startDate: MON }], ctx);
    expect(p.moves[0].toStart).toBe(TUE);
  });

  it("J5: a new task on an ordinary working day is shown, and confirmable", () => {
    const p = preview([
      { type: "create_task", projectId: "p1", name: "Plumbing", startDate: MON },
    ]);
    expect(p.empty).toBe(false);
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0]).toMatchObject({
      name: "Plumbing",
      isNew: true,
      fromStart: null,
      toStart: MON,
      toEnd: MON,
    });
    expect(p.newTasks).toHaveLength(0);
  });

  it("J6: the assignee of a brand-new dated task still gets told", () => {
    const p = preview([
      {
        type: "create_task",
        projectId: "p1",
        name: "Plumbing",
        startDate: MON,
        assigneeId: "c1",
      },
    ]);
    expect(p.notifications).toHaveLength(1);
    expect(p.notifications[0]).toMatchObject({ contactName: "Alex", taskName: "Plumbing" });
  });

  it("J7: an update that names no fields offers nothing to confirm", () => {
    const p = preview([{ type: "update_project", projectId: "p1" }]);
    expect(p.empty).toBe(true);
  });

  it("a rename shows the old name beside the new one", () => {
    const p = preview([
      { type: "update_project", projectId: "p1", name: "Barney Real Estate" },
    ]);
    expect(p.edits).toEqual([
      { what: "Job name", from: "Chico Real Estate", to: "Barney Real Estate" },
    ]);
    expect(p.newProjects).toHaveLength(0);
  });
});

describe("dependencies, lag and milestones", () => {
  it("I1: a dependency loop is refused, naming both tasks", () => {
    const ctx = makeContext({
      deps: [{ predecessorId: "t1", successorId: "t2", depType: "FS", lagDays: 0 }],
    });
    expect(() =>
      preview([{ type: "add_dependency", predecessorId: "t2", successorId: "t1" }], ctx),
    ).toThrow(PlannerError);
    expect(() =>
      preview([{ type: "add_dependency", predecessorId: "t2", successorId: "t1" }], ctx),
    ).toThrow(/Framing.*Drywall|Drywall.*Framing/);
  });

  it("I2: FS lag is counted in working days", () => {
    const ctx = makeContext();
    ctx.tasks[0].durationDays = 1;
    ctx.tasks[0].endDate = MON;
    const p = preview(
      [
        {
          type: "add_dependency",
          predecessorId: "t1",
          successorId: "t2",
          depType: "FS",
          lagDays: 2,
        },
      ],
      ctx,
    );
    const drywall = p.moves.find((m) => m.name === "Drywall");
    expect(drywall?.toStart).toBe(THU);
  });

  it("I3: negative lag pulls the successor in without moving the predecessor", () => {
    const ctx = makeContext();
    ctx.tasks[0].durationDays = 3;
    ctx.tasks[0].endDate = WED;
    // Parked well clear, so "did it move to where the link says" is visible.
    ctx.tasks[1].startDate = "2026-09-30";
    ctx.tasks[1].endDate = "2026-09-30";
    const p = preview(
      [
        {
          type: "add_dependency",
          predecessorId: "t1",
          successorId: "t2",
          depType: "FS",
          lagDays: -1,
        },
      ],
      ctx,
    );
    expect(p.moves.find((m) => m.name === "Drywall")?.toStart).toBe(WED);
    expect(p.moves.find((m) => m.name === "Framing")).toBeUndefined();
  });

  it("I4: a knock-on is labelled as one", () => {
    const ctx = makeContext({
      deps: [{ predecessorId: "t1", successorId: "t2", depType: "FS", lagDays: 0 }],
    });
    const p = preview([{ type: "move_task", taskId: "t1", startDate: NEXT_MON }], ctx);
    expect(p.moves.find((m) => m.name === "Framing")?.direct).toBe(true);
    const drywall = p.moves.find((m) => m.name === "Drywall");
    expect(drywall?.direct).toBe(false);
    expect(drywall?.toStart).toBe("2026-08-26");
  });

  it("I5: a start-to-start link moves them together", () => {
    const ctx = makeContext({
      deps: [{ predecessorId: "t1", successorId: "t2", depType: "SS", lagDays: 0 }],
    });
    ctx.tasks[1].startDate = "2026-09-30";
    ctx.tasks[1].endDate = "2026-09-30";
    const p = preview([{ type: "move_task", taskId: "t1", startDate: WED }], ctx);
    expect(p.moves.find((m) => m.name === "Drywall")?.toStart).toBe(WED);
  });

  it("I6: a milestone takes one day however many it was given", () => {
    const p = preview([
      {
        type: "create_task",
        projectId: "p1",
        name: "Sign-off",
        startDate: MON,
        durationDays: 5,
        isMilestone: true,
      },
    ]);
    expect(p.moves[0].toStart).toBe(MON);
    expect(p.moves[0].toEnd).toBe(MON);
  });

  it("I7: a new task with a predecessor is dated by the cascade", () => {
    const p = preview([
      { type: "create_task", projectId: "p1", name: "Taping", deps: ["t1"] },
    ]);
    const taping = p.moves.find((m) => m.name === "Taping");
    expect(taping?.isNew).toBe(true);
    expect(taping?.toStart).toBe(WED);
    // It was scheduled, so it does not belong in the undated list as well.
    expect(p.newTasks).toHaveLength(0);
  });

  it("I8: resizing a predecessor states the resize and pushes the successor", () => {
    const ctx = makeContext({
      deps: [{ predecessorId: "t1", successorId: "t2", depType: "FS", lagDays: 0 }],
    });
    const p = preview([{ type: "resize_task", taskId: "t1", durationDays: 4 }], ctx);
    expect(p.empty).toBe(false);
    expect(p.edits).toContainEqual({
      what: "Framing duration",
      from: "2 days",
      to: "4 days",
    });
    expect(p.moves.find((m) => m.name === "Drywall")?.toStart).toBe(FRI);
  });

  it("I10: the resized task keeps its start and moves its end", () => {
    const p = preview([{ type: "resize_task", taskId: "t1", durationDays: 4 }]);
    const framing = p.moves.find((m) => m.name === "Framing");
    // Where it used to end, beside where it will. Same start on both sides —
    // a longer task is not a later one.
    expect(framing).toMatchObject({
      fromStart: MON,
      toStart: MON,
      fromEnd: TUE,
      toEnd: THU,
    });
  });

});

describe("a delete says what goes with it", () => {
  it("deleting a job counts its tasks, links and crew bookings", () => {
    const ctx = makeContext({
      deps: [{ predecessorId: "t1", successorId: "t2", depType: "FS", lagDays: 0 }],
    });
    const p = preview([{ type: "delete_project", projectId: "p1" }], ctx);
    expect(p.empty).toBe(false);
    expect(p.removals).toHaveLength(1);
    expect(p.removals[0]).toMatchObject({ kind: "job", name: "Chico Real Estate" });
    // Four tasks in the fixture, one link between two of them, Alex on the
    // inspection. All three numbers have to be in front of the user.
    expect(p.removals[0].alsoRemoved).toEqual([
      "4 tasks",
      "1 dependency",
      "1 crew booking",
    ]);
  });

  it("counts a finished job's tasks without claiming to know its links", () => {
    // A project that is not active carries no tasks in the context, so the
    // count comes off the project itself and the lines that cannot be
    // verified are left out rather than reported as zero.
    const ctx = makeContext({
      projects: [
        {
          id: "p2",
          name: "Old Warehouse",
          jobNumber: "23-11",
          clientName: null,
          status: "complete",
          taskCount: 9,
        },
      ],
      tasks: [],
      deps: [],
    });
    const p = preview([{ type: "delete_project", projectId: "p2" }], ctx);
    expect(p.removals[0]).toMatchObject({ kind: "job", name: "Old Warehouse" });
    expect(p.removals[0].alsoRemoved).toEqual(["9 tasks"]);
  });

  it("deleting a task names its dates, and mentions nothing it does not have", () => {
    const p = preview([{ type: "delete_task", taskId: "t2" }]);
    expect(p.removals[0]).toMatchObject({ kind: "task", name: "Drywall" });
    expect(p.removals[0].detail).toContain("Wed 19 Aug");
    expect(p.removals[0].alsoRemoved).toEqual([]);
  });

  it("a deleted task is not also reported as rescheduled", () => {
    const ctx = makeContext({
      deps: [{ predecessorId: "t1", successorId: "t2", depType: "FS", lagDays: 0 }],
    });
    // Framing moves; Drywall would normally be dragged along behind it, but
    // it is on its way out and a diff line about its new dates would be a lie.
    const p = preview(
      [
        { type: "move_task", taskId: "t1", startDate: NEXT_MON },
        { type: "delete_task", taskId: "t2" },
      ],
      ctx,
    );
    expect(p.moves.map((m) => m.name)).toEqual(["Framing"]);
    expect(p.removals).toHaveLength(1);
  });

  it("removing one person from one task is not a deletion of either", () => {
    const p = preview([{ type: "unassign_task", taskId: "t4", contactId: "c1" }]);
    expect(p.removals[0]).toMatchObject({
      kind: "assignment",
      name: "Alex",
      detail: "off Inspection",
    });
  });
});

describe("times of day", () => {
  it("a new timed task shows its window beside its date", () => {
    const p = preview([
      {
        type: "create_task",
        projectId: "p1",
        name: "Pour",
        startDate: MON,
        startTime: "06:00",
        endTime: "10:30",
      },
    ]);
    expect(p.moves[0]).toMatchObject({ name: "Pour", window: "06:00 – 10:30" });
  });

  it("a task that keeps its hours still shows them when it moves", () => {
    const p = preview([{ type: "move_task", taskId: "t4", startDate: FRI }]);
    expect(p.moves[0]).toMatchObject({ name: "Inspection", window: "14:00 – 15:00" });
  });

  it("changing the hours reads as before and after", () => {
    const p = preview([
      { type: "update_task", taskId: "t4", startTime: "09:00", endTime: "11:00" },
    ]);
    expect(p.edits).toContainEqual({
      what: "Inspection hours",
      from: "14:00 – 15:00",
      to: "09:00 – 11:00",
    });
  });

  it("clearing the hours reads as all day", () => {
    const p = preview([{ type: "update_task", taskId: "t4", clearTimes: true }]);
    expect(p.edits).toContainEqual({
      what: "Inspection hours",
      from: "14:00 – 15:00",
      to: "all day",
    });
  });
});

describe("invariant 4 — relative moves land on working days", () => {
  it("A3: two weeks back on a five-day week is ten working days", () => {
    const ctx = makeContext();
    ctx.tasks[0].startDate = "2026-08-31";
    ctx.tasks[0].endDate = "2026-09-01";
    const p = preview([{ type: "shift_task", taskId: "t1", byDays: -10 }], ctx);
    expect(p.moves[0].toStart).toBe(MON);
  });

  it("A7: a backward project shift lands on the Friday, not the weekend", () => {
    const ctx = makeContext();
    ctx.tasks[0].startDate = FRI;
    ctx.tasks[0].endDate = NEXT_MON;
    const p = preview([{ type: "shift_project", projectId: "p1", byDays: -5 }], ctx);
    expect(p.moves.find((m) => m.name === "Framing")?.toStart).toBe(PREV_FRI);
  });
});

describe("invariant 8 — who gets told", () => {
  it("C5: assigning someone to undated work notifies nobody", () => {
    const p = preview([{ type: "assign_task", taskId: "t3", contactId: "c1" }]);
    expect(p.assignments).toEqual([{ taskName: "Snagging", contactName: "Alex" }]);
    expect(p.notifications).toHaveLength(0);
    expect(p.empty).toBe(false);
  });

  it("C6: the notified dates are the engine's, not the plan's", () => {
    const p = preview([
      { type: "move_task", taskId: "t1", startDate: SAT },
      { type: "assign_task", taskId: "t1", contactId: "c1" },
    ]);
    expect(p.notifications).toHaveLength(1);
    expect(p.notifications[0].when).toContain("Mon 24 Aug");
    expect(p.notifications[0].when).not.toContain("22");
    expect(p.moves[0].toStart).toBe(NEXT_MON);
    expect(p.moves[0].toEnd).toBe(NEXT_TUE);
  });

  it("C7: assigned twice in one plan, told once", () => {
    const p = preview([
      {
        type: "create_task",
        projectId: "p1",
        name: "Pour",
        startDate: MON,
        assigneeId: "c1",
      },
      { type: "assign_task", taskId: "$t0", contactId: "c1" },
    ]);
    expect(p.notifications).toHaveLength(1);
  });

  it("C8: someone with no address is assigned but not promised an email", () => {
    const p = preview([{ type: "assign_task", taskId: "t1", contactId: "c2" }]);
    expect(p.assignments).toEqual([{ taskName: "Framing", contactName: "Dave" }]);
    expect(p.notifications).toHaveLength(0);
  });
});
