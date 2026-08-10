import {
  addWorkDays,
  finishDate,
  formatIsoDate,
  parseIsoDate,
  previousWorkingDay,
} from "./date";
import { buildGraph, detectCycle, topologicalOrder } from "./graph";
import { CycleError } from "./types";
import type { IsoDate, Task, TaskChange, TaskDep, TaskId, WorkCalendar } from "./types";

/**
 * Dependency cascade (SPEC §4).
 *
 * `cascade()` **never writes**. It returns proposed changes and the caller
 * decides — which is the whole basis of the confirm-before-send flow in
 * SPEC §5. A planner can call this to preview a voice command without a
 * transaction open.
 */

/** The earliest start a single dependency permits for its successor. */
function earliestStartFor(
  dep: TaskDep,
  predecessorStart: Date,
  predecessorDuration: number,
  successorDuration: number,
  cal: WorkCalendar,
): Date {
  const predFinish = finishDate(predecessorStart, predecessorDuration, cal);

  switch (dep.depType) {
    // Finish-to-start: the common case (SPEC §4 says optimise for it). The
    // successor starts the working day after the predecessor finishes, plus lag.
    case "FS":
      return addWorkDays(predFinish, 1 + dep.lagDays, cal);

    // Start-to-start: both begin together, offset by lag.
    case "SS":
      return addWorkDays(predecessorStart, dep.lagDays, cal);

    // Finish-to-finish: they end together (offset by lag). Back-solve the start
    // from the required finish.
    case "FF": {
      const requiredFinish = addWorkDays(predFinish, dep.lagDays, cal);
      return addWorkDays(requiredFinish, -(successorDuration - 1), cal);
    }

    // Start-to-finish: the successor finishes when the predecessor starts.
    // Rare, and almost always a modelling mistake, but SPEC asks for all four.
    case "SF": {
      const requiredFinish = addWorkDays(predecessorStart, dep.lagDays, cal);
      return addWorkDays(requiredFinish, -(successorDuration - 1), cal);
    }
  }
}

export type CascadeInput = {
  tasks: readonly Task[];
  deps: readonly TaskDep[];
  /** Tasks the user moved directly, with their new starts. */
  changed: ReadonlyMap<TaskId, IsoDate>;
  calendar: WorkCalendar;
};

/**
 * Recompute the schedule after a set of direct moves.
 *
 * Semantics, chosen deliberately:
 *
 *  - A task the user moved gets exactly the date they asked for (normalised to
 *    a working day). Their instruction wins over the dependency arithmetic.
 *  - Every other task is pulled to the **latest** of its predecessors'
 *    constraints — the earliest date at which all of them are satisfied.
 *  - A task with no predecessors and no direct move does not move. Otherwise
 *    editing one job would silently reflow unrelated ones.
 *
 * Unscheduled tasks (`startDate === null`) are skipped unless the caller moved
 * them directly; inventing a date for them would be a guess.
 */
export function cascade(input: CascadeInput): TaskChange[] {
  const { tasks, deps, changed, calendar } = input;

  // Reject cycles before doing any arithmetic — a cyclic graph has no
  // well-defined schedule and topologicalOrder would throw a vaguer error.
  const cycle = detectCycle(deps);
  if (cycle) throw new CycleError(cycle);

  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const { incoming } = buildGraph(deps);

  // Working copy of each task's start, mutated as we walk the graph in order.
  const startById = new Map<TaskId, Date | null>();
  for (const task of tasks) {
    const direct = changed.get(task.id);
    startById.set(
      task.id,
      direct
        ? parseIsoDate(direct)
        : task.startDate
          ? parseIsoDate(task.startDate)
          : null,
    );
  }

  const order = topologicalOrder(
    tasks.map((t) => t.id),
    deps.filter((d) => byId.has(d.predecessorId) && byId.has(d.successorId)),
  );

  const changes: TaskChange[] = [];

  for (const taskId of order) {
    const task = byId.get(taskId);
    if (!task) continue;

    const isDirect = changed.has(taskId);
    let resolved = startById.get(taskId) ?? null;

    if (isDirect) {
      // The user's date wins, normalised forward off a weekend or holiday.
      resolved = addWorkDays(resolved as Date, 0, calendar);
    } else {
      const predecessors = incoming.get(taskId) ?? [];
      let earliest: Date | null = null;

      for (const dep of predecessors) {
        const predTask = byId.get(dep.predecessorId);
        const predStart = startById.get(dep.predecessorId) ?? null;
        // A predecessor with no date constrains nothing.
        if (!predTask || !predStart) continue;

        const candidate = earliestStartFor(
          dep,
          predStart,
          predTask.durationDays,
          task.durationDays,
          calendar,
        );
        if (!earliest || candidate.getTime() > earliest.getTime()) {
          earliest = candidate;
        }
      }

      // No constraint and no direct move → leave it alone.
      if (earliest) resolved = earliest;
      else if (!resolved) continue;
    }

    if (!resolved) continue;
    startById.set(taskId, resolved);

    const toStart = formatIsoDate(resolved);
    const toEnd = formatIsoDate(finishDate(resolved, task.durationDays, calendar));
    const fromStart = task.startDate;
    const fromEnd = task.startDate
      ? formatIsoDate(
          finishDate(parseIsoDate(task.startDate), task.durationDays, calendar),
        )
      : null;

    // Only report actual movement. A cascade that lists unchanged tasks makes
    // the confirmation diff unreadable, which defeats its purpose.
    if (fromStart === toStart && fromEnd === toEnd) continue;

    changes.push({
      taskId,
      fromStartDate: fromStart,
      toStartDate: toStart,
      fromEndDate: fromEnd,
      toEndDate: toEnd,
      direct: isDirect,
    });
  }

  return changes;
}

/**
 * Shift every scheduled task in a set by a number of **work days**.
 * Backs the `shift_project` operation in SPEC §5.
 */
export function shiftTasks(
  tasks: readonly Task[],
  byWorkDays: number,
  cal: WorkCalendar,
): Map<TaskId, IsoDate> {
  const out = new Map<TaskId, IsoDate>();
  for (const task of tasks) {
    if (!task.startDate) continue;
    const from = parseIsoDate(task.startDate);
    const to =
      byWorkDays === 0
        ? from
        : byWorkDays > 0
          ? addWorkDays(from, byWorkDays, cal)
          : previousWorkingDay(addWorkDays(from, byWorkDays, cal), cal);
    out.set(task.id, formatIsoDate(to));
  }
  return out;
}
