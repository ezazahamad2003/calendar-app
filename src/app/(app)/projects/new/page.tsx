import type { Metadata } from "next";

import { requireMembership } from "@/lib/auth/dal";
import { ProjectFields } from "../../new-project-form";

export const metadata: Metadata = { title: "New project | Foreman" };

/**
 * A project's own page rather than a form buried on the dashboard. The rail
 * links here, so adding a job is reachable from anywhere — including once you
 * already have projects and the dashboard's empty state is gone.
 */
export default async function NewProjectPage() {
  const m = await requireMembership();

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <p className="page-eyebrow">{m.orgName}</p>
          <h1 className="page-title">New project</h1>
        </div>
      </header>

      <div className="panel">
        <ProjectFields />
      </div>
    </main>
  );
}
