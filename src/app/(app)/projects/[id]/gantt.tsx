"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { moveTask } from "@/lib/org/actions";
import { addCalendarDays, formatIsoDate, parseIsoDate } from "@/lib/schedule";

/**
 * The board. Server computes all geometry (offsets in calendar days from a
 * fixed origin); this component turns pointer movement into a new start date
 * and hands it to the `moveTask` action, which runs the cascade and applies
 * atomically.
 *
 * Optimistic with rollback (SPEC §7): the dragged bar stays where it was
 * dropped while the server round-trips; on failure it snaps back and the
 * error is announced.
 */

export type GanttTask = {
  id: string;
  name: string;
  trade: string | null;
  status: "planned" | "active" | "blocked" | "done";
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  isMilestone: boolean;
  /** Calendar days from the timeline origin; null = unscheduled. */
  offset: number | null;
  span: number;
  fill: string;
  text: string;
  critical: boolean;
  assignees: string[];
};

export type GanttDep = { from: string; to: string };

const ROW_H = 44;
const HEADER_H = 28;

export function Gantt({
  projectId,
  tasks,
  deps,
  totalDays,
  dayWidth,
  originIso,
  todayOffset,
  workingMask,
  monthTicks,
}: {
  projectId: string;
  tasks: GanttTask[];
  deps: GanttDep[];
  totalDays: number;
  dayWidth: number;
  originIso: string;
  todayOffset: number;
  workingMask: boolean[];
  monthTicks: { offset: number; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  /** Optimistic per-task day delta while a drag is in flight. */
  const [shift, setShift] = useState<Record<string, number>>({});
  const drag = useRef<{ id: string; startX: number; delta: number } | null>(null);

  const scheduled = tasks.filter((t) => t.offset !== null);
  const rowOf = new Map(scheduled.map((t, i) => [t.id, i]));
  const width = totalDays * dayWidth;
  const height = HEADER_H + scheduled.length * ROW_H;

  function onPointerDown(e: React.PointerEvent, task: GanttTask) {
    if (task.offset === null || pending) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: task.id, startX: e.clientX, delta: 0 };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const delta = Math.round((e.clientX - d.startX) / dayWidth);
    if (delta !== d.delta) {
      d.delta = delta;
      setShift((s) => ({ ...s, [d.id]: delta }));
    }
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const task = tasks.find((t) => t.id === d.id);
    if (!task || !task.startDate || d.delta === 0) {
      setShift((s) => ({ ...s, ...(d ? { [d.id]: 0 } : {}) }));
      return;
    }

    const newStart = formatIsoDate(
      addCalendarDays(parseIsoDate(task.startDate), d.delta),
    );

    startTransition(async () => {
      const result = await moveTask({
        project_id: projectId,
        task_id: task.id,
        start_date: newStart,
      });
      if (result.error) {
        // Rollback: snap the bar home and say why.
        setShift((s) => ({ ...s, [task.id]: 0 }));
        setNotice(result.error);
      } else {
        setNotice(
          result.moved && result.moved > 1
            ? `Moved ${task.name} and ${result.moved - 1} downstream task${result.moved - 1 === 1 ? "" : "s"}.`
            : `Moved ${task.name}.`,
        );
        setShift({});
        router.refresh();
      }
    });
  }

  return (
    <section className="gantt" aria-label="Schedule">
      <div className="gantt-scroll">
        <div className="gantt-names" style={{ paddingTop: HEADER_H }}>
          {scheduled.map((t) => (
            <div key={t.id} className="gantt-name" style={{ height: ROW_H }}>
              <span className="gantt-name-text">{t.name}</span>
              {t.assignees.length > 0 ? (
                <span className="gantt-name-who">{t.assignees.join(", ")}</span>
              ) : null}
            </div>
          ))}
        </div>

        <div
          className="gantt-board"
          style={{ width, height }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {/* Non-working day shading — only at zooms where a day is visible. */}
          {dayWidth >= 10 &&
            workingMask.map((working, i) =>
              working ? null : (
                <i
                  key={i}
                  className="gantt-offday"
                  style={{ left: i * dayWidth, width: dayWidth, height }}
                />
              ),
            )}

          {monthTicks.map((tick) => (
            <span
              key={tick.offset}
              className="gantt-month"
              style={{ left: tick.offset * dayWidth }}
            >
              {tick.label}
            </span>
          ))}

          {/* Today. */}
          {todayOffset >= 0 && todayOffset < totalDays ? (
            <i
              className="gantt-today"
              style={{ left: todayOffset * dayWidth + dayWidth / 2, height }}
              aria-hidden
            />
          ) : null}

          {/* Dependency connectors. */}
          {dayWidth >= 10 ? (
            <svg className="gantt-arrows" width={width} height={height} aria-hidden>
              {deps.map((dep, i) => {
                const from = tasks.find((t) => t.id === dep.from);
                const to = tasks.find((t) => t.id === dep.to);
                if (!from || !to || from.offset === null || to.offset === null) return null;
                const fromRow = rowOf.get(from.id);
                const toRow = rowOf.get(to.id);
                if (fromRow === undefined || toRow === undefined) return null;
                const x1 = (from.offset + (shift[from.id] ?? 0) + from.span) * dayWidth;
                const y1 = HEADER_H + fromRow * ROW_H + ROW_H / 2;
                const x2 = (to.offset + (shift[to.id] ?? 0)) * dayWidth;
                const y2 = HEADER_H + toRow * ROW_H + ROW_H / 2;
                const bend = Math.max(x1 + dayWidth / 2, x2 - dayWidth / 2);
                return (
                  <path
                    key={i}
                    className="gantt-arrow"
                    d={`M ${x1} ${y1} H ${bend} V ${y2} H ${x2}`}
                  />
                );
              })}
            </svg>
          ) : null}

          {/* Bars. */}
          {scheduled.map((t, row) => {
            const left = ((t.offset as number) + (shift[t.id] ?? 0)) * dayWidth;
            const top = HEADER_H + row * ROW_H + 8;
            if (t.isMilestone) {
              return (
                <button
                  key={t.id}
                  type="button"
                  className="gantt-milestone"
                  style={{ left: left + dayWidth / 2, top: top + 4 }}
                  onPointerDown={(e) => onPointerDown(e, t)}
                  title={`${t.name} — ${t.startDate}`}
                  aria-label={`Milestone ${t.name}, ${t.startDate}. Drag to move.`}
                />
              );
            }
            return (
              <button
                key={t.id}
                type="button"
                className={[
                  "gantt-bar",
                  t.critical ? "gantt-bar--critical" : "",
                  t.status === "done" ? "gantt-bar--done" : "",
                  t.status === "blocked" ? "gantt-bar--blocked" : "",
                ].join(" ")}
                style={{
                  left,
                  top,
                  width: Math.max(t.span * dayWidth - 2, dayWidth - 2),
                  background: t.fill,
                  color: t.text,
                }}
                onPointerDown={(e) => onPointerDown(e, t)}
                title={`${t.name} — ${t.startDate} → ${t.endDate}${t.critical ? " (critical path)" : ""}`}
                aria-label={`${t.name}, ${t.startDate} to ${t.endDate}, ${t.durationDays} work days. Drag to move.`}
              >
                {dayWidth * t.span > 70 ? (
                  <span className="gantt-bar-label">{t.name}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <p className="gantt-hint">
        Drag a bar to move it — dependent tasks follow. Timeline starts {originIso}.
      </p>
      <div aria-live="polite" className="gantt-notice">
        {pending ? "Saving move…" : notice}
      </div>
    </section>
  );
}
