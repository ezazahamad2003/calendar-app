import Link from "next/link";

import { requireMembership } from "@/lib/auth/dal";
import { listProjectOrder, tasksOverlapping } from "@/lib/org/queries";
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
import { clockLabel, hourWindow, minutesOf, placeSpans } from "@/lib/calendar-layout";
import { tradeColor } from "@/lib/trades";
import { projectColor, projectColors } from "@/lib/project-color";
import type { ProjectColor } from "@/lib/project-color";

/**
 * The calendar. Day / week / month / year, driven entirely by URL params so
 * every view is linkable and the back button behaves.
 *
 * Day and week are hour grids now rather than lists. A task used to be a name
 * under a date and nothing more, which is fine until two crews are on site at
 * once — the thing you most need to see is exactly the thing a list cannot
 * show. Work that carries a time window is laid out against the clock and
 * overlaps sit side by side; work that does not is an all-day bar across the
 * top, the same split every calendar people already use makes.
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

  const [tasks, projectOrder] = await Promise.all([
    tasksOverlapping(m.orgId, range.from, range.to),
    listProjectOrder(m.orgId),
  ]);
  // Colour is resolved once, here, and rides along on the task. The four views
  // below would otherwise each need the map threaded through them.
  const colors = projectColors(projectOrder);
  const withColor = (task: CalendarTask): ColoredTask => ({
    ...task,
    color:
      colors.get(task.project_id) ?? projectColor(task.project_name, task.project_color),
  });

  /** Tasks active on a given day, in a stable order. */
  const onDay = (day: string): ColoredTask[] =>
    tasks
      .filter((t) => t.start_date && t.end_date && day >= t.start_date && day <= t.end_date)
      .sort(byClockThenName)
      .map(withColor);

  // The minute the office is at right now, for the line across the day. Read
  // server-side in the org's zone: it does not tick, but it is right when the
  // page loads and it costs no client JavaScript on a phone with one bar.
  const nowMinutes = minutesInZone(m.timezone);

  const href = (v: CalView, d: string) => `/calendar?v=${v}&d=${d}`;

  return (
    <main className="page page--calendar">
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
          <Link href="/projects">Add a project</Link> to start filling it in, or
          tell Foreman what you are building.
        </p>
      ) : null}

      {view === "day" ? (
        <DayView day={anchor} today={today} tasks={onDay(anchor)} nowMinutes={nowMinutes} />
      ) : null}

      {view === "week" ? (
        <WeekView
          days={weekDays(anchor)}
          today={today}
          onDay={onDay}
          nowMinutes={nowMinutes}
        />
      ) : null}

      {view === "month" ? (
        <MonthView anchor={anchor} today={today} onDay={onDay} />
      ) : null}

      {view === "year" ? <YearView anchor={anchor} today={today} onDay={onDay} /> : null}
    </main>
  );
}

/** A calendar task with its project's colour already resolved. */
type ColoredTask = CalendarTask & { color: ProjectColor };

/** Timed work first, in clock order; then everything else by name. */
function byClockThenName(a: CalendarTask, b: CalendarTask): number {
  const at = minutesOf(a.start_time);
  const bt = minutesOf(b.start_time);
  if (at !== null && bt !== null && at !== bt) return at - bt;
  if (at !== null && bt === null) return -1;
  if (at === null && bt !== null) return 1;
  return a.name.localeCompare(b.name);
}

/** Minutes since midnight, over there, right now. */
function minutesInZone(timeZone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Some zones format midnight as "24"; normalise so the line lands at the top.
  return (hour % 24) * 60 + minute;
}

/** A task's span in minutes, or null when it runs all day. */
function spanOf(task: CalendarTask): { startMin: number; endMin: number } | null {
  const startMin = minutesOf(task.start_time);
  if (startMin === null) return null;
  // A start with no finish is drawn as an hour: long enough to hold its own
  // label, short enough not to claim time nobody said it would take.
  const endMin = minutesOf(task.end_time) ?? Math.min(startMin + 60, 24 * 60);
  return { startMin, endMin: Math.max(endMin, startMin + 15) };
}

/** "08:00 – 15:30", or null for an all-day task. */
function windowLabel(task: CalendarTask): string | null {
  if (!task.start_time) return null;
  const start = task.start_time.slice(0, 5);
  return task.end_time ? `${start} – ${task.end_time.slice(0, 5)}` : start;
}

// ── Chips and blocks ─────────────────────────────────────────────────────────

