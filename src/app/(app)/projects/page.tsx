import Link from "next/link";
import type { Metadata } from "next";

import { requireMembership } from "@/lib/auth/dal";
import { listProjectsWithHealth } from "@/lib/org/queries";
import { seedDemoProject } from "@/lib/org/actions";

export const metadata: Metadata = { title: "Projects | Foreman" };

/**
 * Every project with its health line — what SPEC §7 asks the morning screen to
 * show: tasks in flight, what's late, what's blocked, next milestone.
 *
 * Its own page now rather than the home screen, because the calendar earns
 * that spot: this is the "how are my jobs doing" view, consulted deliberately.
 */
export default async function ProjectsPage() {
  const m = await requireMembership();
  const projects = await listProjectsWithHealth(m.orgId, m.timezone);

  const totals = projects.reduce(
    (acc, p) => ({
      active: acc.active + p.tasksActive,
      late: acc.late + p.tasksLate,
      blocked: acc.blocked + p.tasksBlocked,
    }),
    { active: 0, late: 0, blocked: 0 },
  );

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <p className="page-eyebrow">{m.orgName}</p>
          <h1 className="page-title">Projects</h1>
        </div>
        {projects.length > 0 ? (
          <Link className="btn" href="/projects/new">
            Add a project
          </Link>
        ) : null}
      </header>

      {projects.length === 0 ? (
        <section className="empty-card">
          <h2 className="empty-title">No projects yet</h2>
          <p className="empty-body">
            Add a job to start scheduling, or seed a realistic demo project to
            see the Gantt, calendar and cascade working before you enter real
            data.
          </p>
          <div className="empty-actions">
            <Link className="btn" href="/projects/new">
              Add a project
            </Link>
            <form action={seedDemoProject}>
              <button className="btn btn--ghost" type="submit">
                Seed a demo project
              </button>
            </form>
          </div>
        </section>
      ) : (
        <>
          <p className="projects-summary">
            {projects.length} {projects.length === 1 ? "job" : "jobs"} ·{" "}
            {totals.active} in flight
            {totals.late > 0 ? (
              <span className="health-late"> · {totals.late} late</span>
            ) : null}
            {totals.blocked > 0 ? (
              <span className="health-blocked"> · {totals.blocked} blocked</span>
            ) : null}
          </p>

          <section className="project-grid" aria-label="Projects">
            {projects.map(
              ({
                project,
                tasksTotal,
                tasksActive,
                tasksBlocked,
                tasksLate,
                nextMilestone,
              }) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="project-card"
                >
                  <div className="project-card-top">
                    <h2 className="project-card-name">{project.name}</h2>
                    {project.job_number ? (
                      <span className="project-card-job">#{project.job_number}</span>
                    ) : null}
                  </div>
                  {project.client_name ? (
                    <p className="project-card-client">{project.client_name}</p>
                  ) : null}
                  {project.address ? (
                    <p className="project-card-client">{project.address}</p>
                  ) : null}
                  <p className="project-card-health">
                    {tasksTotal === 0 ? (
                      "No tasks scheduled yet"
                    ) : (
                      <>
                        {tasksActive} in flight of {tasksTotal}
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
              ),
            )}
          </section>
        </>
      )}
    </main>
  );
}
