import { wouldCreateCycle } from "@/lib/schedule";
import type { ScheduleDoc } from "@/lib/store/types";
import type { Operation, Plan } from "./schema";

/**
 * Check every id against the document before anything runs.
 *
 * The model is told which ids exist and is still capable of inventing one, or
 * of reusing an id from an earlier turn that has since been deleted. A
 * hallucinated id is a **hard failure**, never a silent skip: skipping turns
 * "push framing and roofing back two days" into "push roofing back two days"
 * and reports success, and the framers turn up on a day nobody expects them.
 *
 * Pure, and deliberately outside the server action so it can be tested against
 * a fixture without a store.
 */

export type ValidationResult =
  | { ok: true }
  | { ok: false; problems: string[] };

function checkTask(doc: ScheduleDoc, id: string, label: string, problems: string[]): void {
  if (!doc.tasks.some((t) => t.id === id)) {
    problems.push(`${label} names an activity that does not exist (${id}).`);
  }
}

function checkContact(doc: ScheduleDoc, id: string, label: string, problems: string[]): void {
  if (!doc.contacts.some((c) => c.id === id)) {
    problems.push(`${label} names a contact that does not exist (${id}).`);
  }
}

export function validatePlan(doc: ScheduleDoc, plan: Plan): ValidationResult {
  const problems: string[] = [];

  // A blocking question and a set of operations are contradictory: it either
  // knew enough to act or it did not.
  if (plan.clarification && plan.operations.length > 0) {
    problems.push(
      "The plan asks a question and also proposes changes. It must do one or the other.",
    );
  }

  // Dependencies accumulate across the plan so that two operations which are
  // each fine alone but close a loop together are caught here rather than by
  // `cascade` throwing later.
  const deps = [...doc.deps];

  for (const [index, op] of plan.operations.entries()) {
    const where = `Step ${index + 1} (${op.type})`;

    switch (op.type) {
      case "push_activity":
      case "move_activity":
      case "resize_activity":
      case "set_status":
      case "clear_dates":
      case "remove_activity":
      case "rename_activity":
      case "set_notes":
        checkTask(doc, op.taskId, where, problems);
        break;

      case "set_team":
        checkTask(doc, op.taskId, where, problems);
        if (op.contactId) checkContact(doc, op.contactId, where, problems);
        break;

      case "add_activity":
        if (op.sectionId && !doc.sections.some((s) => s.id === op.sectionId)) {
          problems.push(`${where} names a section that does not exist (${op.sectionId}).`);
        }
        for (const predecessor of op.after) {
          checkTask(doc, predecessor, `${where} "after"`, problems);
        }
        break;

      case "add_dependency": {
        checkTask(doc, op.predecessorId, where, problems);
        checkTask(doc, op.successorId, where, problems);
        const cycle = wouldCreateCycle(deps, {
          predecessorId: op.predecessorId,
          successorId: op.successorId,
        });
        if (cycle) {
          const names = cycle.map((id) => doc.tasks.find((t) => t.id === id)?.name ?? id);
          problems.push(
            `${where} would make those activities depend on each other ` +
              `(${names.join(" → ")}). Remove one of the links first.`,
          );
        } else {
          deps.push({
            predecessorId: op.predecessorId,
            successorId: op.successorId,
            depType: op.depType,
            lagDays: op.lagDays,
          });
        }
        break;
      }

      case "remove_dependency":
        checkTask(doc, op.predecessorId, where, problems);
        checkTask(doc, op.successorId, where, problems);
        if (
          !doc.deps.some(
            (d) =>
              d.predecessorId === op.predecessorId && d.successorId === op.successorId,
          )
        ) {
          problems.push(`${where} removes a link that is not there.`);
        }
        break;

      case "update_contact":
        checkContact(doc, op.contactId, where, problems);
        break;

      case "add_contact":
        break;
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Operations that write nothing anyone would notice — used to reject no-op plans. */
export function isEmptyPlan(operations: readonly Operation[]): boolean {
  return operations.length === 0;
}
