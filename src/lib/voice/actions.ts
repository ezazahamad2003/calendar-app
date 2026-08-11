"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireMembership } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { getEnv } from "@/lib/env";
import { projectColor } from "@/lib/project-color";
import { humanRange } from "@/lib/format-date";
import { dispatchQueued } from "@/lib/outbox/dispatch";
import { buildPlannerContext } from "./context";
import { planFromTranscript, PlannerError } from "./planner";
import { planSchema } from "./schema";
import type { Plan } from "./schema";
import {
  addWorkDays,
  cascade,
  detectCycle,
  finishIsoDate,
  formatIsoDate,
  parseIsoDate,
  shiftTasks,
} from "@/lib/schedule";
import type { Task, TaskDep } from "@/lib/schedule";
import type { Json } from "@/lib/database.types";

/**
 * Voice pipeline, server side (SPEC §5):
 *
 *   planCommand(text)  → Plan (from the model) + PlanPreview (from the engine)
 *   applyPlan(plan)    → one transaction via apply_plan_writes()
 *
 * The preview is recomputed from the Plan at apply time. The client only ever
 * echoes the Plan back; the numbers the user confirmed are re-derived
 * server-side, so a tampered payload can't smuggle different dates through.
 * Typed text and voice both land here — same path, same rules.
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
};

export type PlanPreview = {
  summary: string;
  /** Blocks the apply. */
  clarification: string | null;
  /** Advisory only — the plan still applies. */
  notes: string | null;
  confidence: "high" | "low";
  newProjects: { name: string; clientName: string | null; color: string }[];
  moves: PreviewMove[];
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

export type PlanResponse =
  | { ok: true; plan: Plan; preview: PlanPreview; transcript: string }
  | { ok: false; error: string };

// ── Engine assembly ──────────────────────────────────────────────────────────

type Assembled = {
  engineTasks: Task[];
  engineDeps: TaskDep[];
  directChanges: Map<string, string>;
  durationOverrides: Map<string, number>;
  nameOf: (id: string) => string;
  newTaskIds: Set<string>;
  cycle: string[] | null;
};

/**
 * Fold a Plan's operations into one engine input: existing tasks plus temp
 * tasks ("$tN"), existing deps plus new ones, and a single map of direct
 * moves. One cascade over the lot yields every knock-on effect — including
 * new tasks pulled into place by their predecessors.
 */
