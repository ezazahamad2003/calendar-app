import { addCalendarDays, formatIsoDate, isoWeekday, parseIsoDate } from "@/lib/schedule";
import type { IsoDate } from "@/lib/schedule";

/**
 * Month-grid geometry shared by the calendar page and the dashboard rail.
 * Pure date arithmetic on UTC anchors — same discipline as the engine.
 */

export type MonthGrid = {
  /** `YYYY-MM`. */
  month: string;
  label: string;
  /** Monday-started weeks; every cell is a date, padding comes from adjacent months. */
  weeks: IsoDate[][];
  firstDay: IsoDate;
  lastDay: IsoDate;
  prevMonth: string;
  nextMonth: string;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthGrid(month: string): MonthGrid {
  if (!MONTH_RE.test(month)) throw new Error(`Not a YYYY-MM month: "${month}"`);
  const first = parseIsoDate(`${month}-01`);

  const year = first.getUTCFullYear();
  const monthIndex = first.getUTCMonth();
  const lastDate = new Date(Date.UTC(year, monthIndex + 1, 0));

  // Walk back to the Monday on or before the 1st.
  let cursor = addCalendarDays(first, -(isoWeekday(first) - 1));
  const weeks: IsoDate[][] = [];
  // 4–6 rows depending on the month; loop until the week starts after month end.
  while (cursor.getTime() <= lastDate.getTime()) {
    const week: IsoDate[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(formatIsoDate(cursor));
      cursor = addCalendarDays(cursor, 1);
    }
    weeks.push(week);
  }

  const prev = new Date(Date.UTC(year, monthIndex - 1, 1));
  const next = new Date(Date.UTC(year, monthIndex + 1, 1));
  const monthOf = (d: Date) => formatIsoDate(d).slice(0, 7);

  return {
    month,
    label: new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(first),
    weeks,
    firstDay: weeks[0][0],
    lastDay: weeks[weeks.length - 1][6],
    prevMonth: monthOf(prev),
    nextMonth: monthOf(next),
  };
}
