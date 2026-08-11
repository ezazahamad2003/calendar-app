"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireMembership } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { humanRange } from "@/lib/format-date";
import { dispatchQueued } from "@/lib/outbox/dispatch";
import { syncTasksToCalendar } from "@/lib/providers/calendar-sync";
import { buildPlannerContext } from "./context";
import { PlannerError, validatePlanIds } from "./validate";
import { converse, AgentError } from "./agent";
import type { Turn } from "./agent";
import { planSchema } from "./schema";
import type { Plan } from "./schema";
import { buildPreview } from "./preview";
import type { PlanPreview } from "./preview";
import { cascade, finishIsoDate } from "@/lib/schedule";
import type { Json } from "@/lib/database.types";

/**
 * Voice pipeline, server side (SPEC §5):
 *
 *   askForeman(text, history) → a reply, and optionally a Plan + PlanPreview
 *   applyPlan(plan)           → one transaction via apply_plan_writes()
 *
 * The preview is recomputed from the Plan at apply time. The client only ever
 * echoes the Plan back; the numbers the user confirmed are re-derived
 * server-side, so a tampered payload can't smuggle different dates through.
 * Typed text and voice both land here — same path, same rules.
 */

// ── askForeman ───────────────────────────────────────────────────────────────

/**
 * One conversational turn.
 *
 * `reply` is always there — the assistant answers even when it is proposing.
 * `plan`/`preview` are set only when it wants to change something, and the
 * user still has to confirm. `turns` is the conversation to hand back next
 * time; it round-trips through the client, which is why nothing in it is
 * trusted on the way back in.
 */
export type AskResponse =
  | {
      ok: true;
      reply: string;
      turns: Turn[];
      plan: Plan | null;
      preview: PlanPreview | null;
    }
  | { ok: false; error: string; turns: Turn[] };

const commandSchema = z.object({
  text: z.string().trim().min(1, "Say or type something first").max(2000),
});

/**
 * Conversation history as it comes back from the client.
 *
 * Reshaped rather than trusted. It cannot do harm — every tool is org-scoped
 * server-side, and applyPlan re-derives everything from a fresh context — but
 * a malformed turn would break the API call, and an unbounded one would cost
 * money, so both are capped here.
 */
const turnSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().max(20_000),
  toolCalls: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(100),
        args: z.string().max(20_000),
      }),
    )
    .max(8)
    .optional(),
  toolCallId: z.string().max(200).optional(),
});