function assemble(
  plan: Plan,
  ctx: Awaited<ReturnType<typeof buildPlannerContext>>,
): Assembled {
  const engineTasks: Task[] = ctx.tasks.map((t) => ({
    id: t.id,
    startDate: t.startDate,
    durationDays: t.durationDays,
    isMilestone: t.isMilestone,
  }));
  const engineDeps: TaskDep[] = ctx.deps.map((d) => ({ ...d }));
  const directChanges = new Map<string, string>();
  const durationOverrides = new Map<string, number>();
  const names = new Map<string, string>(ctx.tasks.map((t) => [t.id, t.name]));
  const newTaskIds = new Set<string>();

  const taskById = new Map(ctx.tasks.map((t) => [t.id, t]));

  plan.operations.forEach((op, index) => {
    switch (op.type) {
      case "create_task": {
        const tempId = `$t${index}`;
        newTaskIds.add(tempId);
        names.set(tempId, op.name);
        engineTasks.push({
          id: tempId,
          startDate: op.startDate ?? null,
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
        durationOverrides.set(op.taskId, op.durationDays);
        const t = engineTasks.find((x) => x.id === op.taskId);
        if (t) {
          t.durationDays = op.durationDays;
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
    nameOf: (id: string) => names.get(id) ?? "unnamed task",
    newTaskIds,
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
  ctx: Awaited<ReturnType<typeof buildPlannerContext>>,
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

function buildPreview(
  plan: Plan,
  ctx: Awaited<ReturnType<typeof buildPlannerContext>>,
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
    calendar: ctx.calendar,
  });

  const contactName = new Map(ctx.contacts.map((c) => [c.id, c.name]));
  const taskById = new Map(ctx.tasks.map((t) => [t.id, t]));

  const newProjects: PlanPreview["newProjects"] = [];
  const statusChanges: PlanPreview["statusChanges"] = [];
  const assignments: PlanPreview["assignments"] = [];
  const newDeps: PlanPreview["newDeps"] = [];
  const newContacts: PlanPreview["newContacts"] = [];
  const emails: PlanPreview["emails"] = [];

  // Contacts created in this same plan aren't in ctx yet, so name and address
  // lookups have to fall back to what the plan itself declares.
  const plannedContact = new Map<string, { name: string; email: string | null }>();
  plan.operations.forEach((op, index) => {
    if (op.type === "create_contact") {
      plannedContact.set(`$c${index}`, { name: op.name, email: op.email ?? null });
    }
  });
  const nameOfContact = (id: string) =>
    contactName.get(id) ?? plannedContact.get(id)?.name ?? "someone";

  plan.operations.forEach((op, index) => {
    switch (op.type) {
      case "create_project":
        newProjects.push({
          name: op.name,
          clientName: op.clientName ?? null,
          color: projectColor(op.name, op.color).fill,
        });
        break;
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
        void index;
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
  }));

  const notify = collectNotifications(plan, ctx, asm, changes);
  const inviteAttendees = getEnv().FEATURE_INVITE_ATTENDEES;

  const preview: PlanPreview = {
    summary: plan.summary,
    clarification: plan.clarification ?? null,
    notes: plan.notes ?? null,
    confidence: plan.confidence,
    newProjects,
    moves,
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
        invite: inviteAttendees,
      })),
    empty:
      newProjects.length === 0 &&
      moves.length === 0 &&
      statusChanges.length === 0 &&
      assignments.length === 0 &&
      newDeps.length === 0 &&
      newContacts.length === 0 &&
      emails.length === 0,
  };

  return { preview, asm, notify };
}

// ── planCommand ──────────────────────────────────────────────────────────────

const commandSchema = z.object({
  text: z.string().trim().min(1, "Say or type something first").max(2000),
});

export async function planCommand(input: { text: string }): Promise<PlanResponse> {
  const m = await requireMembership();
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Empty command." };
  }

  try {
    // No guard on an empty project list any more. It used to refuse outright,
    // which meant a brand-new account's first sentence — the one most likely
    // to be "start a job called X" — hit a dead end pointing at a form.
    const ctx = await buildPlannerContext(m.orgId, m.timezone);
    const plan = await planFromTranscript(parsed.data.text, ctx);
    const { preview } = buildPreview(plan, ctx);
    return { ok: true, plan, preview, transcript: parsed.data.text };
  } catch (err) {
    if (err instanceof PlannerError) return { ok: false, error: err.message };
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Could not build a plan: ${err.message}`
          : "Could not build a plan. Try again.",
    };
  }
}

// ── applyPlan ────────────────────────────────────────────────────────────────

export type ApplyResponse =
  | {
      ok: true;
      applied: number;
      summary: string;
      /** Assignment notices that actually went out. */
      notified: number;
      /** Notices that failed and are sitting in the outbox to retry. */
      notifyFailed: number;
      /** True when no account is connected and the sends were simulated. */
      notifyMocked: boolean;
    }
  | { ok: false; error: string };

export async function applyPlan(input: {
  plan: unknown;
  transcript: string;
}): Promise<ApplyResponse> {
  const m = await requireMembership();

  // The plan crossed the client; parse it from scratch. Ids are re-validated
  // against a fresh context below by reassembling the whole computation.
  const parsedPlan = planSchema.safeParse(input.plan);
  if (!parsedPlan.success) {
    return { ok: false, error: "That plan is malformed. Ask again." };
  }
  const plan = parsedPlan.data;
  const transcript = String(input.transcript ?? "").slice(0, 4000);

  if (plan.clarification || plan.operations.length === 0) {
    return { ok: false, error: "Nothing to apply — the plan had no operations." };
  }

  try {
    const ctx = await buildPlannerContext(m.orgId, m.timezone);
    const contextTaskIds = new Set(ctx.tasks.map((t) => t.id));
    const contextContactIds = new Set(ctx.contacts.map((c) => c.id));
    const contextProjectIds = new Set(ctx.projects.map((p) => p.id));

    // Same hard validation as plan time, against *current* data — the schedule
    // may have changed between preview and confirm.
    for (const op of plan.operations) {
      const ids: string[] = [];
      if ("taskId" in op && op.taskId) ids.push(op.taskId);
      if ("predecessorId" in op) ids.push(op.predecessorId, op.successorId);
      for (const idRef of ids) {
        if (!idRef.startsWith("$t") && !contextTaskIds.has(idRef)) {
          return {
            ok: false,
            error: "The schedule changed since this plan was made. Ask again.",
          };
        }
      }
      // "$c"/"$p"/"$t" refs point at rows this same batch creates, so they
      // cannot be checked against current data — the RPC resolves them.
      if ("contactId" in op && !op.contactId.startsWith("$") && !contextContactIds.has(op.contactId)) {
        return { ok: false, error: "That person no longer exists. Ask again." };
      }
      if (
        op.type === "create_task" &&
        !op.projectId.startsWith("$") &&
        !contextProjectIds.has(op.projectId)
      ) {
        return { ok: false, error: "That project no longer exists. Ask again." };
      }
      if (op.type === "send_email") {
        for (const c of op.contactIds) {
          if (!c.startsWith("$") && !contextContactIds.has(c)) {
            return { ok: false, error: "A recipient no longer exists. Ask again." };
          }
        }
      }
    }

    const { asm, notify } = buildPreview(plan, ctx);
    const changes = cascade({
      tasks: asm.engineTasks,
      deps: asm.engineDeps,
      changed: asm.directChanges,
      calendar: ctx.calendar,
    });
    const changeByTask = new Map(changes.map((c) => [c.taskId, c]));
    const taskById = new Map(ctx.tasks.map((t) => [t.id, t]));

    type WriteOp = {
      kind: string;
      temp_id?: string;
      data: Record<string, unknown>;
      log?: { entity_type: string; action: string; before?: unknown; after?: unknown };
    };
    const ops: WriteOp[] = [];

    // Ordering is load-bearing from here down: the RPC resolves temp ids from
    // rows inserted earlier in the same array, so projects and contacts must
    // precede the tasks that name them, and tasks must precede their
    // assignments and messages.

    // 1. Projects.
    plan.operations.forEach((op, index) => {
      if (op.type !== "create_project") return;
      ops.push({
        kind: "insert_project",
        temp_id: `$p${index}`,
        data: {
          name: op.name,
          job_number: op.jobNumber ?? "",
          client_name: op.clientName ?? "",
          address: op.address ?? "",
          starts_on: op.startsOn ?? "",
          // Only an explicitly requested color is stored; otherwise NULL and
          // the name hash decides, the same way trades work.
          color: op.color ?? "",
        },
        log: {
          entity_type: "project",
          action: "create",
          after: { name: op.name, client_name: op.clientName ?? null },
        },
      });
    });

    // 2. Contacts.
    plan.operations.forEach((op, index) => {
      if (op.type !== "create_contact") return;
      ops.push({
        kind: "insert_contact",
        temp_id: `$c${index}`,
        data: {
          name: op.name,
          company: op.company ?? "",
          trade: op.trade ?? "",
          email: op.email ?? "",
          phone: op.phone ?? "",
        },
        log: { entity_type: "contact", action: "create", after: { name: op.name } },
      });
    });

    // 3. New tasks, with their cascade-resolved dates.
    plan.operations.forEach((op, index) => {
      if (op.type !== "create_task") return;
      const tempId = `$t${index}`;
      const resolved = changeByTask.get(tempId);
      const startDate = resolved?.toStartDate ?? op.startDate ?? null;
      const duration = op.isMilestone ? 1 : op.durationDays;
      const endDate =
        resolved?.toEndDate ??
        (startDate ? finishIsoDate(startDate, duration, ctx.calendar) : null);

      ops.push({
        kind: "insert_task",
        temp_id: tempId,
        data: {
          project_id: op.projectId,
          name: op.name,
          trade: op.trade ?? "",
          start_date: startDate,
          end_date: endDate,
          duration_days: duration,
          is_milestone: op.isMilestone,
        },
        log: {
          entity_type: "task",
          action: "create",
          after: { name: op.name, start_date: startDate, duration_days: duration },
        },
      });
      if (op.assigneeId) {
        ops.push({
          kind: "insert_assignment",
          data: { task_id: tempId, contact_id: op.assigneeId },
          log: { entity_type: "assignment", action: "assign", after: { task: op.name } },
        });
      }
      for (const dep of op.deps) {
        ops.push({
          kind: "insert_dep",
          data: { predecessor_id: dep, successor_id: tempId, dep_type: "FS", lag_days: 0 },
          log: {
            entity_type: "task_dep",
            action: "create",
            after: { predecessor: asm.nameOf(dep), successor: op.name },
          },
        });
      }
    });

    // 4. Date moves on existing tasks (cascade output), merged with duration
    //    overrides so a resize lands in the same UPDATE.
    for (const change of changes) {
      if (change.taskId.startsWith("$t")) continue;
      const before = taskById.get(change.taskId);
      ops.push({
        kind: "update_task",
        data: {
          id: change.taskId,
          start_date: change.toStartDate,
          end_date: change.toEndDate,
          ...(asm.durationOverrides.has(change.taskId)
            ? { duration_days: asm.durationOverrides.get(change.taskId) }
            : {}),
        },
        log: {
          entity_type: "task",
          action: "move",
          before: { start_date: before?.startDate, end_date: before?.endDate },
          after: { start_date: change.toStartDate, end_date: change.toEndDate },
        },
      });
    }

    // Resizes whose dates didn't move still need their duration + end saved.
    for (const [taskId, duration] of asm.durationOverrides) {
      if (changeByTask.has(taskId)) continue;
      const t = taskById.get(taskId);
      if (!t) continue;
      const endDate = t.startDate
        ? finishIsoDate(t.startDate, duration, ctx.calendar)
        : null;
      ops.push({
        kind: "update_task",
        data: { id: taskId, duration_days: duration, end_date: endDate },
        log: {
          entity_type: "task",
          action: "resize",
          before: { duration_days: t.durationDays },
          after: { duration_days: duration },
        },
      });
    }

    // 5. Statuses, assignments, dependencies, emails.
    plan.operations.forEach((op) => {
      switch (op.type) {
        case "set_status":
          ops.push({
            kind: "update_task",
            data: { id: op.taskId, status: op.status },
            log: {
              entity_type: "task",
              action: "set_status",
              before: { status: taskById.get(op.taskId)?.status },
              after: { status: op.status },
            },
          });
          break;
        case "assign_task":
          ops.push({
            kind: "insert_assignment",
            data: { task_id: op.taskId, contact_id: op.contactId },
            log: {
              entity_type: "assignment",
              action: "assign",
              after: { task: asm.nameOf(op.taskId) },
            },
          });
          break;
        case "add_dependency":
          ops.push({
            kind: "insert_dep",
            data: {
              predecessor_id: op.predecessorId,
              successor_id: op.successorId,
              dep_type: op.depType,
              lag_days: op.lagDays,
            },
            log: {
              entity_type: "task_dep",
              action: "create",
              after: {
                predecessor: asm.nameOf(op.predecessorId),
                successor: asm.nameOf(op.successorId),
              },
            },
          });
          break;
        case "send_email":
          // One outbound_messages row per recipient, each with its own
          // idempotency key, written *before* any Graph call ever happens
          // (SPEC §6). Phase 6's outbox sends them.
          for (const contactId of op.contactIds) {
            ops.push({
              kind: "insert_message",
              data: {
                task_id: op.taskId ?? null,
                contact_id: contactId,
                channel: "email",
                subject: op.subject,
                body: op.body,
                idempotency_key: crypto.randomUUID(),
              },
              log: {
                entity_type: "outbound_message",
                action: "queue",
                after: { subject: op.subject },
              },
            });
          }
          break;
        default:
          break;
      }
    });

    // 6. Notifications the app adds itself: one email per assigned person, and
    //    a calendar invite alongside it when the task has dates and
    //    FEATURE_INVITE_ATTENDEES is on. Written as outbound_messages rows in
    //    the same transaction as the schedule change, so the record of "we
    //    told Alex" cannot exist without the change it describes, or vice
    //    versa. Their keys come back out below to be sent.
    const notifyKeys: string[] = [];
    const inviteAttendees = getEnv().FEATURE_INVITE_ATTENDEES;

    for (const n of notify) {
      if (n.email === null) continue; // no address on file; nothing to send

      const when = humanRange(n.startDate, n.endDate);

      const emailKey = crypto.randomUUID();
      notifyKeys.push(emailKey);
      ops.push({
        kind: "insert_message",
        data: {
          task_id: n.taskRef,
          contact_id: n.contactRef,
          channel: "email",
          subject: `${n.taskName} — ${when}`,
          body:
            `Hi ${n.contactName},\n\n` +
            `You're scheduled for ${n.taskName}: ${when}.\n\n` +
            `${m.orgName}`,
          idempotency_key: emailKey,
        },
        log: {
          entity_type: "outbound_message",
          action: "queue_assignment_notice",
          after: { task: n.taskName, to: n.contactName },
        },
      });

      if (inviteAttendees && n.startDate) {
        const inviteKey = crypto.randomUUID();
        notifyKeys.push(inviteKey);
        ops.push({
          kind: "insert_message",
          data: {
            task_id: n.taskRef,
            contact_id: n.contactRef,
            channel: "calendar",
            subject: n.taskName,
            body: `${n.taskName} — ${when}\n\n${m.orgName}`,
            idempotency_key: inviteKey,
          },
          log: {
            entity_type: "outbound_message",
            action: "queue_invite",
            after: { task: n.taskName, to: n.contactName },
          },
        });
      }
    }

    if (ops.length === 0) {
      return { ok: false, error: "Nothing to apply — the plan had no effect." };
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("apply_plan_writes", {
      p_org_id: m.orgId,
      p_ops: ops as unknown as Json,
      p_source: "voice",
      p_transcript: transcript,
    });

    if (error) {
      return { ok: false, error: `Nothing was changed: ${error.message}` };
    }

    // The schedule is committed. Now tell the people it commits.
    //
    // Deliberately after the transaction, not inside it: a Graph or Gmail call
    // is a network round trip to someone else's server, and holding a database
    // transaction open across one is how you get lock contention and a
    // half-applied schedule when it times out. The rows are already durable
    // and idempotency-keyed, so a failure here leaves a retryable outbox entry
    // rather than a lost message.
    //
    // Planner-authored send_email operations are NOT dispatched here — those
    // keep going to the outbox for a read-before-send, which is what the
    // review copy on that page promises. Only the app's own assignment
    // notices, which the user just confirmed by name in the diff, go out now.
    const dispatched = notifyKeys.length > 0
      ? await dispatchQueued(m.orgId, m.userId, notifyKeys)
      : { sent: 0, failed: 0, mocked: false };

    revalidatePath("/", "layout");
    const applied =
      typeof data === "object" && data !== null && "applied" in data
        ? Number((data as { applied: number }).applied)
        : ops.length;

    return {
      ok: true,
      applied,
      summary: plan.summary,
      notified: dispatched.sent,
      notifyFailed: dispatched.failed,
      notifyMocked: dispatched.mocked,
    };
  } catch (err) {
    if (err instanceof PlannerError) return { ok: false, error: err.message };
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Nothing was changed: ${err.message}`
          : "Nothing was changed — something went wrong. Try again.",
    };
  }
}
