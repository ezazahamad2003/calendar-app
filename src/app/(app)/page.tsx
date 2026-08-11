import Link from "next/link";

import { requireMembership } from "@/lib/auth/dal";
import { tasksOverlapping } from "@/lib/org/queries";
import type { CalendarTask } from "@/lib/org/queries";
import { todayInZone } from "@/lib/schedule";
import {
  CAL_VIEWS,
  calendarRange,
  monthWeeks,
  parseAnchor,
  parseView,
  weekDays,
  yearMonths,
} from "@/lib/calendar";
import type { CalView } from "@/lib/calendar";
import { tradeColor } from "@/lib/trades";
import { projectColor } from "@/lib/project-color";

/**
 * The calendar is the home screen (SPEC §7 wants the schedule front and
 * centre). Day / week / month / year, driven entirely by URL params so every
 * view is linkable and the back button behaves.
 *
 * Server-rendered: switching views is a navigation, not client state, which
 * keeps the whole thing working on a bad jobsite connection.
 */
export default async function CalendarHome({
  searchParams,
}: {
  searchParams: Promise<{ v?: string; d?: string; ms_error?: string; ms_connected?: string }>;
}) {
  const params = await searchParams;
  const m = await requireMembership();

  const today = todayInZone(m.timezone);
  const view: CalView = parseView(params.v);
  const anchor = parseAnchor(params.d, today);
  const range = calendarRange(view, anchor);

  const tasks = await tasksOverlapping(m.orgId, range.from, range.to);

  /** Tasks active on a given day, in a stable order. */
  const onDay = (day: string): CalendarTask[] =>
    tasks
      .filter((t) => t.start_date && t.end_date && day >= t.start_date && day <= t.end_date)
      .sort((a, b) => a.name.localeCompare(b.name));

  const href = (v: CalView, d: string) => `/?v=${v}&d=${d}`;

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <p className="page-eyebrow">{m.orgName}</p>
          <h1 className="page-title">{range.label}</h1>
        </div>

        <div className="cal-controls">
          <nav className="zoom" aria-label="Calendar view">
            {CAL_VIEWS.map((v) => (
              <Link
                key={v}
                href={href(v, anchor)}
                className={`zoom-link${view === v ? " zoom-link--on" : ""}`}
                aria-current={view === v ? "page" : undefined}
              >
                {v}
              </Link>
            ))}
          </nav>
          <nav className="zoom" aria-label="Move through time">
            <Link className="zoom-link" href={href(view, range.prevAnchor)} aria-label="Previous">
              ←
            </Link>
            <Link className="zoom-link" href={href(view, today)}>
              today
            </Link>
            <Link className="zoom-link" href={href(view, range.nextAnchor)} aria-label="Next">
              →
            </Link>
          </nav>
        </div>
      </header>

      {params.ms_error ? (
        <p className="form-error" role="alert">
          {params.ms_error}
        </p>
      ) : null}
      {params.ms_connected ? (
        <p className="auth-notice">
          Outlook connected. Messages in the outbox now send for real.
        </p>
      ) : null}

      {tasks.length === 0 ? (
        <p className="cal-note">
          Nothing scheduled in this {view === "day" ? "day" : view}.{" "}
          <Link href="/projects">Add a project</Link> to start filling it in.
        </p>
      ) : null}

      {view === "day" ? <DayView tasks={onDay(anchor)} /> : null}

      {view === "week" ? (
        <WeekView days={weekDays(anchor)} today={today} onDay={onDay} />
      ) : null}

      {view === "month" ? (
        <MonthView anchor={anchor} today={today} onDay={onDay} />
      ) : null}

      {view === "year" ? <YearView anchor={anchor} today={today} onDay={onDay} /> : null}
    </main>
  );
}

// ── Views ────────────────────────────────────────────────────────────────────

/**
 * Two colors, two questions.
 *
 * On the calendar the first question is "which job is this?", so the project
 * owns the fill. The trade keeps its own hue as a stripe down the leading edge
 * — enough to pick the electricians out of a stacked day without competing
 * with the job colour. The Gantt stays trade-first, because inside one project
 * the job is a given and the trade is the whole point.
 */
