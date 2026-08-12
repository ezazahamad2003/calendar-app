import { statusLabel } from "@/lib/chart";
import type { AgendaDay } from "@/lib/chart";
import { humanDay } from "@/lib/format-date";
import { colorFor } from "@/lib/team-color";
import type { TeamColor } from "@/lib/team-color";
import type { Activity } from "@/lib/store/types";

/**
 * The phone's view: days, not a grid.
 *
 * On site the question is never "what shape is this job" — it is "who is
 * supposed to be here today, and what is coming tomorrow". So the small screen
 * gets a list of days with crews under each, and the grid is not shown at all
 * rather than shrunk into something nobody can read.
 */

function relativeLabel(date: string, today: string): string | null {
  if (date === today) return "Today";
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 7) return `In ${days} days`;
  return null;
}

export function Agenda({
  days,
  colors,
  today,
  undated,
}: {
  days: AgendaDay[];
  colors: ReadonlyMap<string, TeamColor>;
  today: string;
  undated: Activity[];
}) {
  return (
    <div className="only-narrow">
      {days.length === 0 && (
        <div className="note">
          Nothing is booked in this stretch. Everything with a date sits outside
          it — page back or forward, or check the list of activities with no date
          yet.
        </div>
      )}

      {days.map((day) => {
        const rel = relativeLabel(day.date, today);
        return (
          <section
            key={day.date}
            className={`agenda-day ${day.isToday ? "is-today" : ""}`}
          >
            <h3 className="agenda-head">
              {humanDay(day.date)}
              {rel && <span className="rel">{rel}</span>}
            </h3>
            {day.entries.map((entry) => {
              const color = colorFor(colors, entry.task.team);
              return (
                <div key={entry.task.id} className="agenda-item">
                  <span
                    className="swatch"
                    style={{ background: color.fill }}
                    aria-hidden="true"
                  />
                  <div className="body">
                    <div className="name">{entry.task.name}</div>
                    <div className="meta">
                      {entry.task.team ?? "No team"}
                      {entry.totalWorkDays > 1 && (
                        <>
                          {" · "}
                          day {entry.dayNumber} of {entry.totalWorkDays}
                        </>
                      )}
                    </div>
                  </div>
                  <span className={`pill pill-${entry.task.status}`}>
                    {statusLabel(entry.task.status)}
                  </span>
                </div>
              );
            })}
          </section>
        );
      })}

      {undated.length > 0 && (
        <section className="agenda-day" style={{ marginTop: 10 }}>
          <h3 className="agenda-head">
            No date yet<span className="rel">{undated.length}</span>
          </h3>
          {undated.map((task) => (
            <div key={task.id} className="agenda-item">
              <span
                className="swatch"
                style={{ background: colorFor(colors, task.team).fill }}
                aria-hidden="true"
              />
              <div className="body">
                <div className="name">{task.name}</div>
                <div className="meta">{task.team ?? "No team"}</div>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** The same backlog, beside the chart on a wide screen. */
export function UndatedList({
  tasks,
  colors,
}: {
  tasks: Activity[];
  colors: ReadonlyMap<string, TeamColor>;
}) {
  if (tasks.length === 0) return null;

  return (
    <div className="card only-wide" style={{ marginTop: 14 }}>
      <h2>No date yet · {tasks.length}</h2>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
        Real work, nobody booked. These move onto the chart the moment you give
        them a date.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {tasks.map((task) => (
          <span
            key={task.id}
            className="no-date"
            style={{ borderLeft: `3px solid ${colorFor(colors, task.team).fill}` }}
          >
            {task.name}
            {task.team && <span style={{ opacity: 0.7 }}>· {task.team}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
