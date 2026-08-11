import "server-only";

import type { Plan } from "./schema";
import type { PlannerContext } from "./context";

/**
 * Hard validation of a proposed plan (SPEC §5: a hallucinated id is a failure,
 * not a silent skip).
 *
 * The model is told to use only ids from its context. That is not enough, and
 * never was — this is the code that actually enforces it. Extracted from the
 * old one-shot planner when the assistant became conversational, because a
 * proposal now arrives as a tool call rather than as the whole response, and
 * both paths must be checked identically.
 *
 * Failures are thrown, and the caller decides whether that becomes a message
 * to the user or a correction handed back to the model.
 */

export class PlannerError extends Error {}

export function validatePlanIds(plan: Plan, ctx: PlannerContext): Plan {
  // A clarification with operations attached is a contradiction — the model
  // hedged. Treat it as a pure clarification rather than half-executing:
  // whatever it was unsure about could be the thing that makes these
  // operations wrong.
  if (plan.clarification && plan.operations.length > 0) {
    return { ...plan, operations: [] };
  }

  const projectIds = new Set(ctx.projects.map((p) => p.id));
  const taskIds = new Set(ctx.tasks.map((t) => t.id));
  const contactIds = new Set(ctx.contacts.map((c) => c.id));

  // Temp ids for rows created earlier in this same plan. Populated as the loop
  // walks forward, which is what makes a backward reference legal and a
  // forward one ("assign to $c3" from index 1) fail — the batch inserts in
  // order, so a forward reference would resolve to nothing at apply time.
  const tempIds = new Set<string>();

  /** Contacts this plan creates, so their addresses can be judged too. */
  const plannedContacts = new Map<string, { name: string; email: string | null }>();

  const badId = (kind: string, value: string) =>
    new PlannerError(
      `That plan referenced a ${kind} that does not exist (${value}). ` +
        `Nothing was changed.`,
    );

  /**
   * Deleting something the same plan is creating is incoherent, and the RPC
   * would resolve the temp id and delete a row it inserted a moment earlier.
   */
  const mustExist = (kind: string, value: string, real: Set<string>) => {
    if (value.startsWith("$")) {
      throw new PlannerError(
        `A plan cannot delete a ${kind} it is creating in the same breath. ` +
          `Nothing was changed.`,
      );
    }
    if (!real.has(value)) throw badId(kind, value);
  };

  /** Both ends or neither, and the end after the start. */
  const checkWindow = (
    label: string,
    startTime: string | null | undefined,
    endTime: string | null | undefined,
  ) => {
    if (endTime && !startTime) {
      throw new PlannerError(
        `${label} was given a finish time with no start time. Give both, or neither.`,
      );
    }
    if (startTime && endTime && endTime <= startTime) {
      throw new PlannerError(
        `${label} would finish at ${endTime}, which is not after ${startTime}. ` +
          `Times are one day's window — a task running overnight has to be two tasks.`,
      );
    }
  };

  plan.operations.forEach((op, index) => {
    // The prefix has to match the kind. "$p0" is a project and nothing else —
    // without this, `assign_task` could name a project as its contact and pass,
    // because every temp id lived in one undifferentiated set.
    const known = (prefix: string, real: Set<string>) => (v: string) =>
      v.startsWith("$") ? tempIds.has(v) && v.startsWith(prefix) : real.has(v);
    const knownTask = known("$t", taskIds);
    const knownContact = known("$c", contactIds);
    const knownProject = known("$p", projectIds);

    switch (op.type) {
      case "create_project":
        tempIds.add(`$p${index}`);
        break;
      case "create_task": {
        if (!knownProject(op.projectId)) throw badId("project", op.projectId);
        if (op.assigneeId && !knownContact(op.assigneeId))
          throw badId("contact", op.assigneeId);
        for (const d of op.deps) if (!knownTask(d)) throw badId("task", d);
        checkWindow(op.name, op.startTime, op.endTime);
        tempIds.add(`$t${index}`);
        break;
      }
      case "update_project":
        if (!knownProject(op.projectId)) throw badId("project", op.projectId);
        break;
      case "update_contact":
        if (!knownContact(op.contactId)) throw badId("contact", op.contactId);
        break;
      case "resize_task": {
        if (!knownTask(op.taskId)) throw badId("task", op.taskId);
        // A milestone is a marker, not work — it occupies one day by
        // definition, and create_task already forces that. Letting a resize
        // through would leave a milestone claiming a week on the calendar,
        // which no part of the app expects to see.
        const target = ctx.tasks.find((t) => t.id === op.taskId);
        if (target?.isMilestone && op.durationDays !== 1) {
          throw new PlannerError(
            `${target.name} is a milestone — it marks a single day and has no ` +
              `length to change. Nothing was changed.`,
          );
        }
        break;
      }
      case "update_task": {
        if (!knownTask(op.taskId)) throw badId("task", op.taskId);
        const target = ctx.tasks.find((t) => t.id === op.taskId);
        // A one-sided edit inherits the other end from the row, so "start it at
        // 7" on a task that finishes at 15:30 is checked against 15:30 rather
        // than waved through and rejected by the database.
        checkWindow(
          target?.name ?? "That task",
          op.startTime ?? (op.clearTimes ? null : target?.startTime),
          op.endTime ?? (op.clearTimes ? null : target?.endTime),
        );
        break;
      }
      case "move_task":
      case "shift_task":
      case "set_status":
        if (!knownTask(op.taskId)) throw badId("task", op.taskId);
        break;
      case "assign_task":
        if (!knownTask(op.taskId)) throw badId("task", op.taskId);
        if (!knownContact(op.contactId)) throw badId("contact", op.contactId);
        break;
      case "add_dependency":
        if (!knownTask(op.predecessorId)) throw badId("task", op.predecessorId);
        if (!knownTask(op.successorId)) throw badId("task", op.successorId);
        break;
      case "shift_project":
        // A project created in this same plan has nothing to shift.
        if (!projectIds.has(op.projectId)) throw badId("project", op.projectId);
        break;
      case "send_email": {
        for (const c of op.contactIds) {
          if (!knownContact(c)) throw badId("contact", c);
          // Belt and braces: the prompt forbids this, and the code refuses it.
          // A contact created in this same plan has no row to check yet, so it
          // is judged on the address the plan itself supplies.
          const contact = ctx.contacts.find((x) => x.id === c);
          const fresh = plannedContacts.get(c);
          const name = contact?.name ?? fresh?.name ?? "That contact";
          const reachable = contact ? contact.hasEmail : Boolean(fresh?.email);
          if (!reachable) {
            throw new PlannerError(
              `${name} has no email address on file. Add one on the ` +
                `Crew page first — Foreman never guesses an address.`,
            );
          }
        }
        if (op.taskId && !knownTask(op.taskId)) throw badId("task", op.taskId);
        break;
      }
      case "create_contact":
        tempIds.add(`$c${index}`);
        plannedContacts.set(`$c${index}`, { name: op.name, email: op.email ?? null });
        break;

      case "delete_project":
        mustExist("project", op.projectId, projectIds);
        break;
      case "delete_task":
        mustExist("task", op.taskId, taskIds);
        break;
      case "delete_contact":
        mustExist("contact", op.contactId, contactIds);
        break;
      case "unassign_task": {
        mustExist("task", op.taskId, taskIds);
        mustExist("contact", op.contactId, contactIds);
        // Taking someone off work they were never on is not a no-op to report
        // as done — it means the model matched the wrong person or the wrong
        // task, and the user would read "Alex removed from framing" either way.
        const task = ctx.tasks.find((t) => t.id === op.taskId);
        if (task && !task.assigneeIds.includes(op.contactId)) {
          const who = ctx.contacts.find((c) => c.id === op.contactId)?.name ?? "That person";
          throw new PlannerError(
            `${who} is not on ${task.name}, so there is nothing to take them off. ` +
              `Nothing was changed.`,
          );
        }
        break;
      }
      case "remove_dependency": {
        mustExist("task", op.predecessorId, taskIds);
        mustExist("task", op.successorId, taskIds);
        const linked = ctx.deps.some(
          (d) =>
            d.predecessorId === op.predecessorId && d.successorId === op.successorId,
        );
        if (!linked) {
          const from = ctx.tasks.find((t) => t.id === op.predecessorId)?.name ?? "that task";
          const to = ctx.tasks.find((t) => t.id === op.successorId)?.name ?? "that task";
          throw new PlannerError(
            `${to} does not follow ${from}, so there is no link to remove. ` +
              `Nothing was changed.`,
          );
        }
        break;
      }
    }
  });

  // Second pass: nothing may be edited and deleted in the same plan.
  //
  // The operations apply in order, so "rename Hillcrest, then delete it" would
  // do both and leave the user reading a diff describing a rename that outlived
  // its subject by one statement. Caught here rather than at the database,
  // where it surfaces after Confirm as a rolled-back "Task not found".
  const doomedProjects = new Set<string>();
  const doomedTasks = new Set<string>();
  for (const op of plan.operations) {
    if (op.type === "delete_project") {
      doomedProjects.add(op.projectId);
      for (const t of ctx.tasks) {
        if (t.projectId === op.projectId) doomedTasks.add(t.id);
      }
    }
    if (op.type === "delete_task") doomedTasks.add(op.taskId);
  }

  if (doomedProjects.size > 0 || doomedTasks.size > 0) {
    const nameOfTask = (taskId: string) =>
      ctx.tasks.find((t) => t.id === taskId)?.name ?? "that task";

    for (const op of plan.operations) {
      if (op.type.startsWith("delete_")) continue;

      if ("taskId" in op && op.taskId && doomedTasks.has(op.taskId)) {
        throw new PlannerError(
          `That plan changes ${nameOfTask(op.taskId)} and also deletes it. ` +
            `Pick one. Nothing was changed.`,
        );
      }
      if ("projectId" in op && doomedProjects.has(op.projectId)) {
        const name = ctx.projects.find((p) => p.id === op.projectId)?.name ?? "that job";
        throw new PlannerError(
          `That plan changes ${name} and also deletes it. Pick one. Nothing was changed.`,
        );
      }
      if (
        op.type === "add_dependency" &&
        (doomedTasks.has(op.predecessorId) || doomedTasks.has(op.successorId))
      ) {
        throw new PlannerError(
          `That plan links a task it also deletes. Pick one. Nothing was changed.`,
        );
      }
    }
  }

  return plan;
}