function TaskChip({ task, compact = false }: { task: CalendarTask; compact?: boolean }) {
  const project = projectColor(task.project_name, task.project_color);
  const trade = tradeColor(task.trade);
  return (
    <Link
      href={`/projects/${task.project_id}`}
      className={compact ? "cal-chip" : "cal-chip cal-chip--roomy"}
      style={{
        background: project.fill,
        color: project.text,
        borderLeft: `4px solid ${trade.fill}`,
      }}
      title={`${task.name} — ${task.project_name}${task.trade ? ` · ${task.trade}` : ""}`}
    >
      {task.is_milestone ? "◆ " : ""}
      {task.name}
    </Link>
  );
}

function DayView({ tasks }: { tasks: CalendarTask[] }) {
  if (tasks.length === 0) return null;

  // Grouped by project: on a single day, "which jobs need me" is the question.
  const byProject = new Map<string, CalendarTask[]>();
  for (const t of tasks) {
    const list = byProject.get(t.project_name);
    if (list) list.push(t);
    else byProject.set(t.project_name, [t]);
  }

  return (
    <div className="dayview">
      {[...byProject.entries()].map(([project, list]) => (
        <section key={project} className="dayview-group">
          <h2 className="dayview-project">{project}</h2>
          <ul className="dayview-list">
            {list.map((t) => (
              <li key={t.id}>
                <TaskChip task={t} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function WeekView({
  days,
  today,
  onDay,
}: {
  days: string[];
  today: string;
  onDay: (d: string) => CalendarTask[];
}) {
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="cal cal--week">
      {DOW.map((d) => (
        <span key={d} className="cal-dow">
          {d}
        </span>
      ))}
      {days.map((day) => (
        <div
          key={day}
          className={`cal-day cal-day--tall${day === today ? " cal-day--today" : ""}`}
        >
          <span className="cal-date">{Number(day.slice(8, 10))}</span>
          {onDay(day).map((t) => (
            <TaskChip key={`${t.id}-${day}`} task={t} />
          ))}
        </div>
      ))}
    </div>
  );
}

function MonthView({
  anchor,
  today,
  onDay,
}: {
  anchor: string;
  today: string;
  onDay: (d: string) => CalendarTask[];
}) {
  const weeks = monthWeeks(anchor);
  const month = anchor.slice(0, 7);
  return (
    <div className="cal">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
        <span key={d} className="cal-dow">
          {d}
        </span>
      ))}
      {weeks.flat().map((day) => {
        const list = onDay(day);
        const shown = list.slice(0, 3);
        return (
          <div
            key={day}
            className={[
              "cal-day",
              day.slice(0, 7) === month ? "" : "cal-day--out",
              day === today ? "cal-day--today" : "",
            ].join(" ")}
          >
            <span className="cal-date">{Number(day.slice(8, 10))}</span>
            {shown.map((t) => (
              <TaskChip key={`${t.id}-${day}`} task={t} compact />
            ))}
            {list.length > shown.length ? (
              <Link className="cal-more" href={`/?v=day&d=${day}`}>
                +{list.length - shown.length} more
              </Link>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function YearView({
  anchor,
  today,
  onDay,
}: {
  anchor: string;
  today: string;
  onDay: (d: string) => CalendarTask[];
}) {
  return (
    <div className="yearview">
      {yearMonths(anchor).map((month) => {
        const weeks = monthWeeks(`${month}-01`);
        const label = new Intl.DateTimeFormat("en-US", {
          month: "long",
          timeZone: "UTC",
        }).format(new Date(`${month}-01T00:00:00Z`));
        return (
          <section key={month} className="yearview-month">
            <Link className="yearview-label" href={`/?v=month&d=${month}-01`}>
              {label}
            </Link>
            <div className="yearview-grid">
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <span key={`h${i}`} className="yearview-dow">
                  {d}
                </span>
              ))}
              {weeks.flat().map((day) => {
                const inMonth = day.slice(0, 7) === month;
                // Up to three colours per day — enough to read density and
                // job mix at a glance without becoming mush. Projects rather
                // than trades: at a year's zoom "which jobs are running" is
                // the only question a dot this small can answer.
                const colors = [
                  ...new Set(
                    onDay(day).map(
                      (t) => projectColor(t.project_name, t.project_color).fill,
                    ),
                  ),
                ].slice(0, 3);
                return (
                  <Link
                    key={day}
                    href={`/?v=day&d=${day}`}
                    className={[
                      "yearview-day",
                      inMonth ? "" : "yearview-day--out",
                      day === today ? "yearview-day--today" : "",
                    ].join(" ")}
                    aria-label={day}
                  >
                    {Number(day.slice(8, 10))}
                    <span className="yearview-dots">
                      {colors.map((fill, i) => (
                        <i key={i} style={{ background: fill }} />
                      ))}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