/**
 * Two colors, two questions.
 *
 * On the calendar the first question is "which job is this?", so the project
 * owns the fill. The trade keeps its own hue as a stripe down the leading edge
 * — enough to pick the electricians out of a stacked day without competing
 * with the job colour. The Gantt stays trade-first, because inside one project
 * the job is a given and the trade is the whole point.
 */
function TaskChip({ task, compact = false }: { task: ColoredTask; compact?: boolean }) {
  const trade = tradeColor(task.trade);
  const when = windowLabel(task);
  return (
    <Link
      href={`/projects/${task.project_id}`}
      className={compact ? "cal-chip" : "cal-chip cal-chip--roomy"}
      style={{
        background: task.color.fill,
        color: task.color.text,
        borderLeft: `4px solid ${trade.fill}`,
      }}
      title={`${task.name} — ${task.project_name}${when ? ` · ${when}` : ""}${
        task.trade ? ` · ${task.trade}` : ""
      }`}
    >
      {task.is_milestone ? "◆ " : ""}
      {when ? <span className="cal-chip-time">{when.slice(0, 5)}</span> : null}
      {task.name}
    </Link>
  );
}

/** A timed task drawn against the hour grid. */
function TimeBlock({
  task,
  startMin,
  endMin,
  column,
  columns,
  windowStart,
  minutesShown,
}: {
  task: ColoredTask;
  startMin: number;
  endMin: number;
  column: number;
  columns: number;
  windowStart: number;
  minutesShown: number;
}) {
  const trade = tradeColor(task.trade);
  const top = ((startMin - windowStart) / minutesShown) * 100;
  const height = ((endMin - startMin) / minutesShown) * 100;
  // A 1% gutter between columns, and none after the last one.
  const width = 100 / columns;

  return (
    <Link
      href={`/projects/${task.project_id}`}
      className={`cal-block${endMin - startMin <= 45 ? " cal-block--tight" : ""}`}
      style={{
        top: `${top}%`,
        height: `${height}%`,
        left: `${column * width}%`,
        width: `calc(${width}% - 3px)`,
        background: task.color.fill,
        color: task.color.text,
        borderLeft: `4px solid ${trade.fill}`,
      }}
      title={`${task.name} — ${task.project_name} · ${windowLabel(task)}`}
    >
      <span className="cal-block-name">
        {task.is_milestone ? "◆ " : ""}
        {task.name}
      </span>
      <span className="cal-block-when">{windowLabel(task)}</span>
      <span className="cal-block-project">{task.project_name}</span>
    </Link>
  );
}

/**
 * The hour grid itself: the scale down the left, the lines across, and one
 * column per day laid on top of them.
 *
 * The window is only as tall as the work needs (see `hourWindow`) — a grid
 * that always ran midnight to midnight would put the morning below the fold
 * to make room for hours nobody works.
 */
