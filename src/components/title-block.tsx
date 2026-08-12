import Link from "next/link";

import type { ProjectMeta } from "@/lib/store/types";

/**
 * The title block, as a drawing set has in its corner: what this is, who it is
 * for, and what you are looking at.
 */
export function TitleBlock({
  project,
  current,
  readOnly = false,
}: {
  project: ProjectMeta;
  current: "chart" | "crew" | "history" | "share";
  readOnly?: boolean;
}) {
  return (
    <header className="titleblock">
      <div style={{ minWidth: 0 }}>
        <h1>{project.name}</h1>
        {project.client && <div className="client">{project.client}</div>}
      </div>

      {readOnly ? (
        <div className="label" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
          Read only
        </div>
      ) : (
        <nav aria-label="Sections">
          <Link className="tab" href="/" aria-current={current === "chart" ? "page" : undefined}>
            Chart
          </Link>
          <Link
            className="tab"
            href="/crew"
            aria-current={current === "crew" ? "page" : undefined}
          >
            Crew
          </Link>
          <Link
            className="tab"
            href="/history"
            aria-current={current === "history" ? "page" : undefined}
          >
            History
          </Link>
        </nav>
      )}
    </header>
  );
}
