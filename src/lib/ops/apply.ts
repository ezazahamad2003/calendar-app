import {
  addWorkDays,
  cascade,
  finishIsoDate,
  formatIsoDate,
  parseIsoDate,
  previousWorkingDay,
} from "@/lib/schedule";
import type { IsoDate, Task, TaskDep, WorkCalendar } from "@/lib/schedule";
import type { Activity, Contact, Move, ScheduleDoc } from "@/lib/store/types";
import type { Operation } from "./schema";

/**
 * Turn a list of operations into the schedule they produce.
 *
 * One function does this for both the preview and the write, and that is the
 * whole point. Every date the contractor reads before tapping Confirm comes
 * out of `cascade()` here; if the preview were computed anywhere else — or,
 * worse, described by the model — it could disagree with what actually
 * happens, and a confirmation screen that lies about its own consequences is
 * worse than no confirmation screen.
 *
 * Pure: takes a document, returns a new one. Writes nothing.
 */

export type ApplyResult = {
  doc: ScheduleDoc;
  /** Every activity whose dates changed, direct and cascaded. */
  moves: Move[];
  /** Human-readable notes about things that happened but are not date moves. */
  notices: string[];
};

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "activity"
  );
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function engineTasks(tasks: readonly Activity[]): Task[] {
  return tasks.map((t) => ({
    id: t.id,
    startDate: t.startDate,
    durationDays: t.durationDays,
  }));
}

/**
 * Shift a date by working days.
 *
 * Backwards needs the extra normalisation: `addWorkDays` lands on a working
 * day by stepping *forward*, so pulling a Monday job back over a weekend would
 * otherwise settle on the Monday it started from.
 */
function shiftDate(date: IsoDate, byDays: number, cal: WorkCalendar): IsoDate {
  const from = parseIsoDate(date);
  if (byDays === 0) return date;
  const moved = addWorkDays(from, byDays, cal);
  return formatIsoDate(byDays > 0 ? moved : previousWorkingDay(moved, cal));
}

