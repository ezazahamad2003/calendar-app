import { describe, expect, it } from "vitest";

import {
  CycleError,
  cascade,
  criticalPath,
  detectCycle,
  shiftTasks,
  topologicalOrder,
  wouldCreateCycle,
} from "@/lib/schedule";
import type { Task, TaskDep, WorkCalendar } from "@/lib/schedule";

const MON_FRI: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: [] };

const task = (id: string, startDate: string | null, durationDays = 1): Task => ({
  id,
  startDate,
  durationDays,
});

const fs = (predecessorId: string, successorId: string, lagDays = 0): TaskDep => ({
  predecessorId,
  successorId,
  depType: "FS",
  lagDays,
});

describe("detectCycle", () => {
  it("returns null for an acyclic chain", () => {
    expect(detectCycle([fs("a", "b"), fs("b", "c")])).toBeNull();
  });

  it("finds a direct two-task loop and names both", () => {
    const cycle = detectCycle([fs("a", "b"), fs("b", "a")]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("a");
    expect(cycle).toContain("b");
    // Closed path: first and last are the same node.
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
  });

  it("finds a longer loop", () => {
    const cycle = detectCycle([fs("a", "b"), fs("b", "c"), fs("c", "a")]);
    expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  it("catches a self-dependency before it is written", () => {
    expect(wouldCreateCycle([], { predecessorId: "a", successorId: "a" })).not.toBeNull();
  });

  it("predicts a loop a candidate edge would close", () => {
    const existing = [fs("a", "b"), fs("b", "c")];
    expect(wouldCreateCycle(existing, { predecessorId: "c", successorId: "a" })).not.toBeNull();
    expect(wouldCreateCycle(existing, { predecessorId: "a", successorId: "c" })).toBeNull();
  });

  it("surfaces a CycleError with both task names in the message", () => {
    const tasks = [task("framing", "2026-03-02", 5), task("roof", "2026-03-09", 3)];
    const deps = [fs("framing", "roof"), fs("roof", "framing")];
    try {
      cascade({ tasks, deps, changed: new Map(), calendar: MON_FRI });
      throw new Error("expected cascade to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CycleError);
      expect((err as CycleError).message).toMatch(/framing/);
      expect((err as CycleError).message).toMatch(/roof/);
    }
  });
});

describe("topologicalOrder", () => {
  it("puts predecessors before successors", () => {
    const order = topologicalOrder(["c", "a", "b"], [fs("a", "b"), fs("b", "c")]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("is deterministic for independent tasks", () => {
    const ids = ["x", "y", "z"];
    expect(topologicalOrder(ids, [])).toEqual(ids);
    expect(topologicalOrder(ids, [])).toEqual(topologicalOrder(ids, []));
  });
});

describe("cascade", () => {
  it("moves a direct task and leaves unrelated ones alone", () => {
    const tasks = [task("a", "2026-03-02", 3), task("unrelated", "2026-03-02", 2)];
    const changes = cascade({
      tasks,
      deps: [],
      changed: new Map([["a", "2026-03-09"]]),
      calendar: MON_FRI,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ taskId: "a", toStartDate: "2026-03-09", direct: true });
  });

  it("cascades three levels deep", () => {
    // a(3d) -> b(2d) -> c(2d), all FS with no lag.
    const tasks = [
      task("a", "2026-03-02", 3), // Mon 2 - Wed 4
      task("b", "2026-03-05", 2), // Thu 5 - Fri 6
      task("c", "2026-03-09", 2), // Mon 9 - Tue 10
    ];
    const deps = [fs("a", "b"), fs("b", "c")];

    // Push a out by a week.
    const changes = cascade({
      tasks,
      deps,
      changed: new Map([["a", "2026-03-09"]]),
      calendar: MON_FRI,
    });

    const byId = new Map(changes.map((c) => [c.taskId, c]));
    expect(byId.get("a")?.toStartDate).toBe("2026-03-09"); // Mon 9 - Wed 11
    expect(byId.get("b")?.toStartDate).toBe("2026-03-12"); // Thu 12 - Fri 13
    expect(byId.get("c")?.toStartDate).toBe("2026-03-16"); // Mon 16, over the weekend
    expect(byId.get("c")?.toEndDate).toBe("2026-03-17");
    expect(byId.get("b")?.direct).toBe(false);
  });

  it("honours positive lag", () => {
    const tasks = [task("a", "2026-03-02", 1), task("b", "2026-03-03", 1)];
    // Two work days of cure time after a finishes.
    const changes = cascade({
      tasks,
      deps: [fs("a", "b", 2)],
      changed: new Map([["a", "2026-03-02"]]),
      calendar: MON_FRI,
    });
    // a finishes Mon 2; +1 = Tue 3; +2 lag = Thu 5.
    expect(changes.find((c) => c.taskId === "b")?.toStartDate).toBe("2026-03-05");
  });

  it("honours negative lag (a lead)", () => {
    const tasks = [task("a", "2026-03-09", 3), task("b", "2026-03-12", 2)];
    // b may start one work day before a finishes.
    const changes = cascade({
      tasks,
      deps: [fs("a", "b", -1)],
      changed: new Map([["a", "2026-03-09"]]),
      calendar: MON_FRI,
    });
    // a: Mon 9 - Wed 11. FS+1 = Thu 12, lag -1 pulls to Wed 11.
    expect(changes.find((c) => c.taskId === "b")?.toStartDate).toBe("2026-03-11");
  });

  it("takes the latest constraint when a task has two predecessors", () => {
    const tasks = [
      task("early", "2026-03-02", 1), // finishes Mon 2
      task("late", "2026-03-02", 5), // finishes Fri 6
      task("join", "2026-03-03", 1),
    ];
    const changes = cascade({
      tasks,
      deps: [fs("early", "join"), fs("late", "join")],
      changed: new Map([["early", "2026-03-02"]]),
      calendar: MON_FRI,
    });
    // Constrained by `late`, not `early`: Fri 6 + 1 work day = Mon 9.
    expect(changes.find((c) => c.taskId === "join")?.toStartDate).toBe("2026-03-09");
  });

  it("never lands a cascaded task on a weekend", () => {
    const tasks = [task("a", "2026-03-02", 4), task("b", "2026-03-06", 1)];
    const changes = cascade({
      tasks,
      deps: [fs("a", "b")],
      changed: new Map([["a", "2026-03-03"]]),
      calendar: MON_FRI,
    });
    // a: Tue 3 - Fri 6, so b lands Mon 9 rather than Sat 7.
    expect(changes.find((c) => c.taskId === "b")?.toStartDate).toBe("2026-03-09");
  });

  it("steps over a holiday when cascading", () => {
    const cal: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: ["2026-03-10"] };
    const tasks = [task("a", "2026-03-09", 1), task("b", "2026-03-10", 1)];
    const changes = cascade({
      tasks,
      deps: [fs("a", "b")],
      changed: new Map([["a", "2026-03-09"]]),
      calendar: cal,
    });
    // a finishes Mon 9; next work day is Tue 10, but that is a holiday -> Wed 11.
    expect(changes.find((c) => c.taskId === "b")?.toStartDate).toBe("2026-03-11");
  });

  it("reports no changes when nothing actually moves", () => {
    const tasks = [task("a", "2026-03-02", 3), task("b", "2026-03-05", 1)];
    const changes = cascade({
      tasks,
      deps: [fs("a", "b")],
      changed: new Map([["a", "2026-03-02"]]),
      calendar: MON_FRI,
    });
    expect(changes).toEqual([]);
  });

  it("leaves unscheduled tasks unscheduled", () => {
    const tasks = [task("a", null, 2), task("b", null, 2)];
    const changes = cascade({
      tasks,
      deps: [fs("a", "b")],
      changed: new Map(),
      calendar: MON_FRI,
    });
    expect(changes).toEqual([]);
  });

  // Half the wall chart is undated on purpose: work that is real and ordered
  // but not yet booked with a trade. A dated predecessor must not date it —
  // that is a guess, and since a confirmed change emails the trade whose dates
  // moved, it is a guess that mails someone a booking nobody made.
  it("does not date an unscheduled successor from a scheduled predecessor", () => {
    const changes = cascade({
      tasks: [task("a", "2026-08-10", 5), task("b", null, 1)],
      deps: [fs("a", "b")],
      changed: new Map(),
      calendar: MON_FRI,
    });
    expect(changes).toEqual([]);
  });

  it("still cascades past an undated task once it is given a date", () => {
    // a → b → c, with b undated. Dating b directly must move c and leave a be.
    const changes = cascade({
      tasks: [task("a", "2026-08-10", 1), task("b", null, 2), task("c", "2026-09-01", 1)],
      deps: [fs("a", "b"), fs("b", "c")],
      changed: new Map([["b", "2026-08-17"]]),
      calendar: MON_FRI,
    });
    expect(changes).toEqual([
      {
        taskId: "b",
        fromStartDate: null,
        toStartDate: "2026-08-17",
        fromEndDate: null,
        toEndDate: "2026-08-18",
        direct: true,
      },
      {
        taskId: "c",
        fromStartDate: "2026-09-01",
        toStartDate: "2026-08-19",
        fromEndDate: "2026-09-01",
        toEndDate: "2026-08-19",
        direct: false,
      },
    ]);
  });

  it("an undated task in the middle does not block the rest of the chain", () => {
    // a → b → c with b undated: a's move reaches nothing, because b is the only
    // route to c and b has no dates to propagate.
    const changes = cascade({
      tasks: [task("a", "2026-08-10", 1), task("b", null, 2), task("c", "2026-09-01", 1)],
      deps: [fs("a", "b"), fs("b", "c")],
      changed: new Map([["a", "2026-08-12"]]),
      calendar: MON_FRI,
    });
    expect(changes).toEqual([
      {
        taskId: "a",
        fromStartDate: "2026-08-10",
        toStartDate: "2026-08-12",
        fromEndDate: "2026-08-10",
        toEndDate: "2026-08-12",
        direct: true,
      },
    ]);
  });

  it("does not write to its inputs", () => {
    const tasks = [task("a", "2026-03-02", 3), task("b", "2026-03-05", 2)];
    const snapshot = JSON.stringify(tasks);
    cascade({
      tasks,
      deps: [fs("a", "b")],
      changed: new Map([["a", "2026-03-16"]]),
      calendar: MON_FRI,
    });
    // SPEC §4: cascade returns proposed changes and never mutates.
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });
});

describe("dependency types beyond FS", () => {
  it("SS starts both together, offset by lag", () => {
    const tasks = [task("a", "2026-03-09", 5), task("b", "2026-03-20", 2)];
    const changes = cascade({
      tasks,
      deps: [{ predecessorId: "a", successorId: "b", depType: "SS", lagDays: 1 }],
      changed: new Map([["a", "2026-03-09"]]),
      calendar: MON_FRI,
    });
    expect(changes.find((c) => c.taskId === "b")?.toStartDate).toBe("2026-03-10");
  });

  it("FF lines up the finishes", () => {
    const tasks = [task("a", "2026-03-09", 5), task("b", "2026-03-09", 2)];
    const changes = cascade({
      tasks,
      deps: [{ predecessorId: "a", successorId: "b", depType: "FF", lagDays: 0 }],
      changed: new Map([["a", "2026-03-09"]]),
      calendar: MON_FRI,
    });
    // a finishes Fri 13; b is 2 days, so it starts Thu 12 to finish alongside.
    const b = changes.find((c) => c.taskId === "b");
    expect(b?.toStartDate).toBe("2026-03-12");
    expect(b?.toEndDate).toBe("2026-03-13");
  });
});

describe("shiftTasks", () => {
  it("shifts every scheduled task by whole work days", () => {
    const tasks = [task("a", "2026-03-06", 1), task("b", "2026-03-09", 1)];
    const shifted = shiftTasks(tasks, 1, MON_FRI);
    expect(shifted.get("a")).toBe("2026-03-09"); // Fri -> Mon
    expect(shifted.get("b")).toBe("2026-03-10");
  });

  it("skips unscheduled tasks", () => {
    expect(shiftTasks([task("a", null, 1)], 3, MON_FRI).size).toBe(0);
  });
});

describe("criticalPath", () => {
  it("picks the longer of two parallel chains", () => {
    // start -> long(5d) -> end   and   start -> short(1d) -> end
    const tasks = [
      task("start", "2026-03-02", 1),
      task("long", "2026-03-03", 5),
      task("short", "2026-03-03", 1),
      task("end", "2026-03-10", 1),
    ];
    const deps = [
      fs("start", "long"),
      fs("start", "short"),
      fs("long", "end"),
      fs("short", "end"),
    ];
    const path = criticalPath(tasks, deps, MON_FRI);
    expect(path).toContain("long");
    expect(path).not.toContain("short");
    expect(path).toContain("start");
    expect(path).toContain("end");
  });

  it("puts every task on the critical path of a single chain", () => {
    const tasks = [
      task("a", "2026-03-02", 2),
      task("b", "2026-03-04", 2),
      task("c", "2026-03-06", 2),
    ];
    const deps = [fs("a", "b"), fs("b", "c")];
    expect(criticalPath(tasks, deps, MON_FRI)).toEqual(["a", "b", "c"]);
  });
});

describe("cascade with resized tasks", () => {
  // The caller used to apply a resize by writing the new duration onto the
  // task before handing it over. That destroyed the only record of where the
  // task previously ended, so the cascade compared the new finish against the
  // new finish, saw no difference, and reported no change at all — a resize
  // that appeared in no diff and so could never be confirmed.
  const durations = (entries: [string, number][]) => new Map(entries);

  it("reports the resized task, with the end it used to have", () => {
    const changes = cascade({
      tasks: [task("a", "2026-03-02", 2)],
      deps: [],
      changed: new Map([["a", "2026-03-02"]]),
      durations: durations([["a", 4]]),
      calendar: MON_FRI,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      taskId: "a",
      fromStartDate: "2026-03-02",
      toStartDate: "2026-03-02",
      fromEndDate: "2026-03-03",
      toEndDate: "2026-03-05",
    });
  });

  it("pushes the successors of a task that got longer", () => {
    const changes = cascade({
      tasks: [task("a", "2026-03-02", 2), task("b", "2026-03-04", 1)],
      deps: [fs("a", "b")],
      changed: new Map([["a", "2026-03-02"]]),
      durations: durations([["a", 4]]),
      calendar: MON_FRI,
    });
    expect(changes.find((c) => c.taskId === "b")?.toStartDate).toBe("2026-03-06");
  });

  it("pulls them back in when it got shorter", () => {
    const changes = cascade({
      tasks: [task("a", "2026-03-02", 4), task("b", "2026-03-06", 1)],
      deps: [fs("a", "b")],
      changed: new Map([["a", "2026-03-02"]]),
      durations: durations([["a", 2]]),
      calendar: MON_FRI,
    });
    expect(changes.find((c) => c.taskId === "b")?.toStartDate).toBe("2026-03-04");
  });

  it("leaves a task alone when the new duration is the old one", () => {
    const changes = cascade({
      tasks: [task("a", "2026-03-02", 2)],
      deps: [],
      changed: new Map([["a", "2026-03-02"]]),
      durations: durations([["a", 2]]),
      calendar: MON_FRI,
    });
    expect(changes).toHaveLength(0);
  });
});
