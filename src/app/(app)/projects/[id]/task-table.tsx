"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { assignTask, moveTask, resizeTask, setTaskStatus } from "@/lib/org/actions";
import type { GanttTask } from "./gantt";

const STATUSES = ["planned", "active", "blocked", "done"] as const;

/**
 * The precise-input counterpart to the Gantt's dragging: exact dates, exact
 * durations, status and assignment. Same server actions, so the cascade and
 * audit trail apply identically whichever surface the change comes from.
 */
export function TaskTable({
  projectId,
  tasks,
  contacts,
}: {
  projectId: string;
  tasks: GanttTask[];
  contacts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  function run(fn: () => Promise<{ error?: string; moved?: number }>) {
    startTransition(async () => {
      const result = await fn();
      setNotice(result.error ?? null);
      if (!result.error) router.refresh();
    });
  }

  if (tasks.length === 0) return null;

  return (
    <section className="tasklist" aria-label="Task list">
      <table className="tasklist-table">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Trade</th>
            <th scope="col">Starts</th>
            <th scope="col">Days</th>
            <th scope="col">Status</th>
            <th scope="col">Assigned</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            // Key includes the editable values, not just the id: these inputs
            // are uncontrolled (defaultValue), and after a cascade the server
            // sends new dates that React will NOT push into an existing input.
            // A changed key remounts the row, so the fresh values render.
            <tr
              key={`${t.id}:${t.startDate}:${t.durationDays}:${t.status}`}
              className={t.status === "done" ? "tasklist-row--done" : ""}
            >
              <td>
                {t.isMilestone ? "◆ " : ""}
                {t.name}
                {t.critical ? <span className="tag-critical"> critical</span> : null}
              </td>
              <td>{t.trade ?? "—"}</td>
              <td>
                <input
                  className="cell-input"
                  type="date"
                  defaultValue={t.startDate ?? ""}
                  aria-label={`Start date for ${t.name}`}
                  disabled={pending}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    run(() =>
                      moveTask({
                        project_id: projectId,
                        task_id: t.id,
                        start_date: e.target.value,
                      }),
                    );
                  }}
                />
              </td>
              <td>
                {t.isMilestone ? (
                  "—"
                ) : (
                  <input
                    className="cell-input cell-input--num"
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={t.durationDays}
                    aria-label={`Duration in work days for ${t.name}`}
                    disabled={pending}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isInteger(v) || v < 1) return;
                      run(() =>
                        resizeTask({
                          project_id: projectId,
                          task_id: t.id,
                          duration_days: v,
                        }),
                      );
                    }}
                  />
                )}
              </td>
              <td>
                <select
                  className="cell-input"
                  defaultValue={t.status}
                  aria-label={`Status of ${t.name}`}
                  disabled={pending}
                  onChange={(e) =>
                    run(() =>
                      setTaskStatus({
                        project_id: projectId,
                        task_id: t.id,
                        status: e.target.value as (typeof STATUSES)[number],
                      }),
                    )
                  }
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {t.assignees.length > 0 ? (
                  <span className="cell-who">{t.assignees.join(", ")}</span>
                ) : null}
                <select
                  className="cell-input"
                  defaultValue=""
                  aria-label={`Assign ${t.name}`}
                  disabled={pending || contacts.length === 0}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    const contactId = e.target.value;
                    e.target.value = "";
                    run(() =>
                      assignTask({
                        project_id: projectId,
                        task_id: t.id,
                        contact_id: contactId,
                      }),
                    );
                  }}
                >
                  <option value="">
                    {contacts.length === 0 ? "Add crew first" : "+ assign"}
                  </option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div aria-live="polite" className="gantt-notice">
        {pending ? "Saving…" : notice}
      </div>
    </section>
  );
}
