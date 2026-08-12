import Link from "next/link";

import { buildAgenda, buildChart, defaultWindow, undatedTasks, weekStart } from "@/lib/chart";
import { humanDay } from "@/lib/format-date";
import { addCalendarDays, formatIsoDate, parseIsoDate } from "@/lib/schedule";
import type { ScheduleDoc } from "@/lib/store/types";
import { teamColors } from "@/lib/team-color";
import { Agenda, UndatedList } from "./agenda";
import { ChartLegend, WallChart } from "./wall-chart";

/**
 * The chart and its phone equivalent, plus paging.
 *
 * Both layouts are rendered and one is hidden by a media query rather than
 * chosen in JavaScript. Thirty-five rows is small enough that the duplicated
 * markup costs nothing, and it means the correct layout is in the very first
 * paint — no flash of the wrong one on a slow connection, which is the one
 * network condition this app is guaranteed to meet.
 */

/** Nine weeks, the span the client's own printed chart covers. */
const WEEKS = 9;

export function ChartView({
  doc,
  from,
  basePath = "",
}: {
  doc: ScheduleDoc;
  /** Monday to anchor on. Defaults to the current week. */
  from?: string;
  /** "" for the owner, "/s/<token>" for the shared link. */
  basePath?: string;
}) {
  const fallback = defaultWindow(doc, WEEKS);
  const start = from ? weekStart(from) : fallback.from;
  const to = formatIsoDate(addCalendarDays(parseIsoDate(start), WEEKS * 7 - 1));
  const window = { from: start, to };

  const chart = buildChart(doc, window);
  const agenda = buildAgenda(doc, window);
  const colors = teamColors(doc);
  const undated = undatedTasks(doc);

  const shift = (weeks: number) =>
    formatIsoDate(addCalendarDays(parseIsoDate(start), weeks * 7));

  const root = basePath || "/";
  const href = (date: string) =>
    date === fallback.from ? root : `${root}${root.endsWith("/") ? "" : "/"}?from=${date}`;

  return (
    <>
      <div className="chart-nav">
        <Link className="btn" href={href(shift(-3))} scroll={false}>
          ‹ Back
        </Link>
        <Link className="btn" href={href(shift(3))} scroll={false}>
          On ›
        </Link>
        {start !== fallback.from && (
          <Link className="btn btn-ghost" href={href(fallback.from)} scroll={false}>
            Today
          </Link>
        )}
        <span className="range num">
          {humanDay(window.from)} — {humanDay(window.to)}
        </span>
      </div>

      <WallChart chart={chart} colors={colors} />
      <ChartLegend />
      <UndatedList tasks={undated} colors={colors} />

      <Agenda days={agenda} colors={colors} today={chart.today} undated={undated} />
    </>
  );
}
