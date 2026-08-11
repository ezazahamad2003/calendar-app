import "server-only";

import { createClient } from "@/lib/supabase/server";
import { humanRange } from "@/lib/format-date";
import { analyseSchedule } from "@/lib/schedule";
import type { PlannerContext } from "./context";

/**
 * What the assistant can look up for itself.
 *
 * The old pipeline had one shot: the whole active schedule was dumped into a
 * prompt and the model answered once, in JSON, with a plan. That made it good
 * at "push framing back two weeks" and incapable of "did Alex ever get told
 * about Tuesday?" — which is most of what someone running jobs actually wants
 * to ask.
 *
 * So the active schedule stays in the system prompt (ids have to be there for
 * the model to reference them), and everything *else* about the business is a
 * tool it can call: finished jobs, who is on what, what went out to whom, what
 * changed last week. Reads are free and side-effect-free. There is exactly one
 * write, `propose_changes`, and it does not write — it produces a diff for a
 * human to confirm. That asymmetry is the safety model: the assistant can look
 * at anything and change nothing on its own.
 */

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const str = (description: string) => ({ type: "string", description });
const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_projects",
      description:
        "Every project including completed and on-hold ones, with how many tasks are late or blocked. The system prompt only carries ACTIVE projects, so use this whenever the question might touch a finished or paused job.",
      parameters: obj({}),
    },
  },
  {
    type: "function",
    function: {
      name: "get_project",
      description:
        "One project in full: every task with its dates, duration, status, trade and assignees, plus the dependency links and which tasks are on the critical path.",
      parameters: obj(
        { projectId: str("The project id, exactly as given in the context.") },
        ["projectId"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "person_schedule",
      description:
        "What one person is booked on, and when. Use for 'is Alex free on Tuesday', 'what has Tom got on', 'who can take this'.",
      parameters: obj(
        {
          contactId: str("The contact id, exactly as given in the context."),
          from: str("Optional ISO date lower bound, YYYY-MM-DD."),
          to: str("Optional ISO date upper bound, YYYY-MM-DD."),
        },
        ["contactId"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "list_messages",
      description:
        "The outbox: emails and calendar invites, who they went to, whether they sent or failed and why. Use for 'did Alex get told', 'what went out yesterday', 'why did that fail'.",
      parameters: obj({
        status: str("Optional filter: draft, queued, sent or failed."),
        limit: { type: "integer", description: "Default 20, max 100." },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "recent_changes",
      description:
        "The audit trail: what changed, when, by voice or by hand, with the transcript that caused it. Use for 'what did I change yesterday', 'who moved framing', 'undo what I just did' (read it first, then propose the reverse).",
      parameters: obj({
        limit: { type: "integer", description: "Default 20, max 100." },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "propose_changes",
      description:
        "Propose a change to the schedule. This does NOT apply anything — it returns a diff the user reads and confirms. Call it once you know exactly what should happen. Everything that writes goes through here: creating projects, tasks and contacts; renaming and recolouring them; moving, resizing and re-timing tasks; assigning and unassigning people; linking and unlinking dependencies; deleting any of it; and sending email.",
      parameters: obj(
        {
          summary: str("One sentence, read back to the user before they confirm."),
          operations: {
            type: "array",
            description:
              "The operations, in the order they should happen. Same shapes as the plan schema in your instructions.",
            items: { type: "object", additionalProperties: true },
          },
          notes: str(
            "Optional: what you could not do while doing the rest, e.g. times of day being dropped.",
          ),
          confidence: str("'high' or 'low'."),
        },
        ["summary", "operations", "confidence"],
      ),
    },
  },
];

// ── Executors ────────────────────────────────────────────────────────────────

/**
 * Results are shaped for a language model, not a UI: short field names, dates
 * pre-formatted, nothing nested more than it needs to be. Every one is scoped
 * to the caller's org through the user-scoped client, so RLS is the backstop
 * even if an argument is wrong.
 */

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: PlannerContext,
  orgId: string,
): Promise<unknown> {
  switch (name) {
    case "list_projects":
      return listProjects(orgId);
    case "get_project":
      return getProject(orgId, String(args.projectId ?? ""), ctx);
    case "person_schedule":
      return personSchedule(
        orgId,
        String(args.contactId ?? ""),
        typeof args.from === "string" ? args.from : null,
        typeof args.to === "string" ? args.to : null,
      );
    case "list_messages":
      return listMessages(
        orgId,
        typeof args.status === "string" ? args.status : null,
        Number(args.limit) || 20,
      );
    case "recent_changes":
      return recentChanges(orgId, Number(args.limit) || 20);
    default:
      return { error: `Unknown tool ${name}.` };
  }
}

async function listProjects(orgId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("projects")
    .select("id, name, status, job_number, client_name, address, starts_on")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });

  const { data: tasks } = await supabase
    .from("tasks")
    .select("project_id, status, end_date")
    .eq("org_id", orgId);

  const today = new Date().toISOString().slice(0, 10);
  return (data ?? []).map((p) => {
    const mine = (tasks ?? []).filter((t) => t.project_id === p.id);
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      client: p.client_name,
      jobNumber: p.job_number,
      address: p.address,
      startsOn: p.starts_on,
      taskCount: mine.length,
      late: mine.filter(
        (t) => t.status !== "done" && t.end_date !== null && t.end_date < today,
      ).length,
      blocked: mine.filter((t) => t.status === "blocked").length,
    };
  });
}

async function getProject(orgId: string, projectId: string, ctx: PlannerContext) {
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, status, client_name, address, job_number, starts_on")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle();

  if (!project) return { error: "No project with that id." };

  const [{ data: tasks }, { data: deps }, { data: assigns }, { data: contacts }] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, name, trade, start_date, end_date, start_time, end_time, duration_days, status, is_milestone",
        )
        .eq("org_id", orgId)
        .eq("project_id", projectId),
      supabase
        .from("task_deps")
        .select("predecessor_id, successor_id, dep_type, lag_days")
        .eq("org_id", orgId),
      supabase.from("assignments").select("task_id, contact_id").eq("org_id", orgId),
      supabase.from("contacts").select("id, name").eq("org_id", orgId),
    ]);

  const taskIds = new Set((tasks ?? []).map((t) => t.id));
  const mineDeps = (deps ?? []).filter(
    (d) => taskIds.has(d.predecessor_id) && taskIds.has(d.successor_id),
  );
  const nameOf = new Map((contacts ?? []).map((c) => [c.id, c.name]));

  // Critical path and finish date, so "what's actually holding this job up"
  // and "when does it land" are answerable rather than something the model has
  // to infer from a list of dates.
  let critical = new Set<string>();
  let projectFinish: string | null = null;
  try {
    const analysis = analyseSchedule(
      (tasks ?? []).map((t) => ({
        id: t.id,
        startDate: t.start_date,
        durationDays: t.duration_days,
        isMilestone: t.is_milestone,
      })),
      mineDeps.map((d) => ({
        predecessorId: d.predecessor_id,
        successorId: d.successor_id,
        depType: d.dep_type,
        lagDays: d.lag_days,
      })),
      ctx.calendar,
    );
    critical = new Set(analysis.criticalPath);
    projectFinish = analysis.projectFinish;
  } catch {
    // A cyclic or half-scheduled graph shouldn't lose the whole answer.
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      client: project.client_name,
      address: project.address,
      jobNumber: project.job_number,
      finishes: projectFinish ? humanRange(projectFinish, null) : null,
    },
    tasks: (tasks ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      trade: t.trade,
      status: t.status,
      milestone: t.is_milestone,
      when: t.start_date ? humanRange(t.start_date, t.end_date) : "unscheduled",
      startDate: t.start_date,
      endDate: t.end_date,
      startTime: t.start_time ? t.start_time.slice(0, 5) : null,
      endTime: t.end_time ? t.end_time.slice(0, 5) : null,
      days: t.duration_days,
      onCriticalPath: critical.has(t.id),
      assignees: (assigns ?? [])
        .filter((a) => a.task_id === t.id)
        .map((a) => nameOf.get(a.contact_id) ?? "someone"),
    })),
    dependencies: mineDeps.map((d) => ({
      predecessor: (tasks ?? []).find((t) => t.id === d.predecessor_id)?.name,
      successor: (tasks ?? []).find((t) => t.id === d.successor_id)?.name,
      type: d.dep_type,
      lagDays: d.lag_days,
    })),
  };
}

