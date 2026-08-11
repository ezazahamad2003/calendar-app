import { getEnv } from "@/lib/env";
import { projectColor } from "@/lib/project-color";
import { humanRange } from "@/lib/format-date";
import { PlannerError } from "./validate";
import type { PlannerContext } from "./context";
import type { Plan } from "./schema";
import {
  addWorkDays,
  cascade,
  detectCycle,
  formatIsoDate,
  parseIsoDate,
  shiftTasks,
} from "@/lib/schedule";
import type { Task, TaskDep } from "@/lib/schedule";

/**
 * Turning a Plan into the diff a person confirms.
 *
 * Split out of actions.ts, which is a `"use server"` module and so may only
 * export async functions — meaning none of this could be imported by a test.
 * It is the piece most worth testing: every date the user reads before
 * confirming is produced here, from the schedule engine, and a plan whose
 * effects this fails to describe is a plan the user cannot confirm at all.
 *
 * Pure. No database, no network — it takes a Plan and a PlannerContext and
 * returns what would happen.
 */

// ── Preview types (serializable, rendered by the diff UI) ────────────────────

export type PreviewMove = {
  name: string;
  fromStart: string | null;
  toStart: string;
  fromEnd: string | null;
  toEnd: string;
  /** Direct = the user asked; otherwise it cascaded off a dependency. */
  direct: boolean;
  isNew: boolean;
  /** "08:00 – 15:30" once the plan has been applied, or null for all day. */
  window: string | null;
};

/**
 * Something this plan takes away.
 *
 * `alsoRemoved` is the whole reason this type exists rather than a line of
 * text: deleting a job is one click that takes its tasks, its links, its crew
 * assignments and its calendar entries with it, and the person confirming has
 * to be told that before they click, not after.
 */
export type PlanRemoval = {
  kind: "job" | "task" | "person" | "assignment" | "link";
  name: string;
  detail: string | null;
  alsoRemoved: string[];
};

export type PlanPreview = {
  summary: string;
  /** Blocks the apply. */
  clarification: string | null;
  /** Advisory only — the plan still applies. */
  notes: string | null;
  confidence: "high" | "low";
  newProjects: { name: string; clientName: string | null; color: string }[];
  /** Edits to existing rows: what it was, what it becomes. */
  edits: { what: string; from: string; to: string }[];
  moves: PreviewMove[];
  /**
   * Tasks this plan creates with no date on them.
   *
   * They never reach the cascade — there is nothing to schedule — so they
   * appear in none of the other lists. Listing them separately is what stops
   * "add a plumbing task, I'll date it later" from rendering an empty diff
   * with no Confirm button on it.
   */
  newTasks: { name: string; projectName: string | null; window: string | null }[];
  /** Deletions, listed first in the UI and styled as the destructive thing they are. */
  removals: PlanRemoval[];
  statusChanges: { name: string; from: string; to: string }[];
  assignments: { taskName: string; contactName: string }[];
  newDeps: { predecessorName: string; successorName: string; depType: string; lagDays: number }[];
  newContacts: { name: string; company: string | null; trade: string | null }[];
  emails: { recipients: string[]; subject: string; body: string }[];
  /**
   * Notifications the app adds on the user's behalf — one per assigned person
   * per scheduled task. Listed separately from `emails` (which the planner
   * asked for) so the diff never hides an outbound message behind "assigned
   * Alex to framing".
   */
  notifications: {
    contactName: string;
    taskName: string;
    when: string;
    invite: boolean;
  }[];
  /** Nothing to do — e.g. pure clarification. */
  empty: boolean;
};

// ── Engine assembly ──────────────────────────────────────────────────────────

export type Assembled = {
  engineTasks: Task[];
  engineDeps: TaskDep[];
  directChanges: Map<string, string>;
  durationOverrides: Map<string, number>;
  /** What a resized task's duration was before the plan touched it. */
  originalDurations: Map<string, number>;
  nameOf: (id: string) => string;
  newTaskIds: Set<string>;
  /** Existing tasks this plan removes, directly or with their project. */
  deletedTaskIds: Set<string>;
  cycle: string[] | null;
};

