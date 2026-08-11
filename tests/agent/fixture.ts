import { planSchema } from "@/lib/voice/schema";
import type { Plan } from "@/lib/voice/schema";
import type { PlannerContext } from "@/lib/voice/context";
import type { IsoWeekday } from "@/lib/schedule";

/**
 * A small, fixed org for the behavioural cases in `cases.md`.
 *
 * August 2026 because the weekdays are easy to hold in your head:
 * Mon 17 · Tue 18 · Wed 19 · Thu 20 · Fri 21 · Sat 22 · Sun 23 · Mon 24.
 * Fri 14 is the Friday before.
 */

export const MON = "2026-08-17";
export const TUE = "2026-08-18";
export const WED = "2026-08-19";
export const THU = "2026-08-20";
export const FRI = "2026-08-21";
export const SAT = "2026-08-22";
export const NEXT_MON = "2026-08-24";
export const NEXT_TUE = "2026-08-25";
export const PREV_FRI = "2026-08-14";

const WORKING_DAYS: IsoWeekday[] = [1, 2, 3, 4, 5];

/**
 * Framing (2 days from Mon), Drywall (1 day Wed), Snagging (no dates yet),
 * Inspection (Thu, 14:00–15:00 — the one task with a time window on it).
 * Alex has an address; Dave does not — the pair that makes every
 * "never guess an address" case testable.
 */
export function makeContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    today: "2026-08-11",
    timezone: "UTC",
    workingDays: [...WORKING_DAYS],
    projects: [
      {
        id: "p1",
        name: "Chico Real Estate",
        jobNumber: "24-01",
        clientName: "Chico",
        status: "active",
        taskCount: 4,
      },
    ],
    tasks: [
      {
        id: "t1",
        projectId: "p1",
        name: "Framing",
        trade: "carpentry",
        startDate: MON,
        endDate: TUE,
        startTime: null,
        endTime: null,
        durationDays: 2,
        status: "planned",
        isMilestone: false,
        assigneeIds: [],
      },
      {
        id: "t2",
        projectId: "p1",
        name: "Drywall",
        trade: null,
        startDate: WED,
        endDate: WED,
        startTime: null,
        endTime: null,
        durationDays: 1,
        status: "planned",
        isMilestone: false,
        assigneeIds: [],
      },
      {
        id: "t3",
        projectId: "p1",
        name: "Snagging",
        trade: null,
        startDate: null,
        endDate: null,
        startTime: null,
        endTime: null,
        durationDays: 1,
        status: "planned",
        isMilestone: false,
        assigneeIds: [],
      },
      {
        id: "t4",
        projectId: "p1",
        name: "Inspection",
        trade: null,
        startDate: THU,
        endDate: THU,
        startTime: "14:00",
        endTime: "15:00",
        durationDays: 1,
        status: "planned",
        isMilestone: false,
        assigneeIds: ["c1"],
      },
    ],
    deps: [],
    contacts: [
      { id: "c1", name: "Alex", company: null, trade: "carpenter", hasEmail: true },
      { id: "c2", name: "Dave", company: null, trade: "sparky", hasEmail: false },
    ],
    calendar: { workingDays: WORKING_DAYS, holidays: [] },
    ...overrides,
  };
}

/** Parse through the real schema so defaults (durationDays, deps) are applied. */
export function makePlan(
  operations: unknown[],
  extra: Partial<Pick<Plan, "clarification" | "notes" | "confidence" | "summary">> = {},
): Plan {
  return planSchema.parse({
    summary: extra.summary ?? "Do the thing",
    confidence: extra.confidence ?? "high",
    operations,
    clarification: extra.clarification ?? null,
    notes: extra.notes ?? null,
  });
}
