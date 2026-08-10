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
};

export type PlannerTask = {
  id: string;
  projectId: string;
  name: string;
  trade: string | null;
  startDate: string | null;
  endDate: string | null;
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

  const [projectsRes, contactsRes] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, job_number, client_name, status")
      .eq("org_id", orgId)
      .eq("status", "active")
      .order("created_at", { ascending: true }),
    supabase
      .from("contacts")
      .select("id, name, company, trade, email")
      .eq("org_id", orgId)
      .order("name"),
  ]);

  const projects = (projectsRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    jobNumber: p.job_number,
    clientName: p.client_name,
  }));
  const projectIds = projects.map((p) => p.id);

  let tasks: PlannerTask[] = [];
  let deps: PlannerDep[] = [];

  if (projectIds.length > 0) {
    const [tasksRes, depsRes, assignRes] = await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, project_id, name, trade, start_date, end_date, duration_days, status, is_milestone",
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
