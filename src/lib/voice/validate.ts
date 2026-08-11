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
        tempIds.add(`$t${index}`);
        break;
      }
      case "update_project":
        if (!knownProject(op.projectId)) throw badId("project", op.projectId);
        break;
      case "update_contact":
        if (!knownContact(op.contactId)) throw badId("contact", op.contactId);
        break;
      case "update_task":
      case "move_task":
      case "shift_task":
      case "resize_task":
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
    }
  });

  return plan;
}
