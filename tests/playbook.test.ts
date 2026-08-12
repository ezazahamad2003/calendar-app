import { describe, expect, it } from "vitest";

import { applyOperations } from "@/lib/ops/apply";
import { cascade } from "@/lib/schedule";
import { doc, ID, taskById } from "./fixture";

/**
 * The playbook — "they didn't come, push it two days, and move whatever has to
 * move with it".
 *
 * This is the behaviour the client described in the one sentence that mattered
 * most, so it gets tested against the real chart rather than a toy graph.
 */

describe("the seed is a fixed point", () => {
  // If cascading a schedule nobody has touched moves something, then opening
  // the app and immediately saying anything at all would silently reshuffle
  // dates the contractor did not ask about — and email the trades about it.
  it("cascading with no changes moves nothing", () => {
    const d = doc();
    const changes = cascade({
      tasks: d.tasks.map((t) => ({
        id: t.id,
        startDate: t.startDate,
        durationDays: t.durationDays,
      })),
      deps: d.deps,
      changed: new Map(),
      calendar: d.calendar,
    });
    expect(changes).toEqual([]);
  });

  it("applying no operations changes nothing", () => {
    const d = doc();
    const result = applyOperations(d, []);
    expect(result.moves).toEqual([]);
    expect(result.doc.tasks).toEqual(d.tasks);
  });
});

describe("pushing an activity", () => {
  it("moves it two working days and drags the chain with it", () => {
    const d = doc();
    // The fire chain: riser (Wed 12 Aug) → hydro (Fri 14, 2d) → pump test
    // (Wed 19) → consultant (Fri 21), plus the inspection running alongside.
    const result = applyOperations(d, [
      { type: "push_activity", taskId: ID.fireRiser, byDays: 2 },
    ]);

    const moved = new Map(result.moves.map((m) => [m.taskId, m]));

    // Wed 12 + 2 work days = Fri 14.
    expect(moved.get(ID.fireRiser)?.toStartDate).toBe("2026-08-14");
    expect(moved.get(ID.fireRiser)?.direct).toBe(true);

    // Everything downstream keeps its gap: the whole chain slides two working
    // days, weekends stepped over.
    expect(moved.get(ID.hydro)?.toStartDate).toBe("2026-08-18");
    expect(moved.get(ID.pumpTest)?.toStartDate).toBe("2026-08-21");
    expect(moved.get(ID.consultant)?.toStartDate).toBe("2026-08-25");
    expect(moved.get(ID.hydro)?.direct).toBe(false);
  });

  it("does not touch activities that are not downstream", () => {
    const d = doc();
    const before = taskById(d, ID.colorCoat).startDate;
    const result = applyOperations(d, [
      { type: "push_activity", taskId: ID.fireRiser, byDays: 2 },
    ]);

    // Color Coat shares no dependency with the fire chain, so it must sit
    // exactly where it was. A cascade that reflows unrelated trades is how a
    // schedule stops being trusted.
    expect(result.moves.find((m) => m.taskId === ID.colorCoat)).toBeUndefined();
    expect(
      result.doc.tasks.find((t) => t.id === ID.colorCoat)?.startDate,
    ).toBe(before);
  });

  it("steps over the weekend rather than landing on it", () => {
    const d = doc();
    // Fri 21 Aug + 1 work day must be Mon 24 Aug, not Sat 22.
    const result = applyOperations(d, [
      { type: "push_activity", taskId: ID.consultant, byDays: 1 },
    ]);
    expect(
      result.moves.find((m) => m.taskId === ID.consultant)?.toStartDate,
    ).toBe("2026-08-24");
  });

  it("pulls a chain back when pushed by a negative number of days", () => {
    const d = doc();
    const result = applyOperations(d, [
      { type: "push_activity", taskId: ID.fireRiser, byDays: -2 },
    ]);
    // Wed 12 back two working days = Mon 10.
    expect(
      result.moves.find((m) => m.taskId === ID.fireRiser)?.toStartDate,
    ).toBe("2026-08-10");
  });

  it("refuses to push something that has no date, and says so", () => {
    const d = doc();
    const result = applyOperations(d, [
      { type: "push_activity", taskId: ID.rebar, byDays: 2 },
    ]);
    expect(result.moves).toEqual([]);
    expect(result.notices.join(" ")).toMatch(/no date yet/i);
  });

  it("leaves the undated backlog undated when the chain above it moves", () => {
    const d = doc();
    // Finish Grade (dated) → Rebar inspection (undated) → Pour Heli Pad
    // (undated). Pushing the grade must not conjure dates for either.
    const result = applyOperations(d, [
      { type: "push_activity", taskId: ID.grade, byDays: 3 },
    ]);

    const ids = result.moves.map((m) => m.taskId);
    expect(ids).toContain(ID.grade);
    expect(ids).not.toContain(ID.rebar);
    expect(result.doc.tasks.find((t) => t.id === ID.rebar)?.startDate).toBeNull();
  });
});

describe("adding is not moving", () => {
  it("adds a second activity rather than moving the one that exists", () => {
    const d = doc();
    const before = taskById(d, ID.downspouts);

    const result = applyOperations(d, [
      {
        type: "add_activity",
        name: "Install Downspouts",
        team: "Solano Seamless",
        startDate: "2026-08-12",
        durationDays: 1,
        status: "confirmed",
        after: [],
      },
    ]);

    // The original is untouched…
    expect(result.doc.tasks.find((t) => t.id === ID.downspouts)?.startDate).toBe(
      before.startDate,
    );
    // …and there are now two activities with that name.
    const named = result.doc.tasks.filter((t) => t.name === "Install Downspouts");
    expect(named).toHaveLength(2);
    // The new one gets a distinct id rather than colliding.
    expect(new Set(named.map((t) => t.id)).size).toBe(2);
  });

  it("links a new activity behind an existing one when asked", () => {
    const d = doc();
    const result = applyOperations(d, [
      {
        type: "add_activity",
        name: "Punch list walk",
        team: null,
        startDate: null,
        durationDays: 2,
        status: "planned",
        after: [ID.finalInspection],
      },
    ]);

    const added = result.doc.tasks.find((t) => t.name === "Punch list walk");
    expect(added).toBeDefined();
    expect(
      result.doc.deps.some(
        (dep) => dep.predecessorId === ID.finalInspection && dep.successorId === added?.id,
      ),
    ).toBe(true);
  });
});

describe("removing", () => {
  it("takes the activity's dependency links with it", () => {
    const d = doc();
    const result = applyOperations(d, [
      { type: "remove_activity", taskId: ID.pumpTest },
    ]);

    expect(result.doc.tasks.some((t) => t.id === ID.pumpTest)).toBe(false);
    expect(
      result.doc.deps.some(
        (dep) => dep.predecessorId === ID.pumpTest || dep.successorId === ID.pumpTest,
      ),
    ).toBe(false);
  });
});

describe("resizing", () => {
  it("changes the finish and pushes what follows", () => {
    const d = doc();
    // Hydro is 2 days (Fri 14 + Mon 17). Make it 4 and the pump test after it
    // has to give way.
    const result = applyOperations(d, [
      { type: "resize_activity", taskId: ID.hydro, durationDays: 4 },
    ]);

    const hydro = result.moves.find((m) => m.taskId === ID.hydro);
    expect(hydro?.toEndDate).toBe("2026-08-19");
    expect(
      result.moves.find((m) => m.taskId === ID.pumpTest)?.toStartDate,
    ).toBe("2026-08-21");
  });
});
