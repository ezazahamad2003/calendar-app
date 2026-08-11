import { addCalendarDays, formatIsoDate, isoWeekday, parseIsoDate } from "@/lib/schedule";
import type { IsoDate } from "@/lib/schedule";

/**
 * Calendar geometry for the home screen's day / week / month / year views.
 *
 * Pure arithmetic on UTC-midnight anchors, same discipline as the date engine:
 * a calendar that disagrees with the schedule by a day is worse than no
 * calendar.
 */

export type CalView = "day" | "week" | "month" | "year";

export const CAL_VIEWS: readonly CalView[] = ["day", "week", "month", "year"];

export function parseView(value: string | undefined): CalView {
  return CAL_VIEWS.includes(value as CalView) ? (value as CalView) : "month";
}

export type CalRange = {
  view: CalView;
  /** The focused date. */
  anchor: IsoDate;
  /** Inclusive query bounds — covers padding days in month/year views. */
  from: IsoDate;
  to: IsoDate;
  label: string;
  prevAnchor: IsoDate;
  nextAnchor: IsoDate;
};

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const FULL_DAY = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_MONTH = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** Monday on or before `date`. Weeks start Monday: ISO, and the work week. */
export function weekStart(date: Date): Date {
  return addCalendarDays(date, -(isoWeekday(date) - 1));
}

/** The seven dates of the week containing `anchor`. */
export function weekDays(anchor: IsoDate): IsoDate[] {
  let cursor = weekStart(parseIsoDate(anchor));
  const out: IsoDate[] = [];
  for (let i = 0; i < 7; i += 1) {
    out.push(formatIsoDate(cursor));
    cursor = addCalendarDays(cursor, 1);
  }
  return out;
}

/** Monday-started weeks covering the whole month containing `anchor`. */
export function monthWeeks(anchor: IsoDate): IsoDate[][] {
  const first = parseIsoDate(`${anchor.slice(0, 7)}-01`);
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  );
  let cursor = weekStart(first);
  const weeks: IsoDate[][] = [];
  while (cursor.getTime() <= lastDay.getTime()) {
    const week: IsoDate[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(formatIsoDate(cursor));
      cursor = addCalendarDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** The twelve `YYYY-MM` months of the year containing `anchor`. */
export function yearMonths(anchor: IsoDate): string[] {
  const year = anchor.slice(0, 4);
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

/** Shift a date by whole months, clamping the day (Jan 31 → Feb 28). */
function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const d = date.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastOfTarget)));
}

export function calendarRange(view: CalView, anchor: IsoDate): CalRange {
  const date = parseIsoDate(anchor);

  switch (view) {
    case "day":
      return {
        view,
        anchor,
        from: anchor,
        to: anchor,
        label: FULL_DAY.format(date),
        prevAnchor: formatIsoDate(addCalendarDays(date, -1)),
        nextAnchor: formatIsoDate(addCalendarDays(date, 1)),
      };

    case "week": {
      const days = weekDays(anchor);
      const start = parseIsoDate(days[0]);
      const end = parseIsoDate(days[6]);
      return {
        view,
        anchor,
        from: days[0],
        to: days[6],
        label: `${DAY_MONTH.format(start)} – ${DAY_MONTH.format(end)}, ${end.getUTCFullYear()}`,
        prevAnchor: formatIsoDate(addCalendarDays(start, -7)),
        nextAnchor: formatIsoDate(addCalendarDays(start, 7)),
      };
    }

    case "year": {
      const year = date.getUTCFullYear();
      return {
        view,
        anchor,
        from: `${year}-01-01`,
        to: `${year}-12-31`,
        label: String(year),
        prevAnchor: `${year - 1}-01-01`,
        nextAnchor: `${year + 1}-01-01`,
      };
    }

    case "month":
    default: {
      const weeks = monthWeeks(anchor);
      return {
        view: "month",
        anchor,
        from: weeks[0][0],
        to: weeks[weeks.length - 1][6],
        label: MONTH_YEAR.format(parseIsoDate(`${anchor.slice(0, 7)}-01`)),
        prevAnchor: formatIsoDate(addMonths(date, -1)),
        nextAnchor: formatIsoDate(addMonths(date, 1)),
      };
    }
  }
}

/** `YYYY-MM-DD` validator for the `d` query param. */
export function parseAnchor(value: string | undefined, fallback: IsoDate): IsoDate {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  try {
    parseIsoDate(value);
    return value;
  } catch {
    return fallback;
  }
}
