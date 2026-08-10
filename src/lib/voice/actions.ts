"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireMembership } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
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
  clarification: string | null;
  confidence: "high" | "low";
  moves: PreviewMove[];
  statusChanges: { name: string; from: string; to: string }[];
  assignments: { taskName: string; contactName: string }[];
  newDeps: { predecessorName: string; successorName: string; depType: string; lagDays: number }[];
  newContacts: { name: string; company: string | null; trade: string | null }[];
  emails: { recipients: string[]; subject: string; body: string }[];
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

function buildPreview(
  plan: Plan,
  ctx: Awaited<ReturnType<typeof buildPlannerContext>>,
): { preview: PlanPreview; asm: Assembled } {
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

  const statusChanges: PlanPreview["statusChanges"] = [];
  const assignments: PlanPreview["assignments"] = [];
  const newDeps: PlanPreview["newDeps"] = [];
  const newContacts: PlanPreview["newContacts"] = [];
  const emails: PlanPreview["emails"] = [];

  plan.operations.forEach((op, index) => {
    switch (op.type) {
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
          contactName: contactName.get(op.contactId) ?? "someone",
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
            contactName: contactName.get(op.assigneeId) ?? "someone",
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
          recipients: op.contactIds.map((c) => contactName.get(c) ?? "someone"),
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

  const preview: PlanPreview = {
    summary: plan.summary,
    clarification: plan.clarification ?? null,
    confidence: plan.confidence,
    moves,
    statusChanges,
    assignments,
    newDeps,
    newContacts,
    emails,
    empty:
      moves.length === 0 &&
      statusChanges.length === 0 &&
      assignments.length === 0 &&
      newDeps.length === 0 &&
      newContacts.length === 0 &&
      emails.length === 0,
  };

  return { preview, asm };
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
    const ctx = await buildPlannerContext(m.orgId, m.timezone);
    if (ctx.projects.length === 0) {
      return {
        ok: false,
        error: "There are no projects yet. Create one first, then talk to the schedule.",
      };
    }
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
  | { ok: true; applied: number; summary: string }
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
      if ("contactId" in op && !contextContactIds.has(op.contactId)) {
        return { ok: false, error: "That person no longer exists. Ask again." };
      }
      if (op.type === "create_task" && !contextProjectIds.has(op.projectId)) {
        return { ok: false, error: "That project no longer exists. Ask again." };
      }
      if (op.type === "send_email") {
        for (const c of op.contactIds) {
          if (!contextContactIds.has(c)) {
            return { ok: false, error: "A recipient no longer exists. Ask again." };
          }
        }
      }
    }

    const { asm } = buildPreview(plan, ctx);
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

    // 1. Contacts first (nothing references them by temp id in v1).
    plan.operations.forEach((op) => {
      if (op.type !== "create_contact") return;
      ops.push({
        kind: "insert_contact",
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

    // 2. New tasks, with their cascade-resolved dates.
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

    // 3. Date moves on existing tasks (cascade output), merged with duration
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

    // 4. Statuses, assignments, dependencies, emails.
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

    revalidatePath("/", "layout");
    const applied =
      typeof data === "object" && data !== null && "applied" in data
        ? Number((data as { applied: number }).applied)
        : ops.length;

    return { ok: true, applied, summary: plan.summary };
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
