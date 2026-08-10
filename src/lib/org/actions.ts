"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireMembership } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { getProjectDetail, getWorkCalendar } from "@/lib/org/queries";
import {
  addWorkDays,
  cascade,
  finishIsoDate,
  formatIsoDate,
  parseIsoDate,
  todayInZone,
  wouldCreateCycle,
} from "@/lib/schedule";
import type { Task, TaskDep } from "@/lib/schedule";
import type { Json } from "@/lib/database.types";

/**
 * Write side of the org data layer (SPEC §8: mutations only through server
 * actions, Zod on every input).
 *
 * Every action:
 *   1. resolves the caller's membership (redirects if signed out / org-less),
 *   2. validates input with Zod before anything touches the database,
 *   3. writes through the user-scoped client, so RLS re-checks tenancy,
 *   4. logs to change_log — the audit trail is a product feature (SPEC §3).
 *
 * Multi-row date moves go through the `apply_task_moves` RPC so the batch and
 * its log entries commit in one transaction.
 */

export type ActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

const OK: ActionState = {};

function fieldErrorsFrom(error: z.ZodError): ActionState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in fieldErrors)) {
      fieldErrors[key] = issue.message;
    }
  }
  return { fieldErrors };
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a full date (YYYY-MM-DD)");

const optionalTrimmed = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : null;
  });

/** Log a non-move mutation. Best effort by design: the write it describes has
 *  already committed, and undoing a real change because its log insert failed
 *  would be worse than a gap in the log. Move operations get the stronger
 *  guarantee via apply_task_moves. */
async function logChange(opts: {
  orgId: string;
  userId: string;
  entityType: "project" | "task" | "contact" | "task_dep" | "assignment";
  entityId: string;
  action: string;
  before?: Json;
  after?: Json;
}): Promise<void> {
  const supabase = await createClient();
  await supabase.from("change_log").insert({
    org_id: opts.orgId,
    actor_user_id: opts.userId,
    entity_type: opts.entityType,
    entity_id: opts.entityId,
    action: opts.action,
    before: opts.before ?? null,
    after: opts.after ?? null,
    source: "ui",
  });
}

// ─── Projects ────────────────────────────────────────────────────────────────

const projectSchema = z.object({
  name: z.string().trim().min(1, "Give the project a name").max(160),
  job_number: optionalTrimmed,
  client_name: optionalTrimmed,
  address: optionalTrimmed,
  starts_on: z.union([isoDate, z.literal("")]).transform((v) => v || null),
});

export async function createProject(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const m = await requireMembership();
  const parsed = projectSchema.safeParse({
    name: formData.get("name"),
    job_number: formData.get("job_number") ?? undefined,
    client_name: formData.get("client_name") ?? undefined,
    address: formData.get("address") ?? undefined,
    starts_on: formData.get("starts_on") ?? "",
  });
  if (!parsed.success) return fieldErrorsFrom(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .insert({ org_id: m.orgId, ...parsed.data })
    .select("id")
    .single();

  if (error) return { error: `Could not create the project: ${error.message}` };

  await logChange({
    orgId: m.orgId,
    userId: m.userId,
    entityType: "project",
    entityId: data.id,
    action: "create",
    after: parsed.data as Json,
  });

  revalidatePath("/", "layout");
  redirect(`/projects/${data.id}`);
}

// ─── Contacts (crew) ─────────────────────────────────────────────────────────

const contactSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  company: optionalTrimmed,
  trade: optionalTrimmed,
  email: z
    .union([z.email("Enter a valid email"), z.literal("")])
    .transform((v) => v || null),
  phone: optionalTrimmed,
});

