import Link from "next/link";

import { requireMembership } from "@/lib/auth/dal";
import { listProjectsWithHealth } from "@/lib/org/queries";
import { signOut } from "@/app/(auth)/actions";
import { connectionStates, summarize } from "@/lib/providers/factory";
import { projectColors } from "@/lib/project-color";
import { VoicePanel } from "./voice-panel";

/**
 * Authenticated shell: navigation left, the work in the middle, the assistant
 * right. Each page owns its main column.
 *
 * Three columns collapse to one under 1100px — a phone on a jobsite is the
 * primary device, and there the assistant sits under the content rather than
 * beside it.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const membership = await requireMembership();
  const [projects, states] = await Promise.all([
    listProjectsWithHealth(membership.orgId, membership.timezone),
    connectionStates(membership.orgId, membership.userId),
  ]);
  const connections = summarize(states);
  // Same ordering as the calendar's (both created_at ascending), so the dot
  // beside a job here is the colour its bars carry there. That is the whole
  // point of the dot — the rail is the calendar's legend.
  const colors = projectColors(projects.map((p) => p.project));

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-org">
          <p className="rail-org-name">{membership.orgName}</p>
          <p className="rail-org-user">{membership.email}</p>
        </div>

        <nav className="rail-nav" aria-label="Main">
          {/* Calendar is home — the schedule is the product, and "Today" was a
              wrapper around content that belongs on these pages. */}
          <Link className="rail-link" href="/">
            Calendar
          </Link>
          <Link className="rail-link" href="/projects">
            Projects
          </Link>
          <Link className="rail-link" href="/crew">
            Crew
          </Link>
          <Link className="rail-link" href="/outbox">
            Outbox
          </Link>
          <Link className="rail-link" href="/connections">
            Connections
          </Link>
        </nav>

        {/* Hidden entirely when neither provider is configured — offering a
            button that cannot work is worse than offering nothing. Which
            accounts to connect is the user's call, so the rail only reports
            the state and sends them to the page where they choose. */}
        {connections.anyAvailable ? (
          <div className="rail-ms">
            {connections.active ? (
              <Link
                className="rail-ms-ok"
                href="/connections"
                title={connections.active.email ?? undefined}
              >
                ✓ Sending via {connections.active.label}
              </Link>
            ) : (
              <Link className="rail-ms-connect" href="/connections">
                Connect email
              </Link>
            )}
          </div>
        ) : null}

        <div className="rail-section">
          <div className="rail-section-head">
            <p className="rail-heading">Jobs</p>
            <Link className="rail-add" href="/projects/new" aria-label="Add a project">
              + New
            </Link>
          </div>
          {projects.length === 0 ? (
            <Link className="rail-empty-add" href="/projects/new">
              Add your first project
            </Link>
          ) : (
            <ul className="rail-projects">
              {projects.map(({ project, tasksLate }) => (
                <li key={project.id}>
                  <Link className="rail-project" href={`/projects/${project.id}`}>
                    <span
                      className="rail-project-dot"
                      style={{ background: colors.get(project.id)?.fill }}
                      aria-hidden
                    />
                    <span className="rail-project-name">{project.name}</span>
                    {tasksLate > 0 ? (
                      <span className="rail-late" aria-label={`${tasksLate} late`}>
                        {tasksLate}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form action={signOut} className="rail-signout-form">
          <button className="rail-signout" type="submit">
            Sign out
          </button>
        </form>
      </aside>

      <div className="shell-main">
        {/* Only alarming when nothing else can send. With a second account
            still connected, a dead grant is a note, not an outage. */}
        {connections.stale.length > 0 ? (
          <div className="reauth-banner" role="alert">
            {connections.stale.map((s) => s.label).join(" and ")} lost{" "}
            {connections.stale.length > 1 ? "their connections" : "its connection"}
            {connections.active ? (
              <>
                {" "}
                — sending continues through {connections.active.label}.{" "}
                <Link href="/connections">Reconnect</Link> to switch back.
              </>
            ) : (
              <>
                {" "}
                — mail and calendar invites are paused until you{" "}
                <Link href="/connections">reconnect</Link>. Nothing queued has
                been lost.
              </>
            )}
          </div>
        ) : null}
        {children}
      </div>

      <VoicePanel />
    </div>
  );
}