/** "08:00 – 15:30", or null when the task runs all day. */
export function formatWindow(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string | null {
  if (!startTime) return null;
  return endTime ? `${startTime} – ${endTime}` : startTime;
}

/**
 * Fold a Plan's operations into one engine input: existing tasks plus temp
 * tasks ("$tN"), existing deps plus new ones, and a single map of direct
 * moves. One cascade over the lot yields every knock-on effect — including
 * new tasks pulled into place by their predecessors.
 */
export function assemble(plan: Plan, ctx: PlannerContext): Assembled {
  // Everything this plan removes, worked out first: a deleted task must not
  // reach the cascade, or a predecessor moving would produce a diff line about
  // rescheduling something that is on its way out.
  const deletedTaskIds = new Set<string>();
  const removedDeps: { predecessorId: string; successorId: string }[] = [];
  for (const op of plan.operations) {
    if (op.type === "delete_task") deletedTaskIds.add(op.taskId);
    if (op.type === "delete_project") {
      for (const t of ctx.tasks) {
        if (t.projectId === op.projectId) deletedTaskIds.add(t.id);
      }
    }
    if (op.type === "remove_dependency") {
      removedDeps.push({ predecessorId: op.predecessorId, successorId: op.successorId });
    }
  }

  const engineTasks: Task[] = ctx.tasks
    .filter((t) => !deletedTaskIds.has(t.id))
    .map((t) => ({
      id: t.id,
      startDate: t.startDate,
      durationDays: t.durationDays,
      isMilestone: t.isMilestone,
    }));
  const engineDeps: TaskDep[] = ctx.deps
    .filter(
      (d) =>
        !deletedTaskIds.has(d.predecessorId) &&
        !deletedTaskIds.has(d.successorId) &&
        !removedDeps.some(
          (r) =>
            r.predecessorId === d.predecessorId && r.successorId === d.successorId,
        ),
    )
    .map((d) => ({ ...d }));
  const directChanges = new Map<string, string>();
  const durationOverrides = new Map<string, number>();
  const originalDurations = new Map<string, number>();
  const names = new Map<string, string>(ctx.tasks.map((t) => [t.id, t.name]));
  const newTaskIds = new Set<string>();

  const taskById = new Map(ctx.tasks.map((t) => [t.id, t]));

  plan.operations.forEach((op, index) => {
    switch (op.type) {
      case "create_task": {
        const tempId = `$t${index}`;
        newTaskIds.add(tempId);
        names.set(tempId, op.name);
        // Deliberately `null`, not `op.startDate`: a task that does not exist
        // yet has no date to have moved *from*. Seeding it with the date the
        // plan asks for makes the cascade compare that date against itself,
        // decide nothing changed, and drop the task from the diff entirely —
        // which emptied the preview, hid the Confirm button, and left the new
        // task's assignee with no notification. Where it goes is a direct
        // change, below.
        engineTasks.push({
          id: tempId,
          startDate: null,
          durationDays: op.isMilestone ? 1 : op.durationDays,
          isMilestone: op.isMilestone,
        });
        if (op.startDate) directChanges.set(tempId, op.startDate);
        for (const dep of op.deps) {
          engineDeps.push({
            predecessorId: dep,
            successorId: tempId,
            depType: "FS",
            lagDays: 0,
          });
        }
        break;
      }
      case "move_task":
        directChanges.set(op.taskId, op.startDate);
        break;
      case "shift_task": {
        const current = taskById.get(op.taskId)?.startDate;
        if (current) {
          directChanges.set(
            op.taskId,
            formatIsoDate(addWorkDays(parseIsoDate(current), op.byDays, ctx.calendar)),
          );
        }
        break;
      }
      case "resize_task": {
        const t = engineTasks.find((x) => x.id === op.taskId);
        if (t) {
          // Handed to the cascade as an override rather than written onto the
          // task: `t.durationDays` is where it ends *now*, and overwriting it
          // is what used to make a resize look like no change at all.
          originalDurations.set(op.taskId, t.durationDays);
          durationOverrides.set(op.taskId, op.durationDays);
          // Re-anchor so the cascade re-evaluates this task's successors.
          if (t.startDate && !directChanges.has(op.taskId)) {
            directChanges.set(op.taskId, t.startDate);
          }
        }
        break;
      }
      case "shift_project": {
        const projectTasks = ctx.tasks.filter((t) => t.projectId === op.projectId);
        const shifted = shiftTasks(
          projectTasks.map((t) => ({
            id: t.id,
            startDate: t.startDate,
            durationDays: t.durationDays,
          })),
          op.byDays,
          ctx.calendar,
        );
        for (const [id, date] of shifted) directChanges.set(id, date);
        break;
      }
      case "add_dependency":
        engineDeps.push({
          predecessorId: op.predecessorId,
          successorId: op.successorId,
          depType: op.depType,
          lagDays: op.lagDays,
        });
        break;
      default:
        break;
    }
  });

  return {
    engineTasks,
    engineDeps,
    directChanges,
    durationOverrides,
    originalDurations,
    nameOf: (id: string) => names.get(id) ?? "unnamed task",
    newTaskIds,
    deletedTaskIds,
    cycle: detectCycle(engineDeps),
  };
}

/**
 * Who needs telling, and about what.
 *
 * SPEC §7 wants a sub to learn about his own dates without the contractor
 * remembering to say so. Every assignment the plan makes — whether the task is
 * new or already existed — produces one notification carrying the resolved
 * dates, which are the cascade's output rather than anything the model said.
 *
 * Derived here, once, so the diff the user confirms and the messages that
 * actually go out cannot describe different things.
 */
export type NotifyIntent = {
  /** Real contact id, or "$cN" for one created in this same plan. */
  contactRef: string;
  contactName: string;
  email: string | null;
  /** Real task id, or "$tN". */
  taskRef: string;
  taskName: string;
  /** Never null: an undated task produces no notification at all. */
  startDate: string;
  endDate: string | null;
};

function collectNotifications(
  plan: Plan,
  ctx: PlannerContext,
  asm: Assembled,
  changes: ReturnType<typeof cascade>,
): NotifyIntent[] {
  const changeByTask = new Map(changes.map((c) => [c.taskId, c]));
  const taskById = new Map(ctx.tasks.map((t) => [t.id, t]));
  const contactById = new Map(ctx.contacts.map((c) => [c.id, c]));

  const planned = new Map<string, { name: string; email: string | null }>();
  plan.operations.forEach((op, index) => {
    if (op.type === "create_contact") {
      planned.set(`$c${index}`, { name: op.name, email: op.email ?? null });
    }
  });

  const pairs: { contactRef: string; taskRef: string; taskName: string }[] = [];
  plan.operations.forEach((op, index) => {
    if (op.type === "create_task" && op.assigneeId) {
      pairs.push({ contactRef: op.assigneeId, taskRef: `$t${index}`, taskName: op.name });
    }
    if (op.type === "assign_task") {
      pairs.push({
        contactRef: op.contactId,
        taskRef: op.taskId,
        taskName: asm.nameOf(op.taskId),
      });
    }
  });

  const seen = new Set<string>();
  const out: NotifyIntent[] = [];

  for (const pair of pairs) {
    // One message per person per task, however many ways the plan said it.
    const key = `${pair.contactRef}::${pair.taskRef}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const existing = contactById.get(pair.contactRef);
    const fresh = planned.get(pair.contactRef);
    const resolved = changeByTask.get(pair.taskRef);
    const current = taskById.get(pair.taskRef);
    const startDate = resolved?.toStartDate ?? current?.startDate ?? null;

    // A task with no dates has nothing to tell anyone. Assigning someone to
    // undated work is a normal thing to do — it just isn't news yet, and
    // sending it anyway produced the memorable "You're scheduled for
    // Plumberry: not yet scheduled." They get told when it lands on a day.
    if (!startDate) continue;

    out.push({
      contactRef: pair.contactRef,
      contactName: existing?.name ?? fresh?.name ?? "someone",
      // ctx deliberately never carries addresses (context.ts exposes only
      // hasEmail), so an existing contact's address is fetched at send time.
      // A planned contact's is whatever the plan supplies.
      email: existing ? (existing.hasEmail ? "on file" : null) : (fresh?.email ?? null),
      taskRef: pair.taskRef,
      taskName: pair.taskName,
      startDate,
      endDate: resolved?.toEndDate ?? current?.endDate ?? null,
    });
  }

  return out;
}

/** "3 tasks", "1 dependency", or null when there are none to mention. */
function count(n: number, singular: string, plural = `${singular}s`): string | null {
  if (n === 0) return null;
  return `${n} ${n === 1 ? singular : plural}`;
}

export function buildPreview(
  plan: Plan,
  ctx: PlannerContext,
): { preview: PlanPreview; asm: Assembled; notify: NotifyIntent[] } {
  const asm = assemble(plan, ctx);

  if (asm.cycle) {
    const loop = asm.cycle.map(asm.nameOf).join(" → ");
    throw new PlannerError(
      `That plan would create a dependency loop (${loop}). Nothing was changed.`,
    );
  }

  const changes = cascade({
    tasks: asm.engineTasks,
    deps: asm.engineDeps,
    changed: asm.directChanges,
    durations: asm.durationOverrides,
    calendar: ctx.calendar,
  });

  const contactName = new Map(ctx.contacts.map((c) => [c.id, c.name]));
  const taskById = new Map(ctx.tasks.map((t) => [t.id, t]));
  const projectName = new Map(ctx.projects.map((p) => [p.id, p.name]));

  const newProjects: PlanPreview["newProjects"] = [];
  const edits: PlanPreview["edits"] = [];
  const newTasks: PlanPreview["newTasks"] = [];
  const removals: PlanRemoval[] = [];
  const statusChanges: PlanPreview["statusChanges"] = [];
  const assignments: PlanPreview["assignments"] = [];
  const newDeps: PlanPreview["newDeps"] = [];
  const newContacts: PlanPreview["newContacts"] = [];
  const emails: PlanPreview["emails"] = [];

  // Contacts created in this same plan aren't in ctx yet, so name and address
  // lookups have to fall back to what the plan itself declares.
  const plannedContact = new Map<string, { name: string; email: string | null }>();
  const plannedProject = new Map<string, string>();
  plan.operations.forEach((op, index) => {
    if (op.type === "create_contact") {
      plannedContact.set(`$c${index}`, { name: op.name, email: op.email ?? null });
    }
    if (op.type === "create_project") plannedProject.set(`$p${index}`, op.name);
  });
  const nameOfContact = (id: string) =>
    contactName.get(id) ?? plannedContact.get(id)?.name ?? "someone";

  /**
   * Each task's on-site window once the plan lands — current times, overwritten
   * by whatever this plan sets. Every date line the user reads carries it, so
   * a move that also changes the hours cannot show one and hide the other.
   */
  const windows = new Map<string, { start: string | null; end: string | null }>(
    ctx.tasks.map((t) => [t.id, { start: t.startTime, end: t.endTime }]),
  );
  plan.operations.forEach((op, index) => {
    if (op.type === "create_task") {
      windows.set(`$t${index}`, { start: op.startTime ?? null, end: op.endTime ?? null });
    }
    if (op.type === "update_task") {
      const current = windows.get(op.taskId) ?? { start: null, end: null };
      windows.set(
        op.taskId,
        op.clearTimes
          ? { start: null, end: null }
          : {
              start: op.startTime ?? current.start,
              end: op.endTime ?? current.end,
            },
      );
    }
  });
  const windowFor = (taskRef: string) => {
    const w = windows.get(taskRef);
    return w ? formatWindow(w.start, w.end) : null;
  };

  const changedTaskIds = new Set(changes.map((c) => c.taskId));

  plan.operations.forEach((op, index) => {
    switch (op.type) {
      case "create_project":
        newProjects.push({
          name: op.name,
          clientName: op.clientName ?? null,
          color: projectColor(op.name, op.color).fill,
        });
        break;
      case "update_project": {
        // Shown field by field, with the old value beside the new one. A
        // rename that reads "Bargaining Real Estate → Barney Real Estate" is
        // unmistakably a rename; "Barney Real Estate" alone is what made the
        // last one look like a new job.
        const before = ctx.projects.find((p) => p.id === op.projectId);
        const label = before?.name ?? "that job";
        if (op.name != null) edits.push({ what: "Job name", from: label, to: op.name });
        if (op.clientName != null)
          edits.push({
            what: `${label} client`,
            from: before?.clientName ?? "—",
            to: op.clientName,
          });
        if (op.jobNumber != null)
          edits.push({
            what: `${label} job #`,
            from: before?.jobNumber ?? "—",
            to: op.jobNumber,
          });
        if (op.status != null)
          edits.push({ what: `${label} status`, from: "—", to: op.status });
        if (op.address != null)
          edits.push({ what: `${label} address`, from: "—", to: op.address });
        break;
      }
      case "update_task": {
        const before = ctx.tasks.find((t) => t.id === op.taskId);
        const label = before?.name ?? "that task";
        if (op.name != null) edits.push({ what: "Task name", from: label, to: op.name });
        if (op.trade != null)
          edits.push({ what: `${label} trade`, from: before?.trade ?? "—", to: op.trade });
        if (op.clearTimes || op.startTime != null || op.endTime != null) {
          const was = formatWindow(before?.startTime, before?.endTime) ?? "all day";
          const now = windowFor(op.taskId) ?? "all day";
          if (was !== now) edits.push({ what: `${label} hours`, from: was, to: now });
        }
        break;
      }
      case "update_contact": {
        const before = ctx.contacts.find((c) => c.id === op.contactId);
        const label = before?.name ?? "that person";
        if (op.name != null) edits.push({ what: "Name", from: label, to: op.name });
        if (op.company != null)
          edits.push({
            what: `${label} company`,
            from: before?.company ?? "—",
            to: op.company,
          });
        if (op.trade != null)
          edits.push({ what: `${label} trade`, from: before?.trade ?? "—", to: op.trade });
        if (op.email != null)
          edits.push({
            what: `${label} email`,
            from: before?.hasEmail ? "on file" : "—",
            to: op.email,
          });
        if (op.phone != null)
          edits.push({ what: `${label} phone`, from: "—", to: op.phone });
        break;
      }
      case "resize_task": {
        // A resize that does not move the task shows up nowhere in the
        // cascade — same start, and the engine derives "from" and "to" ends
        // from the same (already overridden) duration. Stated plainly here
        // instead, so the diff is never empty for a change that will happen.
        const was = asm.originalDurations.get(op.taskId);
        if (was != null && was !== op.durationDays) {
          const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
          edits.push({
            what: `${asm.nameOf(op.taskId)} duration`,
            from: days(was),
            to: days(op.durationDays),
          });
        }
        break;
      }
      case "set_status":
        statusChanges.push({
          name: asm.nameOf(op.taskId),
          from: taskById.get(op.taskId)?.status ?? "planned",
          to: op.status,
        });
        break;
      case "assign_task":
        assignments.push({
          taskName: asm.nameOf(op.taskId),
          contactName: nameOfContact(op.contactId),
        });
        break;
      case "add_dependency":
        newDeps.push({
          predecessorName: asm.nameOf(op.predecessorId),
          successorName: asm.nameOf(op.successorId),
          depType: op.depType,
          lagDays: op.lagDays,
        });
        break;
      // Deletions. The name of the thing, then everything that leaves with it
      // — counted from the context rather than described in prose, because
      // "and 11 tasks" is the number that stops a wrong confirm.
      case "delete_project": {
        const project = ctx.projects.find((p) => p.id === op.projectId);
        const tasks = ctx.tasks.filter((t) => t.projectId === op.projectId);
        const taskIdSet = new Set(tasks.map((t) => t.id));
        const links = ctx.deps.filter(
          (d) => taskIdSet.has(d.predecessorId) || taskIdSet.has(d.successorId),
        );
        const bookings = tasks.reduce((n, t) => n + t.assigneeIds.length, 0);
        // The task count comes off the project, which counts them all; the
        // links and bookings come off the context, which only carries an active
        // job's schedule. So they are stated only when they were actually
        // looked at — an under-count here would be exactly the reassurance
        // nobody should be given before a delete.
        const detailed = tasks.length > 0 || (project?.taskCount ?? 0) === 0;
        removals.push({
          kind: "job",
          name: project?.name ?? "That job",
          detail: project?.clientName ?? null,
          alsoRemoved: [
            count(project?.taskCount ?? tasks.length, "task"),
            detailed ? count(links.length, "dependency", "dependencies") : null,
            detailed ? count(bookings, "crew booking") : null,
          ].filter((line): line is string => line !== null),
        });
        break;
      }
      case "delete_task": {
        const task = ctx.tasks.find((t) => t.id === op.taskId);
        const links = ctx.deps.filter(
          (d) => d.predecessorId === op.taskId || d.successorId === op.taskId,
        );
        removals.push({
          kind: "task",
          name: task?.name ?? "That task",
          detail: task?.startDate
            ? humanRange(task.startDate, task.endDate)
            : "no date yet",
          alsoRemoved: [
            count(links.length, "dependency", "dependencies"),
            count(task?.assigneeIds.length ?? 0, "crew booking"),
          ].filter((line): line is string => line !== null),
        });
        break;
      }
      case "delete_contact": {
        const contact = ctx.contacts.find((c) => c.id === op.contactId);
        const booked = ctx.tasks.filter((t) => t.assigneeIds.includes(op.contactId));
        removals.push({
          kind: "person",
          name: contact?.name ?? "That person",
          detail: contact?.company ?? contact?.trade ?? null,
          alsoRemoved: [count(booked.length, "task booking")].filter(
            (line): line is string => line !== null,
          ),
        });
        break;
      }
      case "unassign_task":
        removals.push({
          kind: "assignment",
          name: nameOfContact(op.contactId),
          detail: `off ${asm.nameOf(op.taskId)}`,
          alsoRemoved: [],
        });
        break;
      case "remove_dependency":
        removals.push({
          kind: "link",
          name: `${asm.nameOf(op.successorId)} no longer waits for ${asm.nameOf(op.predecessorId)}`,
          detail: null,
          alsoRemoved: [],
        });
        break;
      case "create_task":
        if (op.assigneeId) {
          assignments.push({
            taskName: op.name,
            contactName: nameOfContact(op.assigneeId),
          });
        }
        for (const d of op.deps) {
          newDeps.push({
            predecessorName: asm.nameOf(d),
            successorName: op.name,
            depType: "FS",
            lagDays: 0,
          });
        }
        // An undated task with no predecessor to pull it into place produces
        // no cascade change, so `moves` will never mention it.
        if (!changedTaskIds.has(`$t${index}`)) {
          newTasks.push({
            name: op.name,
            projectName:
              projectName.get(op.projectId) ?? plannedProject.get(op.projectId) ?? null,
            window: windowFor(`$t${index}`),
          });
        }
        break;
      case "create_contact":
        newContacts.push({
          name: op.name,
          company: op.company ?? null,
          trade: op.trade ?? null,
        });
        break;
      case "send_email":
        emails.push({
          recipients: op.contactIds.map(nameOfContact),
          subject: op.subject,
          body: op.body,
        });
        break;
      default:
        break;
    }
  });

  const moves: PreviewMove[] = changes.map((c) => ({
    name: asm.nameOf(c.taskId),
    fromStart: c.fromStartDate,
    toStart: c.toStartDate,
    fromEnd: c.fromEndDate,
    toEnd: c.toEndDate,
    direct: c.direct,
    isNew: asm.newTaskIds.has(c.taskId),
    window: windowFor(c.taskId),
  }));

  const notify = collectNotifications(plan, ctx, asm, changes);
  const inviteAttendees = getEnv().FEATURE_INVITE_ATTENDEES;

  const preview: PlanPreview = {
    summary: plan.summary,
    clarification: plan.clarification ?? null,
    notes: plan.notes ?? null,
    confidence: plan.confidence,
    newProjects,
    edits,
    moves,
    newTasks,
    removals,
    statusChanges,
    assignments,
    newDeps,
    newContacts,
    emails,
    // Only the reachable ones are shown, because only those become messages.
    // Someone with no address on file is already visible in `assignments`;
    // promising them a notification we cannot send would be the lie.
    notifications: notify
      .filter((n) => n.email !== null)
      .map((n) => ({
        contactName: n.contactName,
        taskName: n.taskName,
        when: humanRange(n.startDate, n.endDate),
        // They are added to the task's single calendar event rather than sent
        // an invite of their own.
        invite: inviteAttendees,
      })),
    empty:
      newProjects.length === 0 &&
      edits.length === 0 &&
      moves.length === 0 &&
      newTasks.length === 0 &&
      removals.length === 0 &&
      statusChanges.length === 0 &&
      assignments.length === 0 &&
      newDeps.length === 0 &&
      newContacts.length === 0 &&
      emails.length === 0,
  };

  return { preview, asm, notify };
}
