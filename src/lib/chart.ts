import {
  addCalendarDays,
  finishIsoDate,
  formatIsoDate,
  isWorkingDay,
  isoWeekday,
  parseIsoDate,
  todayInZone,
} from "@/lib/schedule";
import type { IsoDate, WorkCalendar } from "@/lib/schedule";
import type { Activity, ScheduleDoc, Section, TaskStatus } from "@/lib/store/types";

/**
 * The wall chart, as a value.
 *
 * The client's whole schedule lives on a printed grid: activities down the
 * left with the responsible trade beside each, days across the top, and a mark
 * in a cell for every day a crew is expected. This turns the document into
 * exactly that grid, and nothing here knows about React — which is what lets
 * the layout be tested, and lets the phone render a different shape from the
 * same numbers.
 *
 * Rendering rules that came straight off the paper:
 *
 *   · Weekends are shaded and still occupy a column. Dropping them would make
 *     "Friday and Monday" look adjacent, and the gap is information — it is
 *     why a two-day job spans four days.
 *   · An activity with no dates keeps its row. Half the chart is undated work
 *     waiting on a sub, and it is the part the contractor scans for what to
 *     chase.
 *   · Sections are banners across the full width, not a column.
 */

export const WEEKDAY_INITIALS = ["M", "T", "W", "TH", "F", "S", "S"] as const;

const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
] as const;

export type ChartDay = {
  date: IsoDate;
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** "M", "T", "W", "TH", "F", "S", "S" — the chart's own abbreviations. */
  initial: string;
  /** Day of the month, the number printed in the header. */
  dayOfMonth: number;
  /** Shaded. True for non-working days, holidays included. */
  off: boolean;
  isToday: boolean;
  /** Set on the first column of each month, for the banner row. */
  monthLabel: string | null;
  /** How many columns that banner spans. */
  monthSpan: number;
};

export type ChartBar = {
  /** Index into `days` where the bar starts. */
  startIndex: number;
  /** Columns covered, weekend columns included. */
  span: number;
  /** Working days actually worked inside that span. */
  workDays: number;
  /** True when the activity runs past the right-hand edge of the window. */
  continuesRight: boolean;
  /** True when it began before the left-hand edge. */
  continuesLeft: boolean;
};

export type ChartRow = {
  task: Activity;
  /** Null for an undated activity, or one entirely outside the window. */
  bar: ChartBar | null;
  endDate: IsoDate | null;
  /** Set when the activity is dated but sits outside the visible window. */
  offscreen: "before" | "after" | null;
};

export type ChartSection = {
  section: Section;
  rows: ChartRow[];
};

export type Chart = {
  days: ChartDay[];
  sections: ChartSection[];
  today: IsoDate;
  /** Inclusive window bounds. */
  from: IsoDate;
  to: IsoDate;
};

/** The mark a status prints in a cell — the chart's own shorthand. */
export function statusMark(status: TaskStatus): string {
  switch (status) {
    case "done":
      return "D";
    case "tentative":
      return "?";
    case "blocked":
      return "!";
    case "confirmed":
      return "X";
    case "planned":
      return "";
  }
}

export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "tentative":
      return "Pencilled in";
    case "blocked":
      return "Blocked";
    case "confirmed":
      return "Booked";
    case "planned":
      return "No date yet";
  }
}

/** The Monday on or before a date. The chart always starts its weeks on Monday. */
export function weekStart(date: IsoDate): IsoDate {
  const d = parseIsoDate(date);
  return formatIsoDate(addCalendarDays(d, -(isoWeekday(d) - 1)));
}

export function endDateOf(task: Activity, cal: WorkCalendar): IsoDate | null {
  return task.startDate ? finishIsoDate(task.startDate, task.durationDays, cal) : null;
}

/**
 * The window the chart covers, in whole Monday-to-Sunday weeks.
 *
 * Anchored on the current week rather than on the earliest task: the
 * contractor opens this to see what is happening now, and a chart that starts
 * in June because one activity did is a chart he has to scroll before it says
 * anything. Work already finished stays reachable by paging back.
 */
export function defaultWindow(
  doc: ScheduleDoc,
  weeks: number,
  now: Date = new Date(),
): { from: IsoDate; to: IsoDate } {
  const today = todayInZone(doc.project.timezone, now);
  const from = weekStart(today);
  const to = formatIsoDate(addCalendarDays(parseIsoDate(from), weeks * 7 - 1));
  return { from, to };
}

function buildDays(
  from: IsoDate,
  to: IsoDate,
  cal: WorkCalendar,
  today: IsoDate,
): ChartDay[] {
  const days: ChartDay[] = [];
  const last = parseIsoDate(to).getTime();

  for (
    let cursor = parseIsoDate(from);
    cursor.getTime() <= last;
    cursor = addCalendarDays(cursor, 1)
  ) {
    const date = formatIsoDate(cursor);
    const weekday = isoWeekday(cursor);
    days.push({
      date,
      weekday,
      initial: WEEKDAY_INITIALS[weekday - 1],
      dayOfMonth: cursor.getUTCDate(),
      off: !isWorkingDay(cursor, cal),
      isToday: date === today,
      monthLabel: null,
      monthSpan: 0,
    });
  }

  // Month banners: label the first column of each run, and measure it.
  let runStart = 0;
  for (let i = 0; i <= days.length; i += 1) {
    const changed =
      i === days.length ||
      parseIsoDate(days[i].date).getUTCMonth() !==
        parseIsoDate(days[runStart].date).getUTCMonth();
    if (changed) {
      const month = parseIsoDate(days[runStart].date).getUTCMonth();
      days[runStart].monthLabel = MONTHS[month];
      days[runStart].monthSpan = i - runStart;
      runStart = i;
    }
  }

  return days;
}

