/**
 * Types for the date engine (SPEC §4).
 *
 * Nothing here touches the database or the network. The engine works on plain
 * values so it can be exhaustively unit-tested, and so a planner can run "what
 * would happen if…" without a transaction open.
 */

/** ISO weekday: 1 = Monday … 7 = Sunday. Matches `work_calendars.working_days`. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** `YYYY-MM-DD`. A civil date with no time and no zone. */
export type IsoDate = string;

export type TaskId = string;

export type WorkCalendar = {
  /** Which weekdays work happens on. Never empty — an empty set makes
   *  "next working day" unanswerable, which the DB constraint also forbids. */
  workingDays: readonly IsoWeekday[];
  /** Non-working dates, as `YYYY-MM-DD`. Order irrelevant. */
  holidays: readonly IsoDate[];
};

export type DepType = "FS" | "SS" | "FF" | "SF";

export type Task = {
  id: TaskId;
  /** First working day of the task. `null` for an unscheduled task. */
  startDate: IsoDate | null;
  /** Work days, never calendar days. Minimum 1. Milestones use 1. */
  durationDays: number;
  isMilestone?: boolean;
};

export type TaskDep = {
  predecessorId: TaskId;
  successorId: TaskId;
  depType: DepType;
  /** Work days. May be negative (lead), e.g. "start 2 days before X finishes". */
  lagDays: number;
};

/**
 * A *proposed* move. `cascade()` never writes — it returns these and the
 * caller decides (SPEC §4). `from` is kept so the UI can render the readable
 * diff SPEC §5 requires.
 */
export type TaskChange = {
  taskId: TaskId;
  fromStartDate: IsoDate | null;
  toStartDate: IsoDate;
  fromEndDate: IsoDate | null;
  toEndDate: IsoDate;
  /** True when the user asked for this move; false when it fell out of a dep. */
  direct: boolean;
};

/** Thrown when a write would create a dependency cycle. */
export class CycleError extends Error {
  readonly cycle: readonly TaskId[];

  constructor(cycle: readonly TaskId[]) {
    // SPEC §4: name the two tasks involved. A bare "cycle detected" leaves the
    // user hunting through a Gantt chart for the pair.
    const [a, b] = cycle;
    super(
      `Those tasks would depend on each other: ${a} → ${b} closes a loop ` +
        `(${cycle.join(" → ")}). Remove one of the links first.`,
    );
    this.name = "CycleError";
    this.cycle = cycle;
  }
}