function HourGrid({
  days,
  today,
  timed,
  nowMinutes,
  labelDays,
}: {
  days: string[];
  today: string;
  timed: Map<string, ColoredTask[]>;
  nowMinutes: number;
  labelDays: boolean;
}) {
  const allSpans = days.flatMap((day) =>
    (timed.get(day) ?? []).map(spanOf).filter((s): s is NonNullable<typeof s> => s !== null),
  );
  const { startHour, endHour } = hourWindow(allSpans);
  const windowStart = startHour * 60;
  const minutesShown = (endHour - startHour) * 60;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

  const nowVisible =
    days.includes(today) && nowMinutes >= windowStart && nowMinutes <= endHour * 60;
  const nowTop = ((nowMinutes - windowStart) / minutesShown) * 100;

  return (
    <div
      className={`cal-grid${labelDays ? " cal-grid--headed" : ""}`}
      style={{ ["--cal-rows" as string]: String(hours.length) }}
    >
      <div className="cal-scale" aria-hidden>
        {hours.map((h) => (
          <span key={h} className="cal-scale-hour">
            <i>{clockLabel(h * 60)}</i>
          </span>
        ))}
      </div>

      {days.map((day) => {
        const placed = placeSpans(
          (timed.get(day) ?? []).flatMap((task) => {
            const span = spanOf(task);
            return span ? [{ ...span, task }] : [];
          }),
        );

        return (
          <div
            key={day}
            className={`cal-column${day === today ? " cal-column--today" : ""}`}
          >
            {labelDays ? (
              <Link className="cal-column-head" href={`/calendar?v=day&d=${day}`}>
                <span className="cal-column-dow">{dowShort(day)}</span>
                <span className="cal-column-date">{Number(day.slice(8, 10))}</span>
              </Link>
            ) : null}

            <div className="cal-column-body">
              {hours.map((h) => (
                <span key={h} className="cal-hour-line" aria-hidden />
              ))}

              {placed.map(({ task, startMin, endMin, column, columns }) => (
                <TimeBlock
                  key={task.id}
                  task={task}
                  startMin={startMin}
                  endMin={endMin}
                  column={column}
                  columns={columns}
                  windowStart={windowStart}
                  minutesShown={minutesShown}
                />
              ))}

              {day === today && nowVisible ? (
                <span
                  className="cal-now"
                  style={{ top: `${nowTop}%` }}
                  aria-label={`Now, ${clockLabel(nowMinutes)}`}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "Mon", from an ISO date, without a timezone in sight. */
function dowShort(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

/** Split a day's work into the all-day band and the hour grid. */
function splitByClock(tasks: ColoredTask[]) {
  const allDay: ColoredTask[] = [];
  const timed: ColoredTask[] = [];
  for (const task of tasks) (task.start_time ? timed : allDay).push(task);
  return { allDay, timed };
}

// ── Views ────────────────────────────────────────────────────────────────────

function DayView({
  day,
  today,
  tasks,
  nowMinutes,
}: {
  day: string;
  today: string;
  tasks: ColoredTask[];
  nowMinutes: number;
}) {
  const { allDay, timed } = splitByClock(tasks);

  return (
    <div className="cal-day-view">
      <div className="cal-allday">
        <span className="cal-allday-label">All day</span>
        <div className="cal-allday-items">
          {allDay.length === 0 ? (
            <span className="cal-allday-empty">Nothing running all day</span>
          ) : (
            allDay.map((t) => <TaskChip key={t.id} task={t} />)
          )}
        </div>
      </div>

      {timed.length === 0 ? (
        <p className="cal-note cal-note--inset">
          Nothing with a time on it. Say &ldquo;pour at 6am&rdquo; and it lands
          on the clock here.
        </p>
      ) : (
        <HourGrid
          days={[day]}
          today={today}
          timed={new Map([[day, timed]])}
          nowMinutes={nowMinutes}
          labelDays={false}
        />
      )}
    </div>
  );
}

function WeekView({
  days,
  today,
  onDay,
  nowMinutes,
}: {
  days: string[];
  today: string;
  onDay: (d: string) => ColoredTask[];
  nowMinutes: number;
}) {
  const perDay = new Map(days.map((d) => [d, onDay(d)]));
  const timed = new Map(
    days.map((d) => [d, splitByClock(perDay.get(d) ?? []).timed] as const),
  );
  const anyTimed = [...timed.values()].some((list) => list.length > 0);

  return (
    <div className="cal-week-view">
      <div className="cal-week-allday">
        <span className="cal-allday-label">All day</span>
        {days.map((day) => {
          const { allDay } = splitByClock(perDay.get(day) ?? []);
          return (
            <div
              key={day}
              className={`cal-week-allday-cell${day === today ? " cal-week-allday-cell--today" : ""}`}
            >
              {/* The date sits here rather than in the grid header when there
                  is no hour grid to head — the band is the whole week then. */}
              {!anyTimed ? (
                <Link className="cal-column-head" href={`/calendar?v=day&d=${day}`}>
                  <span className="cal-column-dow">{dowShort(day)}</span>
                  <span className="cal-column-date">{Number(day.slice(8, 10))}</span>
                </Link>
              ) : null}
              {allDay.map((t) => (
                <TaskChip key={t.id} task={t} compact />
              ))}
            </div>
          );
        })}
      </div>

      {anyTimed ? (
        <HourGrid
          days={days}
          today={today}
          timed={new Map(timed)}
          nowMinutes={nowMinutes}
          labelDays
        />
      ) : null}
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
  onDay: (d: string) => ColoredTask[];
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
            <Link className="cal-date" href={`/calendar?v=day&d=${day}`}>
              {Number(day.slice(8, 10))}
            </Link>
            {shown.map((t) => (
              <TaskChip key={`${t.id}-${day}`} task={t} compact />
            ))}
            {list.length > shown.length ? (
              <Link className="cal-more" href={`/calendar?v=day&d=${day}`}>
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
  onDay: (d: string) => ColoredTask[];
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
            <Link className="yearview-label" href={`/calendar?v=month&d=${month}-01`}>
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
                  ...new Set(onDay(day).map((t) => t.color.fill)),
                ].slice(0, 3);
                return (
                  <Link
                    key={day}
                    href={`/calendar?v=day&d=${day}`}
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
