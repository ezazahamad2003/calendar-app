import Link from "next/link";

import { requireMembership } from "@/lib/auth/dal";
import { listProjectsWithHealth, tasksOverlapping } from "@/lib/org/queries";
import { seedDemoProject } from "@/lib/org/actions";
import { todayInZone } from "@/lib/schedule";
import { monthGrid } from "@/lib/month";
import { tradeColor } from "@/lib/trades";
import { NewProjectForm } from "./new-project-form";

/**
 * The morning screen (SPEC §7): every active project with its health line,
 * and this month at a glance on the right.
 */
export default async function DashboardPage() {
  const m = await requireMembership();
  const today = todayInZone(m.timezone);
  const grid = monthGrid(today.slice(0, 7));

  const [projects, monthTasks] = await Promise.all([
    listProjectsWithHealth(m.orgId, m.timezone),
    tasksOverlapping(m.orgId, grid.firstDay, grid.lastDay),
  ]);

  const busyDays = new Map<string, string[]>();
  for (const t of monthTasks) {
    if (!t.start_date || !t.end_date) continue;
    for (const week of grid.weeks) {
      for (const day of week) {
        if (day >= t.start_date && day <= t.end_date) {
          const list = busyDays.get(day);
          const fill = tradeColor(t.trade).fill;
          if (list) {
            if (!list.includes(fill) && list.length < 3) list.push(fill);
          } else {
            busyDays.set(day, [fill]);
          }
        }
      }
    }
  }

  return (
    <main className="page page--split">
      <div className="page-col">
        <header className="page-head">
          <div>
            <p className="page-eyebrow">{m.orgName}</p>
            <h1 className="page-title">Today</h1>
          </div>
        </header>

        {projects.length === 0 ? (
          <section className="empty-card">
            <h2 className="empty-title">No projects yet</h2>
            <p className="empty-body">
              Add your first job below, or seed a realistic demo project to see
              the Gantt, calendar and cascade working before you enter real data.
            </p>
            <form action={seedDemoProject}>
              <button className="btn btn--ghost" type="submit">
                Seed a demo project
              </button>
            </form>
          </section>
        ) : (
          <section className="project-grid" aria-label="Projects">
            {projects.map(({ project, tasksTotal, tasksActive, tasksBlocked, tasksLate, nextMilestone }) => (
              <Link key={project.id} href={`/projects/${project.id}`} className="project-card">
                <div className="project-card-top">
                  <h2 className="project-card-name">{project.name}</h2>
                  {project.job_number ? (
                    <span className="project-card-job">#{project.job_number}</span>
                  ) : null}
                </div>
                {project.client_name ? (
                  <p className="project-card-client">{project.client_name}</p>
                ) : null}
                <p className="project-card-health">
                  {tasksTotal === 0 ? (
                    "No tasks scheduled yet"
                  ) : (
                    <>
                      {tasksActive} in flight
                      {tasksLate > 0 ? (
                        <span className="health-late"> · {tasksLate} late</span>
                      ) : null}
                      {tasksBlocked > 0 ? (
                        <span className="health-blocked"> · {tasksBlocked} blocked</span>
                      ) : null}
                    </>
                  )}
                </p>
                {nextMilestone ? (
                  <p className="project-card-milestone">
                    ◆ {nextMilestone.name} · {nextMilestone.date}
                  </p>
                ) : null}
              </Link>
            ))}
          </section>
        )}

        <NewProjectForm />
      </div>

      <aside className="page-rail" aria-label="This month">
        <div className="minical">
          <div className="minical-head">
            <span>{grid.label}</span>
            <Link className="minical-more" href="/calendar">
              Full calendar
            </Link>
          </div>
          <div className="minical-grid">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
              <span key={`h${i}`} className="minical-dow">
                {d}
              </span>
            ))}
            {grid.weeks.flat().map((day) => {
              const inMonth = day.slice(0, 7) === grid.month;
              const dots = busyDays.get(day) ?? [];
              return (
                <span
                  key={day}
                  className={[
                    "minical-day",
                    inMonth ? "" : "minical-day--out",
                    day === today ? "minical-day--today" : "",
                  ].join(" ")}
                >
                  {Number(day.slice(8, 10))}
                  <span className="minical-dots">
                    {dots.map((fill, i) => (
                      <i key={i} style={{ background: fill }} />
                    ))}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      </aside>
    </main>
  );
}
