import { describe, expect, it } from "vitest";

import { planSchema } from "@/lib/voice/schema";
import { humanRange } from "@/lib/format-date";
import { PALETTE_SIZE, projectColor, projectColors } from "@/lib/project-color";

/**
 * The two rules that shipped broken, pinned so they cannot drift back.
 *
 * Both were the same class of mistake: a case the planner *can* handle being
 * treated as a case it cannot, and a message being sent about something that
 * had not happened yet.
 */

const base = { summary: "Do the thing", confidence: "high" as const };

describe("plan schema: notes are not clarifications", () => {
  it("accepts a note alongside real operations", () => {
    // The regression: asking for a project *with times of day* used to come
    // back as a clarification, which forces operations to [] — so nothing was
    // created at all. A dropped time is a note; the work still happens.
    const parsed = planSchema.safeParse({
      ...base,
      operations: [{ type: "create_project", name: "Barney Real Estate" }],
      notes: "Times of day were ignored — Foreman schedules whole days.",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.operations).toHaveLength(1);
      expect(parsed.data.notes).toContain("whole days");
      expect(parsed.data.clarification ?? null).toBeNull();
    }
  });

  it("still allows a blocking clarification with no operations", () => {
    const parsed = planSchema.safeParse({
      ...base,
      operations: [],
      clarification: "Two people named Alex — which one?",
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults a created project to no explicit colour", () => {
    const parsed = planSchema.safeParse({
      ...base,
      operations: [{ type: "create_project", name: "Chico Empire" }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const op = parsed.data.operations[0];
      expect(op.type).toBe("create_project");
      if (op.type === "create_project") expect(op.color ?? null).toBeNull();
    }
  });

  it("rejects a colour that is not #rrggbb", () => {
    const parsed = planSchema.safeParse({
      ...base,
      operations: [{ type: "create_project", name: "Chico", color: "blue" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("dates a person reads", () => {
  it("renders a single day", () => {
    expect(humanRange("2026-08-18", "2026-08-18")).toBe("Tue 18 Aug");
    expect(humanRange("2026-08-18", null)).toBe("Tue 18 Aug");
  });

  it("renders a run of days", () => {
    expect(humanRange("2026-08-18", "2026-08-20")).toBe("Tue 18 Aug – Thu 20 Aug");
  });

  it("does not shift the day", () => {
    // Formatted in UTC on purpose: these are civil dates with no time, and a
    // local-zone render turns the 18th into the 17th for half the world.
    expect(humanRange("2026-01-01", null)).toBe("Thu 1 Jan");
    expect(humanRange("2026-12-31", null)).toBe("Thu 31 Dec");
  });
});

describe("project colour", () => {
  it("gives every project in a palette-sized org a different colour", () => {
    // The bug this replaced: colours were hashed from the name, so two jobs
    // could collide outright or land on two near-identical greens. Position
    // makes distinctness a guarantee rather than a probability.
    const projects = Array.from({ length: PALETTE_SIZE }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
    }));
    const fills = [...projectColors(projects).values()].map((c) => c.fill);
    expect(new Set(fills).size).toBe(PALETTE_SIZE);
  });

  it("only repeats once the palette is exhausted", () => {
    const projects = Array.from({ length: PALETTE_SIZE + 1 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
    }));
    const colors = projectColors(projects);
    expect(colors.get(`p${PALETTE_SIZE}`)?.fill).toBe(colors.get("p0")?.fill);
  });

  it("keeps a job's colour when a newer job is added", () => {
    const two = projectColors([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    const three = projectColors([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ]);
    expect(three.get("a")?.fill).toBe(two.get("a")?.fill);
    expect(three.get("b")?.fill).toBe(two.get("b")?.fill);
  });

  it("lets an explicit colour override its position", () => {
    const colors = projectColors([
      { id: "a", name: "A" },
      { id: "b", name: "B", color: "#123456" },
    ]);
    expect(colors.get("b")?.fill).toBe("#123456");
  });

  it("is stable for the same name", () => {
    expect(projectColor("Chico Empire").fill).toBe(projectColor("Chico Empire").fill);
  });

  it("honours an explicit colour over the hash", () => {
    expect(projectColor("Chico Empire", "#123456").fill).toBe("#123456");
  });

  it("ignores a malformed explicit colour", () => {
    expect(projectColor("Chico Empire", "blue").fill).toBe(
      projectColor("Chico Empire").fill,
    );
  });

  it("picks legible text for a hand-chosen colour", () => {
    expect(projectColor("x", "#ffffff").text).toBe("#172322");
    expect(projectColor("x", "#000000").text).toBe("#ffffff");
  });
});