export function buildChart(
  doc: ScheduleDoc,
  window: { from: IsoDate; to: IsoDate },
  now: Date = new Date(),
): Chart {
  const cal: WorkCalendar = doc.calendar;
  const today = todayInZone(doc.project.timezone, now);
  const days = buildDays(window.from, window.to, cal, today);
  const indexByDate = new Map(days.map((d, i) => [d.date, i]));
  const windowStart = parseIsoDate(window.from).getTime();
  const windowEnd = parseIsoDate(window.to).getTime();

  const rowFor = (task: Activity): ChartRow => {
    const endDate = endDateOf(task, cal);
    if (!task.startDate || !endDate) {
      return { task, bar: null, endDate: null, offscreen: null };
    }

    const start = parseIsoDate(task.startDate).getTime();
    const end = parseIsoDate(endDate).getTime();

    if (end < windowStart) return { task, bar: null, endDate, offscreen: "before" };
    if (start > windowEnd) return { task, bar: null, endDate, offscreen: "after" };

    // Clamp to the window: a job that started last month still shows its tail,
    // flagged so the UI can draw the bar as running off the edge.
    const continuesLeft = start < windowStart;
    const continuesRight = end > windowEnd;
    const firstIndex = continuesLeft ? 0 : (indexByDate.get(task.startDate) ?? 0);
    const lastIndex = continuesRight ? days.length - 1 : (indexByDate.get(endDate) ?? 0);

    let workDays = 0;
    for (let i = firstIndex; i <= lastIndex; i += 1) {
      if (!days[i].off) workDays += 1;
    }

    return {
      task,
      endDate,
      offscreen: null,
      bar: {
        startIndex: firstIndex,
        span: lastIndex - firstIndex + 1,
        workDays,
        continuesLeft,
        continuesRight,
      },
    };
  };

  const sections: ChartSection[] = [...doc.sections]
    .sort((a, b) => a.order - b.order)
    .map((section) => ({
      section,
      rows: doc.tasks
        .filter((t) => t.sectionId === section.id)
        .sort((a, b) => a.order - b.order)
        .map(rowFor),
    }))
    // A section with nothing in it is a heading over blank space.
    .filter((s) => s.rows.length > 0);

  return { days, sections, today, from: window.from, to: window.to };
}

// ── The phone's shape ─────────────────────────────────────────────────────────

export type AgendaEntry = {
  task: Activity;
  endDate: IsoDate;
  /** Which working day of the activity this is, 1-based. */
  dayNumber: number;
  totalWorkDays: number;
};

export type AgendaDay = {
  date: IsoDate;
  weekday: number;
  isToday: boolean;
  off: boolean;
  entries: AgendaEntry[];
};

/**
 * The same schedule as a list of days.
 *
 * A sixty-column grid is unreadable on a phone, and the phone is where this
 * gets used — on a slab, in a truck. What he needs there is not the shape of
 * the job, it is "who is supposed to be here today, and tomorrow". So the
 * mobile layout is days, and only days that have something on them.
 */
export function buildAgenda(
  doc: ScheduleDoc,
  window: { from: IsoDate; to: IsoDate },
  now: Date = new Date(),
): AgendaDay[] {
  const cal: WorkCalendar = doc.calendar;
  const today = todayInZone(doc.project.timezone, now);
  const last = parseIsoDate(window.to).getTime();
  const out: AgendaDay[] = [];

  for (
    let cursor = parseIsoDate(window.from);
    cursor.getTime() <= last;
    cursor = addCalendarDays(cursor, 1)
  ) {
    const date = formatIsoDate(cursor);
    const entries: AgendaEntry[] = [];

    for (const task of doc.tasks) {
      const endDate = endDateOf(task, cal);
      if (!task.startDate || !endDate) continue;
      if (date < task.startDate || date > endDate) continue;
      // A crew is not on site over the weekend a job happens to span.
      if (!isWorkingDay(cursor, cal)) continue;

      let dayNumber = 0;
      for (
        let d = parseIsoDate(task.startDate);
        formatIsoDate(d) <= date;
        d = addCalendarDays(d, 1)
      ) {
        if (isWorkingDay(d, cal)) dayNumber += 1;
      }

      entries.push({ task, endDate, dayNumber, totalWorkDays: task.durationDays });
    }

    if (entries.length === 0) continue;

    entries.sort((a, b) => a.task.order - b.task.order);
    out.push({
      date,
      weekday: isoWeekday(cursor),
      isToday: date === today,
      off: !isWorkingDay(cursor, cal),
      entries,
    });
  }

  return out;
}

/** Activities with real work and no date — what the contractor chases. */
export function undatedTasks(doc: ScheduleDoc): Activity[] {
  return doc.tasks
    .filter((t) => !t.startDate && t.status !== "done")
    .sort((a, b) => a.order - b.order);
}
