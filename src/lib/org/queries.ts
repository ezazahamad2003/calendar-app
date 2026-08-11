import "server-only";

import { createClient } from "@/lib/supabase/server";
import { todayInZone } from "@/lib/schedule";
import type { IsoWeekday, WorkCalendar } from "@/lib/schedule";
import type { Database } from "@/lib/database.types";

/**
 * Read side of the org data layer. Every query runs on the user-scoped client,
 * so RLS enforces tenancy; the explicit `org_id` filters are defense in depth
 * and documentation, not the boundary.
 */

export type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
export type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];
export type DepRow = Database["public"]["Tables"]["task_deps"]["Row"];
export type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];

export type ProjectHealth = {
  project: ProjectRow;
  tasksTotal: number;
  tasksActive: number;
  tasksBlocked: number;
  /** Not done, and end date before today in the org's zone. */
  tasksLate: number;
  /** Earliest upcoming milestone, if any. */
  nextMilestone: { name: string; date: string } | null;
};

/** The org's work calendar in engine form. Falls back to Mon–Fri. */
export async function getWorkCalendar(orgId: string): Promise<WorkCalendar> {
  const supabase = await createClient();

  const { data: cal } = await supabase
    .from("work_calendars")
    .select("id, working_days")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // Onboarding seeds 'Standard'; this fallback only fires for orgs that
  // somehow lost it, and Mon–Fri is the least surprising answer.
  if (!cal) return { workingDays: [1, 2, 3, 4, 5], holidays: [] };

  const { data: holidays } = await supabase
    .from("holidays")
    .select("date")
    .eq("calendar_id", cal.id);

  return {
    workingDays: cal.working_days as IsoWeekday[],
    holidays: (holidays ?? []).map((h) => h.date),
  };
}

export async function listProjectsWithHealth(
  orgId: string,
  timezone: string,
): Promise<ProjectHealth[]> {
  const supabase = await createClient();
  const today = todayInZone(timezone);

  const [{ data: projects, error: pErr }, { data: tasks, error: tErr }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("*")
        .eq("org_id", orgId)
        .order("created_at", { ascending: true }),
      supabase
        .from("tasks")
        .select("id, project_id, name, status, start_date, end_date, is_milestone")
        .eq("org_id", orgId),
    ]);

  if (pErr) throw new Error(`Could not load projects: ${pErr.message}`);
  if (tErr) throw new Error(`Could not load tasks: ${tErr.message}`);

  const byProject = new Map<string, NonNullable<typeof tasks>>();
  for (const t of tasks ?? []) {
    const list = byProject.get(t.project_id);
    if (list) list.push(t);
    else byProject.set(t.project_id, [t]);
  }

  return (projects ?? []).map((project) => {
    const list = byProject.get(project.id) ?? [];
    const late = list.filter(
      (t) => t.status !== "done" && t.end_date !== null && t.end_date < today,
    );
    const milestones = list
      .filter((t) => t.is_milestone && t.start_date !== null && t.start_date >= today)
      .sort((a, b) => (a.start_date as string).localeCompare(b.start_date as string));

    return {
      project,
      tasksTotal: list.length,
      tasksActive: list.filter((t) => t.status === "active").length,
      tasksBlocked: list.filter((t) => t.status === "blocked").length,
      tasksLate: late.length,
      nextMilestone: milestones[0]
        ? { name: milestones[0].name, date: milestones[0].start_date as string }
        : null,
    };
  });
}

export type ProjectDetail = {
  project: ProjectRow;
  tasks: TaskRow[];
  deps: DepRow[];
  contacts: ContactRow[];
  /** task id → contact ids assigned to it. */
  assignments: Map<string, string[]>;
};

export async function getProjectDetail(
  orgId: string,
  projectId: string,
): Promise<ProjectDetail | null> {
  const supabase = await createClient();

  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the project: ${error.message}`);
  if (!project) return null;

  const [tasksRes, depsRes, contactsRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("*")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase.from("task_deps").select("*").eq("org_id", orgId),
    supabase
      .from("contacts")
      .select("*")
      .eq("org_id", orgId)
      .order("name", { ascending: true }),
  ]);

  if (tasksRes.error) throw new Error(`Could not load tasks: ${tasksRes.error.message}`);

  const tasks = tasksRes.data ?? [];
  const taskIds = new Set(tasks.map((t) => t.id));
  const deps = (depsRes.data ?? []).filter(
    (d) => taskIds.has(d.predecessor_id) && taskIds.has(d.successor_id),
  );

  const assignments = new Map<string, string[]>();
  if (taskIds.size > 0) {
    const { data: rows } = await supabase
      .from("assignments")
      .select("task_id, contact_id")
      .eq("org_id", orgId)
      .in("task_id", [...taskIds]);
    for (const row of rows ?? []) {
      const list = assignments.get(row.task_id);
      if (list) list.push(row.contact_id);
      else assignments.set(row.task_id, [row.contact_id]);
    }
  }

  return { project, tasks, deps, contacts: contactsRes.data ?? [], assignments };
}

/**
 * Every project, oldest first — the ordering that decides colours.
 *
 * Deliberately its own query rather than a field on the calendar's task join:
 * colour comes from a project's *position among all projects*, so it cannot be
 * derived from whichever subset of projects happens to have tasks in the
 * visible window. Two different months would otherwise colour the same job
 * differently.
 */
export async function listProjectOrder(
  orgId: string,
): Promise<{ id: string; name: string; color: string | null }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, color")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true }); // tiebreak, so the order is total

  if (error) throw new Error(`Could not load projects: ${error.message}`);
  return data ?? [];
}

export async function listContacts(orgId: string): Promise<ContactRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) throw new Error(`Could not load your crew: ${error.message}`);
  return data ?? [];
}

export type CalendarTask = Pick<
  TaskRow,
  | "id"
  | "project_id"
  | "name"
  | "trade"
  | "status"
  | "start_date"
  | "end_date"
  | "start_time"
  | "end_time"
  | "is_milestone"
> & {
  project_name: string;
  /** Explicit color if one was chosen; null means derive from the name. */
  project_color: string | null;
};

/** Every scheduled task overlapping [fromIso, toIso], for the calendar grid. */
export async function tasksOverlapping(
  orgId: string,
  fromIso: string,
  toIso: string,
): Promise<CalendarTask[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, project_id, name, trade, status, start_date, end_date, start_time, end_time, is_milestone, projects(name, color)",
    )
    .eq("org_id", orgId)
    .not("start_date", "is", null)
    .lte("start_date", toIso)
    .gte("end_date", fromIso)
    // Timed work first and in clock order, so the day column is built in the
    // order it will be read even before the overlap pass runs.
    .order("start_time", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });

  if (error) throw new Error(`Could not load the calendar: ${error.message}`);

  return (data ?? []).map((row) => {
    const { projects, ...task } = row;
    return {
      ...task,
      project_name: projects?.name ?? "",
      project_color: projects?.color ?? null,
    };
  });
}
