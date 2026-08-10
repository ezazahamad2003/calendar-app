import Link from "next/link";

import { requireMembership } from "@/lib/auth/dal";
import { listProjectsWithHealth } from "@/lib/org/queries";
import { signOut } from "@/app/(auth)/actions";
import { msConnectionState } from "@/lib/graph/factory";
import { VoiceBar } from "./voice-bar";

/**
 * Authenticated shell. Projects and crew live in the left rail (SPEC §7's
 * navigation surface); each page owns its main column. The rail collapses to a
 * top strip under 900px — a phone on a jobsite is the primary device.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const membership = await requireMembership();
  const [projects, msState] = await Promise.all([
    listProjectsWithHealth(membership.orgId, membership.timezone),
    msConnectionState(membership.orgId, membership.userId),
  ]);

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-org">
          <p className="rail-org-name">{membership.orgName}</p>
          <p className="rail-org-user">{membership.email}</p>
        </div>

        <nav className="rail-nav" aria-label="Main">
          <Link className="rail-link" href="/">
            Today
          </Link>
          <Link className="rail-link" href="/calendar">
            Calendar
          </Link>
          <Link className="rail-link" href="/crew">
            Crew
          </Link>
          <Link className="rail-link" href="/outbox">
            Outbox
          </Link>
        </nav>

        <div className="rail-ms">
          {msState.connected ? (
            <p className="rail-ms-ok" title={msState.email ?? undefined}>
              ✓ Outlook connected
            </p>
          ) : (
            <a className="rail-ms-connect" href="/api/microsoft/connect">
              Connect Outlook
            </a>
          )}
        </div>

        <div className="rail-section">
          <p className="rail-heading">Projects</p>
          {projects.length === 0 ? (
            <p className="rail-empty">None yet</p>
          ) : (
            <ul className="rail-projects">
              {projects.map(({ project, tasksLate }) => (
                <li key={project.id}>
                  <Link className="rail-project" href={`/projects/${project.id}`}>
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
        {msState.needsReauth ? (
          <div className="reauth-banner" role="alert">
            Outlook lost its connection — mail and calendar invites are paused
            until you <a href="/api/microsoft/connect">reconnect</a>. Nothing
            queued has been lost.
          </div>
        ) : null}
        {children}
        <VoiceBar />
      </div>
    </div>
  );
}
