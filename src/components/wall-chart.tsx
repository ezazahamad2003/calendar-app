import { statusLabel, statusMark } from "@/lib/chart";
import type { Chart } from "@/lib/chart";
import { colorFor } from "@/lib/team-color";
import type { TeamColor } from "@/lib/team-color";
import { humanDay } from "@/lib/format-date";
import type { TaskStatus } from "@/lib/store/types";

/**
 * The chart, as it hangs on the trailer wall.
 *
 * A server component: it is a projection of the document with no state of its
 * own, so there is nothing here worth shipping to the browser. Everything
 * interactive lives in the assistant panel.
 */

function barClass(status: TaskStatus): string {
  switch (status) {
    case "confirmed":
      return "bar-confirmed";
    case "tentative":
      return "bar-tentative";
    case "done":
      return "bar-done";
    case "blocked":
      return "bar-blocked";
    case "planned":
      return "bar-planned";
  }
}

export function WallChart({
  chart,
  colors,
}: {
  chart: Chart;
  colors: ReadonlyMap<string, TeamColor>;
}) {
  const todayIndex = chart.days.findIndex((d) => d.isToday);

  return (
    <div className="chart-wrap only-wide">
      <div
        className="chart"
        style={{ ["--days" as string]: String(chart.days.length) }}
      >
        {/* Today's rule, drawn once over the whole chart rather than per row. */}
        {todayIndex >= 0 && (
          <div
            className="today-line"
            aria-hidden="true"
            style={{
              left: `calc(var(--rail-w) + ${todayIndex} * var(--day-w) + var(--day-w) / 2)`,
            }}
          />
        )}

        {/* Month banner */}
        <div className="ch ch-rail team" style={{ gridRow: 1 }} />
        <div className="ch ch-rail activity" style={{ gridRow: 1 }} />
        {chart.days.map((day) =>
          day.monthLabel ? (
            <div
              key={`m-${day.date}`}
              className="ch ch-month"
              style={{ gridRow: 1, gridColumn: `span ${day.monthSpan}` }}
            >
              {day.monthLabel}
            </div>
          ) : null,
        )}

        {/* Weekday + day number */}
        <div className="ch ch-rail team" style={{ gridRow: 2 }}>
          Team
        </div>
        <div className="ch ch-rail activity" style={{ gridRow: 2 }}>
          Activity
        </div>
        {chart.days.map((day, i) => (
          <div
            key={`d-${day.date}`}
            className={[
              "ch",
              "ch-day",
              day.off ? "off" : "",
              day.isToday ? "today" : "",
              day.weekday === 1 && i > 0 ? "week-start" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ gridRow: 2 }}
          >
            <div className="dow">{day.initial}</div>
            <div className="dom">{day.dayOfMonth}</div>
          </div>
        ))}

        {/* Sections and rows */}
        {chart.sections.map((section) => (
          <Section
            key={section.section.id}
            name={section.section.name}
            rows={section.rows}
            days={chart.days}
            colors={colors}
          />
        ))}
      </div>
    </div>
  );
}

function Section({
  name,
  rows,
  days,
  colors,
}: {
  name: string;
  rows: Chart["sections"][number]["rows"];
  days: Chart["days"];
  colors: ReadonlyMap<string, TeamColor>;
}) {
  return (
    <>
      <div className="section-row">{name}</div>
      {rows.map((row, index) => {
        const color = colorFor(colors, row.task.team);
        const alt = index % 2 === 1;
        const mark = statusMark(row.task.status);

        return (
          <div
            key={row.task.id}
            className={`${alt ? "row-alt" : ""} ${row.task.status === "done" ? "row-done" : ""}`}
            style={{ display: "contents" }}
          >
            <div className="rail rail-team">
              <span
                className="team-chip"
                style={{ background: color.fill }}
                aria-hidden="true"
              />
              <span className="team-name">{row.task.team ?? "—"}</span>
            </div>
            <div className="rail rail-activity">
              <span className="activity-name" title={row.task.name}>
                {row.task.name}
              </span>
            </div>

            {days.map((day, i) => {
              const isBarStart = row.bar?.startIndex === i;
              return (
                <div
                  key={day.date}
                  className={[
                    "cell",
                    day.off ? "off" : "",
                    day.weekday === 1 && i > 0 ? "week-start" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {isBarStart && row.bar && (
                    <div
                      className={[
                        "bar",
                        barClass(row.task.status),
                        row.bar.continuesLeft ? "cont-left" : "",
                        row.bar.continuesRight ? "cont-right" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{
                        ["--bar-fill" as string]: color.fill,
                        background:
                          row.task.status === "confirmed" ? color.fill : undefined,
                        // Reach across the following cells. `inset` handles the
                        // 1px inner gutters so bars never touch.
                        width: `calc(${row.bar.span} * var(--day-w) - 2px)`,
                      }}
                      title={`${row.task.name} — ${statusLabel(row.task.status)}, ${
                        row.bar.workDays
                      } work day${row.bar.workDays === 1 ? "" : "s"}${
                        row.endDate ? ` to ${humanDay(row.endDate)}` : ""
                      }`}
                    >
                      {mark && <span className="mark">{mark}</span>}
                      {row.bar.span > 3 && (
                        <span className="len">{row.bar.workDays}d</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/** Wide screens only — the phone reads status from a labelled pill instead. */
export function ChartLegend() {
  return (
    <div className="legend only-wide">
      <span>
        <i style={{ background: "var(--booked)" }} />
        Booked
      </span>
      <span>
        <i
          style={{
            border: "1px dashed var(--pencil)",
            background:
              "repeating-linear-gradient(-45deg, color-mix(in srgb, var(--pencil) 22%, transparent) 0 5px, transparent 5px 10px)",
          }}
        />
        Pencilled in
      </span>
      <span>
        <i
          style={{
            background: "color-mix(in srgb, var(--done) 28%, var(--paper))",
            border: "1px solid color-mix(in srgb, var(--done) 45%, transparent)",
          }}
        />
        Done
      </span>
      <span>
        <i style={{ background: "var(--mark)", width: 3 }} />
        Today
      </span>
      <span>
        <i style={{ background: "var(--sheet-off)" }} />
        Weekend
      </span>
    </div>
  );
}
