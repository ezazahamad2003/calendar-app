import Link from "next/link";
import { notFound } from "next/navigation";

import { requireMembership } from "@/lib/auth/dal";
import { getProjectDetail, getWorkCalendar } from "@/lib/org/queries";
import {
  addCalendarDays,
  analyseSchedule,
  formatIsoDate,
  isWorkingDay,
  parseIsoDate,
  todayInZone,
} from "@/lib/schedule";
import type { Task, TaskDep } from "@/lib/schedule";
import { tradeColor } from "@/lib/trades";
import { Gantt } from "./gantt";
import type { GanttDep, GanttTask } from "./gantt";
import { NewTaskForm, AddDependencyForm } from "./task-forms";
import { TaskTable } from "./task-table";

const ZOOMS = { week: 40, quarter: 14, year: 5 } as const;
type Zoom = keyof typeof ZOOMS;

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ z?: string }>;
}) {
  const [{ id }, { z }] = await Promise.all([params, searchParams]);
  const zoom: Zoom = z === "quarter" || z === "year" ? z : "week";
  const dayWidth = ZOOMS[zoom];

  const m = await requireMembership();
  const [detail, calendar] = await Promise.all([
    getProjectDetail(m.orgId, id),
    getWorkCalendar(m.orgId),
  ]);
  if (!detail) notFound();

  const today = todayInZone(m.timezone);

  // ── Engine views ──────────────────────────────────────────────────────────
  const engineTasks: Task[] = detail.tasks.map((t) => ({
    id: t.id,
    startDate: t.start_date,
    durationDays: t.duration_days,
    isMilestone: t.is_milestone,
  }));
  const engineDeps: TaskDep[] = detail.deps.map((d) => ({
    predecessorId: d.predecessor_id,
    successorId: d.successor_id,
    depType: d.dep_type,
    lagDays: d.lag_days,
  }));

  let criticalIds = new Set<string>();
  try {
    criticalIds = new Set(analyseSchedule(engineTasks, engineDeps, calendar).criticalPath);
  } catch {
    // A cycle written outside the app should not take the page down; the
    // add-dependency path prevents creating one here.
  }

  // ── Timeline geometry, all in calendar days off a fixed origin ────────────
  let minStart = today;
  let maxEnd = today;
  for (const t of detail.tasks) {
    if (t.start_date && t.start_date < minStart) minStart = t.start_date;
    if (t.end_date && t.end_date > maxEnd) maxEnd = t.end_date;
  }

  const origin = addCalendarDays(parseIsoDate(minStart < today ? minStart : today), -2);
  const endBound = addCalendarDays(parseIsoDate(maxEnd > today ? maxEnd : today), 10);
  const totalDays = Math.max(
    14,
    Math.round((endBound.getTime() - origin.getTime()) / 86_400_000) + 1,
  );

  const dayOffset = (iso: string) =>
    Math.round((parseIsoDate(iso).getTime() - origin.getTime()) / 86_400_000);

  const contactName = new Map(detail.contacts.map((c) => [c.id, c.name]));

  const ganttTasks: GanttTask[] = detail.tasks.map((t) => {
    const color = tradeColor(t.trade);
    return {
      id: t.id,
      name: t.name,
      trade: t.trade,
      status: t.status,
      startDate: t.start_date,
      endDate: t.end_date,
      durationDays: t.duration_days,
      isMilestone: t.is_milestone,
      offset: t.start_date ? dayOffset(t.start_date) : null,
      span: t.start_date && t.end_date ? dayOffset(t.end_date) - dayOffset(t.start_date) + 1 : 1,
      fill: color.fill,
      text: color.text,
      critical: criticalIds.has(t.id),
      assignees: (detail.assignments.get(t.id) ?? [])
        .map((cid) => contactName.get(cid) ?? "")
        .filter(Boolean),
    };
  });

  const ganttDeps: GanttDep[] = detail.deps.map((d) => ({
    from: d.predecessor_id,
    to: d.successor_id,
  }));

  // Non-working shading + month tick marks, precomputed so the client stays dumb.
  const workingMask: boolean[] = [];
  const monthTicks: { offset: number; label: string }[] = [];
  for (let i = 0; i < totalDays; i += 1) {
    const day = addCalendarDays(origin, i);
    workingMask.push(isWorkingDay(day, calendar));
    if (day.getUTCDate() === 1 || i === 0) {
      monthTicks.push({
        offset: i,
        label: new Intl.DateTimeFormat("en-US", {
          month: "short",
          ...(day.getUTCMonth() === 0 || i === 0 ? { year: "numeric" } : {}),
          timeZone: "UTC",
        }).format(day),
      });
    }
  }

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <p className="page-eyebrow">
            {detail.project.job_number ? `#${detail.project.job_number} · ` : ""}
            {detail.project.client_name ?? "Project"}
          </p>
          <h1 className="page-title">{detail.project.name}</h1>
        </div>
        <nav className="zoom" aria-label="Zoom">
          {(Object.keys(ZOOMS) as Zoom[]).map((level) => (
            <Link
              key={level}
              href={`/projects/${id}?z=${level}`}
              className={`zoom-link${zoom === level ? " zoom-link--on" : ""}`}
              aria-current={zoom === level ? "true" : undefined}
            >
              {level}
            </Link>
          ))}
        </nav>
      </header>

      {detail.tasks.length === 0 ? (
        <section className="empty-card">
          <h2 className="empty-title">Nothing scheduled yet</h2>
          <p className="empty-body">Add the first task below — the Gantt appears as soon as one has a date.</p>
        </section>
      ) : (
        <Gantt
          projectId={id}
          tasks={ganttTasks}
          deps={ganttDeps}
          totalDays={totalDays}
          dayWidth={dayWidth}
          originIso={formatIsoDate(origin)}
          todayOffset={dayOffset(today)}
          workingMask={workingMask}
          monthTicks={monthTicks}
        />
      )}

      <TaskTable
        projectId={id}
        tasks={ganttTasks}
        contacts={detail.contacts.map((c) => ({ id: c.id, name: c.name }))}
      />

      <div className="form-row">
        <NewTaskForm
          projectId={id}
          contacts={detail.contacts.map((c) => ({ id: c.id, name: c.name }))}
          tasks={detail.tasks.map((t) => ({ id: t.id, name: t.name }))}
        />
        {detail.tasks.length >= 2 ? (
          <AddDependencyForm
            projectId={id}
            tasks={detail.tasks.map((t) => ({ id: t.id, name: t.name }))}
          />
        ) : null}
      </div>
    </main>
  );
}
