/**
 * The date engine (SPEC §4). Pure functions — no database, no network.
 *
 * Import from here rather than the individual modules; the split is an
 * implementation detail.
 */

export * from "./types";
export {
  addCalendarDays,
  addWorkDays,
  finishDate,
  finishIsoDate,
  formatIsoDate,
  isWorkingDay,
  isoWeekday,
  nextWorkingDay,
  parseIsoDate,
  previousWorkingDay,
  todayInZone,
  workDaysBetween,
} from "./date";
export { buildGraph, detectCycle, topologicalOrder, wouldCreateCycle } from "./graph";
export type { DepGraph } from "./graph";
export { cascade, shiftTasks } from "./cascade";
export type { CascadeInput } from "./cascade";
export { analyseSchedule, criticalPath } from "./critical-path";
export type { ScheduleAnalysis } from "./critical-path";