async function personSchedule(
  orgId: string,
  contactId: string,
  from: string | null,
  to: string | null,
) {
  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, name, company, trade, email, phone")
    .eq("org_id", orgId)
    .eq("id", contactId)
    .maybeSingle();

  if (!contact) return { error: "No contact with that id." };

  const { data: assigns } = await supabase
    .from("assignments")
    .select("task_id")
    .eq("org_id", orgId)
    .eq("contact_id", contactId);

  const taskIds = (assigns ?? []).map((a) => a.task_id);
  if (taskIds.length === 0) {
    return { person: contact.name, hasEmail: Boolean(contact.email), booked: [] };
  }

  let query = supabase
    .from("tasks")
    .select("id, name, start_date, end_date, status, projects(name)")
    .eq("org_id", orgId)
    .in("id", taskIds);

  // Overlap, not containment: a task that starts before the window and runs
  // into it still makes the person busy during it.
  if (to) query = query.lte("start_date", to);
  if (from) query = query.gte("end_date", from);

  const { data: tasks } = await query;

  return {
    person: contact.name,
    company: contact.company,
    trade: contact.trade,
    hasEmail: Boolean(contact.email),
    hasPhone: Boolean(contact.phone),
    booked: (tasks ?? []).map((t) => ({
      task: t.name,
      project: t.projects?.name ?? "",
      status: t.status,
      when: t.start_date ? humanRange(t.start_date, t.end_date) : "unscheduled",
      startDate: t.start_date,
      endDate: t.end_date,
    })),
  };
}

async function listMessages(orgId: string, status: string | null, limit: number) {
  const supabase = await createClient();
  let query = supabase
    .from("outbound_messages")
    .select("subject, channel, status, error, created_at, sent_at, contacts(name), tasks(name)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));

  if (status) query = query.eq("status", status as "draft" | "queued" | "sent" | "failed");

  const { data } = await query;
  return (data ?? []).map((m) => ({
    to: m.contacts?.name ?? "—",
    about: m.tasks?.name ?? null,
    channel: m.channel,
    subject: m.subject,
    status: m.status,
    error: m.error,
    createdAt: m.created_at,
    sentAt: m.sent_at,
  }));
}

async function recentChanges(orgId: string, limit: number) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("change_log")
    .select("entity_type, action, before, after, source, transcript, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));

  return (data ?? []).map((c) => ({
    what: `${c.entity_type} ${c.action}`,
    before: c.before,
    after: c.after,
    how: c.source,
    said: c.transcript,
    at: c.created_at,
  }));
}