export function applyOperations(
  doc: ScheduleDoc,
  operations: readonly Operation[],
): ApplyResult {
  const cal: WorkCalendar = doc.calendar;

  // Working copies. Nothing touches `doc`.
  let tasks: Activity[] = doc.tasks.map((t) => ({ ...t }));
  let deps: TaskDep[] = doc.deps.map((d) => ({ ...d }));
  const contacts: Contact[] = doc.contacts.map((c) => ({ ...c }));
  const notices: string[] = [];

  /** Direct date changes, fed to `cascade` once at the end. */
  const directMoves = new Map<string, IsoDate>();
  const newDurations = new Map<string, number>();
  /** Activities that gained or lost a date outright, which cascade cannot express. */
  const dateCleared = new Set<string>();
  const added = new Set<string>();
  const removed = new Set<string>();

  const taskIndex = (id: string) => tasks.findIndex((t) => t.id === id);

  for (const op of operations) {
    switch (op.type) {
      case "push_activity": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        const task = tasks[i];
        if (!task.startDate) {
          notices.push(
            `"${task.name}" has no date yet, so there was nothing to push. ` +
              `Give it a date first.`,
          );
          break;
        }
        directMoves.set(task.id, shiftDate(task.startDate, op.byDays, cal));
        break;
      }

      case "move_activity": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        directMoves.set(op.taskId, op.startDate);
        dateCleared.delete(op.taskId);
        break;
      }

      case "resize_activity": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        newDurations.set(op.taskId, op.durationDays);
        break;
      }

      case "clear_dates": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        dateCleared.add(op.taskId);
        directMoves.delete(op.taskId);
        break;
      }

      case "set_status": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        tasks[i] = { ...tasks[i], status: op.status as Activity["status"] };
        break;
      }

      case "rename_activity": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        tasks[i] = { ...tasks[i], name: op.name };
        break;
      }

      case "set_notes": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        tasks[i] = { ...tasks[i], notes: op.notes };
        break;
      }

      case "set_team": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        tasks[i] = {
          ...tasks[i],
          team: op.team,
          // An explicit contact wins; otherwise match the team name to one we
          // already have, so renaming the row does not silently orphan it.
          contactId:
            op.contactId ??
            (op.team
              ? (contacts.find(
                  (c) => c.name.toLowerCase() === op.team?.toLowerCase(),
                )?.id ?? null)
              : null),
        };
        break;
      }

      case "add_activity": {
        const taken = new Set(tasks.map((t) => t.id));
        const id = uniqueId(slug(op.name), taken);
        const sectionId = op.sectionId ?? doc.sections[0]?.id;
        if (!sectionId) {
          notices.push(`There is no section to put "${op.name}" in.`);
          break;
        }
        const team = op.team ?? null;
        const contactId = team
          ? (contacts.find((c) => c.name.toLowerCase() === team.toLowerCase())?.id ?? null)
          : null;

        tasks.push({
          id,
          sectionId,
          name: op.name,
          team,
          contactId,
          startDate: op.startDate ?? null,
          durationDays: op.durationDays,
          status: (op.status as Activity["status"]) ?? "planned",
          notes: null,
          // Straight to the bottom of its section, where a new row on the
          // paper chart would go.
          order: Math.max(-1, ...tasks.map((t) => t.order)) + 1,
        });
        added.add(id);

        for (const predecessor of op.after) {
          deps.push({
            predecessorId: predecessor,
            successorId: id,
            depType: "FS",
            lagDays: 0,
          });
        }
        break;
      }

      case "remove_activity": {
        const i = taskIndex(op.taskId);
        if (i < 0) break;
        removed.add(op.taskId);
        tasks = tasks.filter((t) => t.id !== op.taskId);
        // Links to a task that no longer exists fail the document's own
        // integrity check, so they go with it.
        deps = deps.filter(
          (d) => d.predecessorId !== op.taskId && d.successorId !== op.taskId,
        );
        break;
      }

      case "add_dependency":
        deps.push({
          predecessorId: op.predecessorId,
          successorId: op.successorId,
          depType: op.depType,
          lagDays: op.lagDays,
        });
        break;

      case "remove_dependency":
        deps = deps.filter(
          (d) =>
            !(d.predecessorId === op.predecessorId && d.successorId === op.successorId),
        );
        break;

      case "add_contact": {
        const taken = new Set(contacts.map((c) => c.id));
        contacts.push({
          id: uniqueId(`c-${slug(op.name)}`, taken),
          name: op.name,
          company: op.company ?? null,
          trade: op.trade ?? null,
          email: op.email ?? null,
          phone: op.phone ?? null,
        });
        break;
      }

      case "update_contact": {
        const i = contacts.findIndex((c) => c.id === op.contactId);
        if (i < 0) break;
        const current = contacts[i];
        contacts[i] = {
          ...current,
          // `?? current` throughout: an absent field means "leave it alone",
          // so renaming a contact cannot blank their address.
          name: op.name ?? current.name,
          company: op.company ?? current.company,
          trade: op.trade ?? current.trade,
          email: op.email ?? current.email,
          phone: op.phone ?? current.phone,
        };
        break;
      }
    }
  }

  // ── Dates ───────────────────────────────────────────────────────────────────
  //
  // Everything above only recorded intent. The dates themselves are settled
  // here, in one pass, by the engine.

  const beforeById = new Map(doc.tasks.map((t) => [t.id, t]));

  // Clearing a date is not a move, so it is applied before the cascade rather
  // than expressed to it.
  for (const id of dateCleared) {
    const i = taskIndex(id);
    if (i >= 0) tasks[i] = { ...tasks[i], startDate: null };
  }

  const changes = cascade({
    tasks: engineTasks(tasks),
    deps,
    changed: directMoves,
    durations: newDurations,
    calendar: cal,
  });

  for (const change of changes) {
    const i = taskIndex(change.taskId);
    if (i >= 0) tasks[i] = { ...tasks[i], startDate: change.toStartDate };
  }
  for (const [id, duration] of newDurations) {
    const i = taskIndex(id);
    if (i >= 0) tasks[i] = { ...tasks[i], durationDays: duration };
  }

  // ── What moved ──────────────────────────────────────────────────────────────
  //
  // Recomputed from before-and-after rather than taken from `changes`, so that
  // resizes, cleared dates and newly added activities appear in the same list
  // the notifications are built from. A change nobody can see in the diff is a
  // change nobody consented to.

  const moves: Move[] = [];
  for (const task of tasks) {
    const before = beforeById.get(task.id);
    const wasStart = before?.startDate ?? null;
    const wasEnd =
      before?.startDate != null
        ? finishIsoDate(before.startDate, before.durationDays, cal)
        : null;
    const nowStart = task.startDate;
    const nowEnd = task.startDate
      ? finishIsoDate(task.startDate, task.durationDays, cal)
      : null;

    if (wasStart === nowStart && wasEnd === nowEnd) continue;

    moves.push({
      taskId: task.id,
      taskName: task.name,
      fromStartDate: wasStart,
      toStartDate: nowStart,
      fromEndDate: wasEnd,
      toEndDate: nowEnd,
      // Direct when the user named this activity; false when a dependency
      // dragged it along. The notification wording depends on the distinction.
      direct:
        directMoves.has(task.id) ||
        newDurations.has(task.id) ||
        dateCleared.has(task.id) ||
        added.has(task.id),
    });
  }

  for (const id of removed) {
    const before = beforeById.get(id);
    if (!before?.startDate) continue;
    moves.push({
      taskId: id,
      taskName: before.name,
      fromStartDate: before.startDate,
      toStartDate: null,
      fromEndDate: finishIsoDate(before.startDate, before.durationDays, cal),
      toEndDate: null,
      direct: true,
    });
  }

  return {
    doc: { ...doc, tasks, deps, contacts },
    moves,
    notices,
  };
}