export async function askForeman(input: {
  text: string;
  history?: unknown;
}): Promise<AskResponse> {
  const m = await requireMembership();
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Empty message.",
      turns: [],
    };
  }

  const history = z.array(turnSchema).max(60).safeParse(input.history ?? []);
  const priorTurns: Turn[] = history.success ? history.data : [];

  try {
    // No guard on an empty project list. It used to refuse outright, which
    // meant a brand-new account's first sentence — the one most likely to be
    // "start a job called X" — hit a dead end pointing at a form.
    const ctx = await buildPlannerContext(m.orgId, m.timezone);
    const result = await converse(
      parsed.data.text,
      priorTurns,
      ctx,
      m.orgId,
      m.orgName,
    );

    // The preview is computed here, from the plan, rather than by the model.
    // Every date the user reads before confirming comes out of the schedule
    // engine — the assistant chooses *what* to change, never what the result
    // looks like.
    const preview = result.plan ? buildPreview(result.plan, ctx).preview : null;

    return {
      ok: true,
      reply: result.reply,
      turns: result.turns,
      plan: result.plan,
      preview,
    };
  } catch (err) {
    if (err instanceof PlannerError || err instanceof AgentError) {
      return { ok: false, error: err.message, turns: priorTurns };
    }
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Could not answer that: ${err.message}`
          : "Could not answer that. Try again.",
      turns: priorTurns,
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
      /** Calendar events created or updated on the user's own calendar. */
      calendarWritten: number;
      calendarFailed: number;
      /** True when no account is connected, so nothing was pushed. */
      calendarSkipped: boolean;
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
        (op.type === "create_task" ||
          op.type === "update_project" ||
          op.type === "shift_project") &&
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

    // And then the same validator the proposal went through, against the fresh
    // context. The checks above give better messages for the common staleness
    // cases, but they are a hand-written subset — this is the one that knows
    // every operation, every temp-id rule, and that Foreman never mails an
    // address it does not have. It throws PlannerError, caught below.
    validatePlanIds(plan, ctx);

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
      // A resize_task naming this same batch's task is unusual, but if one is
      // there the cascade already used the resized duration to place
      // everything downstream — writing the original here would leave
      // duration_days and end_date describing different tasks.
      const duration = op.isMilestone
        ? 1
        : (asm.durationOverrides.get(tempId) ?? op.durationDays);
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

    // 5. Edits to existing rows. Only the fields the operation actually names
    //    are sent — the RPC applies a column when its key is present, so an
    //    omitted field is left alone rather than blanked.
    plan.operations.forEach((op) => {
      switch (op.type) {
        case "update_project": {
          const data: Record<string, unknown> = { id: op.projectId };
          if (op.name != null) data.name = op.name;
          if (op.clientName != null) data.client_name = op.clientName;
          if (op.address != null) data.address = op.address;
          if (op.jobNumber != null) data.job_number = op.jobNumber;
          if (op.status != null) data.status = op.status;
          if (op.color != null) data.color = op.color;
          if (Object.keys(data).length === 1) break; // nothing but the id
          ops.push({
            kind: "update_project",
            data,
            log: {
              entity_type: "project",
              action: "update",
              before: { name: ctx.projects.find((p) => p.id === op.projectId)?.name },
              after: { name: op.name ?? undefined },
            },
          });
          break;
        }
        case "update_task": {
          const data: Record<string, unknown> = { id: op.taskId };
          if (op.name != null) data.name = op.name;
          if (op.trade != null) data.trade = op.trade;
          if (Object.keys(data).length === 1) break;
          ops.push({
            kind: "update_task",
            data,
            log: {
              entity_type: "task",
              action: "update",
              before: { name: taskById.get(op.taskId)?.name },
              after: { name: op.name ?? undefined },
            },
          });
          break;
        }
        case "update_contact": {
          const data: Record<string, unknown> = { id: op.contactId };
          if (op.name != null) data.name = op.name;
          if (op.company != null) data.company = op.company;
          if (op.trade != null) data.trade = op.trade;
          if (op.email != null) data.email = op.email;
          if (op.phone != null) data.phone = op.phone;
          if (Object.keys(data).length === 1) break;
          ops.push({
            kind: "update_contact",
            data,
            log: {
              entity_type: "contact",
              action: "update",
              before: { name: ctx.contacts.find((c) => c.id === op.contactId)?.name },
              after: { name: op.name ?? undefined },
            },
          });
          break;
        }
        default:
          break;
      }
    });

    // 6. Statuses, assignments, dependencies, emails.
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

    // 7. Notifications the app adds itself: one email per assigned person, and
    //    written as an outbound_messages row in the same transaction as the
    //    schedule change, so the record of "we told Alex" cannot exist without
    //    the change it describes, or vice versa. Their keys come back out
    //    below to be sent.
    //
    //    The calendar half is no longer queued here — see syncTasksToCalendar
    //    after the commit, which puts the task on the user's own calendar once
    //    and adds assignees to that one event.
    const notifyKeys: string[] = [];

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

      // No separate calendar row per person any more. The task gets ONE
      // calendar event (see syncTasksToCalendar below) and assignees ride on
      // it as attendees — two people on a task used to mean two events for the
      // same day's work.
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

    // Push every task this plan touched onto the user's own calendar. Not just
    // the assigned ones: the schedule belongs on the calendar the contractor
    // actually looks at, whether or not anyone else is on it.
    //
    // Ids come from two places — the RPC's temp-id map for tasks created here,
    // and the cascade for ones that already existed and moved.
    // The map is keyed by temp id and holds projects and contacts too, so it
    // is filtered to "$t" rather than taken wholesale.
    const tempIdMap = (
      typeof data === "object" && data !== null && "task_ids" in data
        ? ((data as { task_ids: Record<string, string> }).task_ids ?? {})
        : {}
    ) as Record<string, string>;
    const createdTaskIds = Object.entries(tempIdMap)
      .filter(([tempId]) => tempId.startsWith("$t"))
      .map(([, realId]) => realId);
    const movedTaskIds = changes.map((c) => c.taskId).filter((id) => !id.startsWith("$"));
    const touched = [...new Set([...createdTaskIds, ...movedTaskIds])];

    const synced = await syncTasksToCalendar(m.orgId, m.userId, touched);

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
      calendarWritten: synced.created + synced.updated,
      calendarFailed: synced.failed,
      calendarSkipped: synced.skipped,
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
