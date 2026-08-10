import {
  addWorkDays,
  finishDate,
  formatIsoDate,
  parseIsoDate,
  workDaysBetween,
} from "./date";
import { buildGraph, detectCycle, topologicalOrder } from "./graph";
import { CycleError } from "./types";
import type { IsoDate, Task, TaskDep, TaskId, WorkCalendar } from "./types";

/**
 * Critical path (SPEC §4) — the chain of tasks with no slack, where a one-day
 * slip moves the whole job's finish date. It is what the Gantt highlights
 * (SPEC §7) and the first thing a contractor wants to see.
 *
 * Standard forward/backward float analysis, in work days:
 *
 *   forward  → earliest each task can start and finish
 *   backward → latest each can start and finish without moving project finish
 *   float    → the gap between them; zero float means critical
 */

export type ScheduleAnalysis = {
  /** Task ids with zero float, in dependency order. */
  criticalPath: TaskId[];
  /** Float in work days, per task. 0 = critical. */
  floatByTask: Map<TaskId, number>;
  earliestStart: Map<TaskId, IsoDate>;
  earliestFinish: Map<TaskId, IsoDate>;
  latestStart: Map<TaskId, IsoDate>;
  latestFinish: Map<TaskId, IsoDate>;
  /** Latest finish across the whole set, or null when nothing is scheduled. */
  projectFinish: IsoDate | null;
};

/** Earliest start `dep` permits for its successor, given the predecessor's dates. */
function forwardConstraint(
  dep: TaskDep,
  predStart: Date,
  predDuration: number,
  succDuration: number,
  cal: WorkCalendar,
): Date {
  const predFinish = finishDate(predStart, predDuration, cal);
  switch (dep.depType) {
    case "FS":
      return addWorkDays(predFinish, 1 + dep.lagDays, cal);
    case "SS":
      return addWorkDays(predStart, dep.lagDays, cal);
    case "FF":
      return addWorkDays(addWorkDays(predFinish, dep.lagDays, cal), -(succDuration - 1), cal);
    case "SF":
      return addWorkDays(addWorkDays(predStart, dep.lagDays, cal), -(succDuration - 1), cal);
  }
}

/**
 * Latest finish `dep` permits for its *predecessor*, given the successor's
 * latest dates. The inverse of `forwardConstraint`.
 */
function backwardConstraint(
  dep: TaskDep,
  succLatestStart: Date,
  succLatestFinish: Date,
  predDuration: number,
  cal: WorkCalendar,
): Date {
  switch (dep.depType) {
    case "FS":
      return addWorkDays(succLatestStart, -(1 + dep.lagDays), cal);
    case "SS":
      // Predecessor may start at succLS - lag; convert that start to a finish.
      return finishDate(addWorkDays(succLatestStart, -dep.lagDays, cal), predDuration, cal);
    case "FF":
      return addWorkDays(succLatestFinish, -dep.lagDays, cal);
    case "SF":
      // Successor's finish pins the predecessor's *start*.
      return finishDate(
        addWorkDays(succLatestFinish, -dep.lagDays, cal),
        predDuration,
        cal,
      );
  }
}

export function analyseSchedule(
  tasks: readonly Task[],
  deps: readonly TaskDep[],
  cal: WorkCalendar,
): ScheduleAnalysis {
  const cycle = detectCycle(deps);
  if (cycle) throw new CycleError(cycle);

  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const relevant = deps.filter(
    (d) => byId.has(d.predecessorId) && byId.has(d.successorId),
  );
  const { incoming, outgoing } = buildGraph(relevant);
  const order = topologicalOrder(tasks.map((t) => t.id), relevant);

  const es = new Map<TaskId, Date>();
  const ef = new Map<TaskId, Date>();

  // ── Forward pass ──────────────────────────────────────────────────────────
  for (const id of order) {
    const task = byId.get(id);
    if (!task || !task.startDate) continue;

    let start = parseIsoDate(task.startDate);
    for (const dep of incoming.get(id) ?? []) {
      const pred = byId.get(dep.predecessorId);
      const predStart = es.get(dep.predecessorId);
      if (!pred || !predStart) continue;
      const candidate = forwardConstraint(
        dep,
        predStart,
        pred.durationDays,
        task.durationDays,
        cal,
      );
      if (candidate.getTime() > start.getTime()) start = candidate;
    }
    es.set(id, start);
    ef.set(id, finishDate(start, task.durationDays, cal));
  }

  // Project finish is the latest earliest-finish across everything scheduled.
  let projectFinish: Date | null = null;
  for (const finish of ef.values()) {
    if (!projectFinish || finish.getTime() > projectFinish.getTime()) {
      projectFinish = finish;
    }
  }

  // ── Backward pass ─────────────────────────────────────────────────────────
  const lf = new Map<TaskId, Date>();
  const ls = new Map<TaskId, Date>();

  for (const id of [...order].reverse()) {
    const task = byId.get(id);
    if (!task || !es.has(id) || !projectFinish) continue;

    let latestFinish = projectFinish;
    for (const dep of outgoing.get(id) ?? []) {
      const succLs = ls.get(dep.successorId);
      const succLf = lf.get(dep.successorId);
      if (!succLs || !succLf) continue;
      const candidate = backwardConstraint(
        dep,
        succLs,
        succLf,
        task.durationDays,
        cal,
      );
      if (candidate.getTime() < latestFinish.getTime()) latestFinish = candidate;
    }
    lf.set(id, latestFinish);
    ls.set(id, addWorkDays(latestFinish, -(task.durationDays - 1), cal));
  }

  // ── Float ─────────────────────────────────────────────────────────────────
  const floatByTask = new Map<TaskId, number>();
  const criticalPath: TaskId[] = [];

  for (const id of order) {
    const start = es.get(id);
    const latestStart = ls.get(id);
    if (!start || !latestStart) continue;
    const slack = workDaysBetween(start, latestStart, cal);
    floatByTask.set(id, slack);
    if (slack <= 0) criticalPath.push(id);
  }

  const toIso = (m: Map<TaskId, Date>) =>
    new Map<TaskId, IsoDate>([...m].map(([k, v]) => [k, formatIsoDate(v)]));

  return {
    criticalPath,
    floatByTask,
    earliestStart: toIso(es),
    earliestFinish: toIso(ef),
    latestStart: toIso(ls),
    latestFinish: toIso(lf),
    projectFinish: projectFinish ? formatIsoDate(projectFinish) : null,
  };
}

/** Just the critical path, for callers that don't need the full analysis. */
export function criticalPath(
  tasks: readonly Task[],
  deps: readonly TaskDep[],
  cal: WorkCalendar,
): TaskId[] {
  return analyseSchedule(tasks, deps, cal).criticalPath;
}