export async function createContact(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const m = await requireMembership();
  const parsed = contactSchema.safeParse({
    name: formData.get("name"),
    company: formData.get("company") ?? undefined,
    trade: formData.get("trade") ?? undefined,
    email: formData.get("email") ?? "",
    phone: formData.get("phone") ?? undefined,
  });
  if (!parsed.success) return fieldErrorsFrom(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .insert({ org_id: m.orgId, ...parsed.data })
    .select("id")
    .single();

  if (error) return { error: `Could not add them to the crew: ${error.message}` };

  await logChange({
    orgId: m.orgId,
    userId: m.userId,
    entityType: "contact",
    entityId: data.id,
    action: "create",
    after: parsed.data as Json,
  });

  revalidatePath("/crew");
  return OK;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

const taskSchema = z.object({
  project_id: z.uuid(),
  name: z.string().trim().min(1, "Name the task").max(160),
  trade: optionalTrimmed,
  start_date: z.union([isoDate, z.literal("")]).transform((v) => v || null),
  duration_days: z.coerce
    .number()
    .int("Whole work days only")
    .min(1, "At least 1 work day")
    .max(365, "That is longer than a year of work days"),
  is_milestone: z.coerce.boolean().default(false),
  assignee_id: z.union([z.uuid(), z.literal("")]).transform((v) => v || null),
  predecessor_id: z.union([z.uuid(), z.literal("")]).transform((v) => v || null),
});

export async function createTask(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const m = await requireMembership();
  const parsed = taskSchema.safeParse({
    project_id: formData.get("project_id"),
    name: formData.get("name"),
    trade: formData.get("trade") ?? undefined,
    start_date: formData.get("start_date") ?? "",
    duration_days: formData.get("duration_days") ?? 1,
    is_milestone: formData.get("is_milestone") === "on",
    assignee_id: formData.get("assignee_id") ?? "",
    predecessor_id: formData.get("predecessor_id") ?? "",
  });
  if (!parsed.success) return fieldErrorsFrom(parsed.error);
  const input = parsed.data;

  const cal = await getWorkCalendar(m.orgId);

  // Milestones are a point in time; a duration would be meaningless.
  const durationDays = input.is_milestone ? 1 : input.duration_days;

  // Normalise the start onto a working day, and compute the finish — the DB
  // stores end_date as a plain column precisely because this arithmetic needs
  // the org calendar (see the scheduling migration).
  let startDate = input.start_date;
  let endDate: string | null = null;
  if (startDate) {
    startDate = formatIsoDate(addWorkDays(parseIsoDate(startDate), 0, cal));
    endDate = finishIsoDate(startDate, durationDays, cal);
  }

  const supabase = await createClient();
  const { data: task, error } = await supabase
    .from("tasks")
    .insert({
      org_id: m.orgId,
      project_id: input.project_id,
      name: input.name,
      trade: input.trade,
      start_date: startDate,
      end_date: endDate,
      duration_days: durationDays,
      is_milestone: input.is_milestone,
    })
    .select("id")
    .single();

  if (error) return { error: `Could not create the task: ${error.message}` };

  if (input.assignee_id) {
    const { error: aErr } = await supabase.from("assignments").insert({
      org_id: m.orgId,
      task_id: task.id,
      contact_id: input.assignee_id,
    });
    if (aErr) {
      return {
        error:
          `The task was created, but assigning it failed: ${aErr.message}. ` +
          `Assign it from the task list.`,
      };
    }
  }

  if (input.predecessor_id) {
    const { error: dErr } = await supabase.from("task_deps").insert({
      org_id: m.orgId,
      predecessor_id: input.predecessor_id,
      successor_id: task.id,
      dep_type: "FS",
      lag_days: 0,
    });
    if (dErr) {
      return {
        error:
          `The task was created, but linking it failed: ${dErr.message}. ` +
          `Add the dependency from the task list.`,
      };
    }
  }

  await logChange({
    orgId: m.orgId,
    userId: m.userId,
    entityType: "task",
    entityId: task.id,
    action: "create",
    after: {
      name: input.name,
      trade: input.trade,
      start_date: startDate,
      end_date: endDate,
      duration_days: durationDays,
      is_milestone: input.is_milestone,
    },
  });

  revalidatePath(`/projects/${input.project_id}`);
  revalidatePath("/", "layout");
  return OK;
}

// ─── Moving and resizing ─────────────────────────────────────────────────────

/** Engine-shaped views of the project's tasks and deps. */
async function engineInputs(orgId: string, projectId: string) {
  const detail = await getProjectDetail(orgId, projectId);
  if (!detail) throw new Error("Project not found");
  const tasks: Task[] = detail.tasks.map((t) => ({
    id: t.id,
    startDate: t.start_date,
    durationDays: t.duration_days,
    isMilestone: t.is_milestone,
  }));
  const deps: TaskDep[] = detail.deps.map((d) => ({
    predecessorId: d.predecessor_id,
    successorId: d.successor_id,
    depType: d.dep_type,
    lagDays: d.lag_days,
  }));
  return { detail, tasks, deps };
}

const moveSchema = z.object({
  project_id: z.uuid(),
  task_id: z.uuid(),
  start_date: isoDate,
});

/**
 * Move one task and cascade its dependents. Returns the number of tasks that
 * moved so the UI can say "Moved Framing and 3 downstream tasks".
 */
export async function moveTask(input: {
  project_id: string;
  task_id: string;
  start_date: string;
}): Promise<{ moved?: number; error?: string }> {
  const m = await requireMembership();
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { error: "That move was not a valid date. Reload and retry." };

  const cal = await getWorkCalendar(m.orgId);
  const { tasks, deps } = await engineInputs(m.orgId, parsed.data.project_id);

  let changes;
  try {
    changes = cascade({
      tasks,
      deps,
      changed: new Map([[parsed.data.task_id, parsed.data.start_date]]),
      calendar: cal,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not compute the move." };
  }
  if (changes.length === 0) return { moved: 0 };

  const supabase = await createClient();
  const { data: moved, error } = await supabase.rpc("apply_task_moves", {
    p_moves: changes.map((c) => ({
      task_id: c.taskId,
      start_date: c.toStartDate,
      end_date: c.toEndDate,
    })) as Json,
    p_source: "ui",
  });

  if (error) return { error: `Nothing was moved: ${error.message}` };

  revalidatePath(`/projects/${parsed.data.project_id}`);
  revalidatePath("/", "layout");
  return { moved: moved ?? changes.length };
}

const resizeSchema = z.object({
  project_id: z.uuid(),
  task_id: z.uuid(),
  duration_days: z.coerce.number().int().min(1).max(365),
});

export async function resizeTask(input: {
  project_id: string;
  task_id: string;
  duration_days: number;
}): Promise<{ moved?: number; error?: string }> {
  const m = await requireMembership();
  const parsed = resizeSchema.safeParse(input);
  if (!parsed.success) return { error: "That duration is not usable — whole work days, 1 to 365." };

  const cal = await getWorkCalendar(m.orgId);
  const { tasks, deps, detail } = await engineInputs(m.orgId, parsed.data.project_id);

  const target = detail.tasks.find((t) => t.id === parsed.data.task_id);
  if (!target) return { error: "That task no longer exists. Reload the page." };

  const supabase = await createClient();

  // Persist the new duration first (with its recomputed end), then cascade —
  // successors react to the finish moving.
  const newEnd = target.start_date
    ? finishIsoDate(target.start_date, parsed.data.duration_days, cal)
    : null;

  const { error: upErr } = await supabase
    .from("tasks")
    .update({ duration_days: parsed.data.duration_days, end_date: newEnd })
    .eq("org_id", m.orgId)
    .eq("id", parsed.data.task_id);
  if (upErr) return { error: `Could not resize the task: ${upErr.message}` };

  await logChange({
    orgId: m.orgId,
    userId: m.userId,
    entityType: "task",
    entityId: target.id,
    action: "resize",
    before: { duration_days: target.duration_days, end_date: target.end_date },
    after: { duration_days: parsed.data.duration_days, end_date: newEnd },
  });

  let movedCount = 0;
  if (target.start_date) {
    const adjusted = tasks.map((t) =>
      t.id === target.id ? { ...t, durationDays: parsed.data.duration_days } : t,
    );
    const changes = cascade({
      tasks: adjusted,
      deps,
      changed: new Map([[target.id, target.start_date]]),
      calendar: cal,
    }).filter((c) => c.taskId !== target.id);

    if (changes.length > 0) {
      const { data: moved, error } = await supabase.rpc("apply_task_moves", {
        p_moves: changes.map((c) => ({
          task_id: c.taskId,
          start_date: c.toStartDate,
          end_date: c.toEndDate,
        })) as Json,
        p_source: "ui",
      });
      if (error) return { error: `Resized, but the cascade failed: ${error.message}` };
      movedCount = moved ?? changes.length;
    }
  }

  revalidatePath(`/projects/${parsed.data.project_id}`);
  return { moved: movedCount };
}

const statusSchema = z.object({
  project_id: z.uuid(),
  task_id: z.uuid(),
  status: z.enum(["planned", "active", "blocked", "done"]),
});

export async function setTaskStatus(input: {
  project_id: string;
  task_id: string;
  status: "planned" | "active" | "blocked" | "done";
}): Promise<{ error?: string }> {
  const m = await requireMembership();
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { error: "That status is not one the schedule knows." };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("tasks")
    .select("status")
    .eq("org_id", m.orgId)
    .eq("id", parsed.data.task_id)
    .maybeSingle();

  const { error } = await supabase
    .from("tasks")
    .update({ status: parsed.data.status })
    .eq("org_id", m.orgId)
    .eq("id", parsed.data.task_id);
  if (error) return { error: `Could not update the status: ${error.message}` };

  await logChange({
    orgId: m.orgId,
    userId: m.userId,
    entityType: "task",
    entityId: parsed.data.task_id,
    action: "set_status",
    before: { status: before?.status } as Json,
    after: { status: parsed.data.status },
  });

  revalidatePath(`/projects/${parsed.data.project_id}`);
  revalidatePath("/", "layout");
  return {};
}

// ─── Dependencies ────────────────────────────────────────────────────────────

const depSchema = z.object({
  project_id: z.uuid(),
  predecessor_id: z.uuid(),
  successor_id: z.uuid(),
  dep_type: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
  lag_days: z.coerce.number().int().min(-60).max(365).default(0),
});

export async function addDependency(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const m = await requireMembership();
  const parsed = depSchema.safeParse({
    project_id: formData.get("project_id"),
    predecessor_id: formData.get("predecessor_id"),
    successor_id: formData.get("successor_id"),
    dep_type: formData.get("dep_type") ?? "FS",
    lag_days: formData.get("lag_days") ?? 0,
  });
  if (!parsed.success) return fieldErrorsFrom(parsed.error);
  const input = parsed.data;

  if (input.predecessor_id === input.successor_id) {
    return { error: "A task cannot depend on itself." };
  }

  // Reject cycles before writing (SPEC §4), naming the loop.
  const { deps, detail } = await engineInputs(m.orgId, input.project_id);
  const nameOf = (id: string) =>
    detail.tasks.find((t) => t.id === id)?.name ?? "that task";
  const cycle = wouldCreateCycle(deps, {
    predecessorId: input.predecessor_id,
    successorId: input.successor_id,
  });
  if (cycle) {
    return {
      error:
        `That link would make ${nameOf(input.predecessor_id)} and ` +
        `${nameOf(input.successor_id)} depend on each other. Remove one of the ` +
        `existing links first.`,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("task_deps")
    .insert({
      org_id: m.orgId,
      predecessor_id: input.predecessor_id,
      successor_id: input.successor_id,
      dep_type: input.dep_type,
      lag_days: input.lag_days,
    })
    .select("id")
    .single();

  if (error) {
    return {
      error: error.code === "23505"
        ? "Those two tasks are already linked."
        : `Could not link the tasks: ${error.message}`,
    };
  }

  await logChange({
    orgId: m.orgId,
    userId: m.userId,
    entityType: "task_dep",
    entityId: data.id,
    action: "create",
    after: {
      predecessor: nameOf(input.predecessor_id),
      successor: nameOf(input.successor_id),
      dep_type: input.dep_type,
      lag_days: input.lag_days,
    },
  });

  // Immediately reflow the successor so the link has a visible effect.
  const successor = detail.tasks.find((t) => t.id === input.successor_id);
  const predecessor = detail.tasks.find((t) => t.id === input.predecessor_id);
  if (successor?.start_date && predecessor?.start_date) {
    await moveTask({
      project_id: input.project_id,
      task_id: input.predecessor_id,
      start_date: predecessor.start_date,
    });
  }

  revalidatePath(`/projects/${input.project_id}`);
  return OK;
}

// ─── Assignment ──────────────────────────────────────────────────────────────

const assignSchema = z.object({
  project_id: z.uuid(),
  task_id: z.uuid(),
  contact_id: z.uuid(),
});

export async function assignTask(input: {
  project_id: string;
  task_id: string;
  contact_id: string;
}): Promise<{ error?: string }> {
  const m = await requireMembership();
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { error: "Pick a task and a person to assign." };

  const supabase = await createClient();
  const { error } = await supabase.from("assignments").insert({
    org_id: m.orgId,
    task_id: parsed.data.task_id,
    contact_id: parsed.data.contact_id,
  });

  if (error && error.code !== "23505") {
    return { error: `Could not assign it: ${error.message}` };
  }

  if (!error) {
    await logChange({
      orgId: m.orgId,
      userId: m.userId,
      entityType: "assignment",
      entityId: parsed.data.task_id,
      action: "assign",
      after: { task_id: parsed.data.task_id, contact_id: parsed.data.contact_id },
    });
  }

  revalidatePath(`/projects/${parsed.data.project_id}`);
  return {};
}

// ─── Demo seed ───────────────────────────────────────────────────────────────

/**
 * One click on the empty dashboard → a realistic project to explore: five
 * trades, a dependency chain, a milestone, and a crew. Uses the same actions
 * a real flow uses (and therefore the same RLS and logging).
 */
export async function seedDemoProject(): Promise<void> {
  const m = await requireMembership();
  const cal = await getWorkCalendar(m.orgId);
  const supabase = await createClient();

  const start = formatIsoDate(
    addWorkDays(parseIsoDate(todayInZone(m.timezone)), 0, cal),
  );

  const { data: project, error: pErr } = await supabase
    .from("projects")
    .insert({
      org_id: m.orgId,
      name: "Hillcrest Residence",
      job_number: "26-014",
      client_name: "Hillcrest Holdings",
      address: "402 Hillcrest Ave",
      starts_on: start,
    })
    .select("id")
    .single();
  if (pErr || !project) {
    throw new Error(`Could not seed the demo project: ${pErr?.message ?? "no id"}`);
  }

  const { data: crew } = await supabase
    .from("contacts")
    .insert(
      [
        { name: "Tom Brady Jr.", company: "Northstate Framing", trade: "Framing" },
        { name: "Maria Delgado", company: "Delgado Electric", trade: "Electrical" },
        { name: "Sam Okafor", company: "Summit Plumbing", trade: "Plumbing" },
      ].map((c) => ({ org_id: m.orgId, ...c })),
    )
    .select("id, trade");

  // Sequential FS chain with realistic durations, then a milestone.
  const plan = [
    { name: "Excavation & footings", trade: "Sitework", days: 5 },
    { name: "Foundation pour & cure", trade: "Concrete", days: 7 },
    { name: "Framing", trade: "Framing", days: 10 },
    { name: "Roof dry-in", trade: "Roofing", days: 4 },
    { name: "Rough plumbing", trade: "Plumbing", days: 5 },
    { name: "Rough electrical", trade: "Electrical", days: 5 },
  ];

  let cursor = start;
  let prevId: string | null = null;
  for (const step of plan) {
    const end = finishIsoDate(cursor, step.days, cal);
    const isFirst: boolean = prevId === null;
    // The explicit annotation matters: without it, inference cycles loop-
    // carried state (prevId → payload → result → prevId) into TS7022.
    const inserted: { data: { id: string } | null; error: { message: string } | null } =
      await supabase
        .from("tasks")
        .insert({
          org_id: m.orgId,
          project_id: project.id,
          name: step.name,
          trade: step.trade,
          start_date: cursor,
          end_date: end,
          duration_days: step.days,
          status: isFirst ? "active" : "planned",
        })
        .select("id")
        .single();
    const task = inserted.data;
    if (inserted.error || !task) break;

    if (prevId) {
      await supabase.from("task_deps").insert({
        org_id: m.orgId,
        predecessor_id: prevId,
        successor_id: task.id,
        dep_type: "FS",
        lag_days: 0,
      });
    }

    const assignee = (crew ?? []).find((c) => c.trade === step.trade);
    if (assignee) {
      await supabase.from("assignments").insert({
        org_id: m.orgId,
        task_id: task.id,
        contact_id: assignee.id,
      });
    }

    prevId = task.id;
    cursor = formatIsoDate(addWorkDays(parseIsoDate(end), 1, cal));
  }

  await supabase.from("tasks").insert({
    org_id: m.orgId,
    project_id: project.id,
    name: "Rough-in inspection",
    trade: null,
    start_date: cursor,
    end_date: cursor,
    duration_days: 1,
    is_milestone: true,
  });

  await logChange({
    orgId: m.orgId,
    userId: m.userId,
    entityType: "project",
    entityId: project.id,
    action: "seed_demo",
    after: { name: "Hillcrest Residence", tasks: plan.length + 1 },
  });

  revalidatePath("/", "layout");
  redirect(`/projects/${project.id}`);
}
