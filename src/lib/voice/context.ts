import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getWorkCalendar } from "@/lib/org/queries";
import { todayInZone } from "@/lib/schedule";
import type { WorkCalendar } from "@/lib/schedule";

/**
 * The slice of the org the planner is allowed to see (SPEC §5: pass only the
 * *relevant* projects' tasks and contacts, not the whole database — trimmed by
 * active project first). Everything the model may reference by id is in here;
 * anything it returns that is not in here fails validation.
 */

export type PlannerProject = {
  id: string;
  name: string;
  jobNumber: string | null;
  clientName: string | null;
  status: string;
  /**
   * Every task on the job, including the ones not in `tasks` below.
   *
   * Only active projects have their tasks passed in full, so this is the only
   * honest number to put in front of someone about to delete a finished one.
   */
  taskCount: number;
};

export type PlannerTask = {
  id: string;
  projectId: string;
  name: string;
  trade: string | null;
  startDate: string | null;
  endDate: string | null;
  /** `HH:MM` on-site window, or null for an all-day task. */
  startTime: string | null;
  endTime: string | null;
  durationDays: number;
  status: string;
  isMilestone: boolean;
  assigneeIds: string[];
};

export type PlannerContact = {
  id: string;
  name: string;
  company: string | null;
  trade: string | null;
  /** Whether an address exists — the model never sees or invents addresses. */
  hasEmail: boolean;
};

export type PlannerDep = {
  predecessorId: string;
  successorId: string;
  depType: "FS" | "SS" | "FF" | "SF";
  lagDays: number;
};

export type PlannerContext = {
  today: string;
  timezone: string;
  workingDays: number[];
  projects: PlannerProject[];
  tasks: PlannerTask[];
  deps: PlannerDep[];
  contacts: PlannerContact[];
  calendar: WorkCalendar;
};

export async function buildPlannerContext(
  orgId: string,
  timezone: string,
): Promise<PlannerContext> {
  const supabase = await createClient();
  const calendar = await getWorkCalendar(orgId);

  // Every project, whatever its status — but only the active ones' tasks (see
  // below). A job that is complete or on hold still has to be nameable: the
  // assistant could not rename, reopen or delete one it could not see, and
  // "delete that old job" is an ordinary thing to say. What SPEC §5 trims to
  // keep the prompt small is the *schedule*, and that trimming still holds.
  const [projectsRes, contactsRes, countsRes] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, job_number, client_name, status")
      .eq("org_id", orgId)
      .order("created_at", { ascending: true }),
    supabase
      .from("contacts")
      .select("id, name, company, trade, email")
      .eq("org_id", orgId)
      .order("name"),
    supabase.from("tasks").select("project_id").eq("org_id", orgId),
  ]);

  const taskCounts = new Map<string, number>();
  for (const row of countsRes.data ?? []) {
    taskCounts.set(row.project_id, (taskCounts.get(row.project_id) ?? 0) + 1);
  }

  const projects = (projectsRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    jobNumber: p.job_number,
    clientName: p.client_name,
    status: p.status,
    taskCount: taskCounts.get(p.id) ?? 0,
  }));
  const projectIds = projects.filter((p) => p.status === "active").map((p) => p.id);

  let tasks: PlannerTask[] = [];
  let deps: PlannerDep[] = [];

  if (projectIds.length > 0) {
    const [tasksRes, depsRes, assignRes] = await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, project_id, name, trade, start_date, end_date, start_time, end_time, duration_days, status, is_milestone",
        )
        .eq("org_id", orgId)
        .in("project_id", projectIds),
      supabase
        .from("task_deps")
        .select("predecessor_id, successor_id, dep_type, lag_days")
        .eq("org_id", orgId),
      supabase.from("assignments").select("task_id, contact_id").eq("org_id", orgId),
    ]);

    const assigneesByTask = new Map<string, string[]>();
    for (const a of assignRes.data ?? []) {
      const list = assigneesByTask.get(a.task_id);
      if (list) list.push(a.contact_id);
      else assigneesByTask.set(a.task_id, [a.contact_id]);
    }

    tasks = (tasksRes.data ?? []).map((t) => ({
      id: t.id,
      projectId: t.project_id,
      name: t.name,
      trade: t.trade,
      startDate: t.start_date,
      endDate: t.end_date,
      // Postgres hands back `HH:MM:SS`; everything above this line works in
      // `HH:MM`, which is also what the model is asked to produce.
      startTime: t.start_time ? t.start_time.slice(0, 5) : null,
      endTime: t.end_time ? t.end_time.slice(0, 5) : null,
      durationDays: t.duration_days,
      status: t.status,
      isMilestone: t.is_milestone,
      assigneeIds: assigneesByTask.get(t.id) ?? [],
    }));

    const taskIds = new Set(tasks.map((t) => t.id));
    deps = (depsRes.data ?? [])
      .filter((d) => taskIds.has(d.predecessor_id) && taskIds.has(d.successor_id))
      .map((d) => ({
        predecessorId: d.predecessor_id,
        successorId: d.successor_id,
        depType: d.dep_type,
        lagDays: d.lag_days,
      }));
  }

  return {
    today: todayInZone(timezone),
    timezone,
    workingDays: [...calendar.workingDays],
    projects,
    tasks,
    deps,
    contacts: (contactsRes.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      company: c.company,
      trade: c.trade,
      hasEmail: Boolean(c.email),
    })),
    calendar,
  };
}
