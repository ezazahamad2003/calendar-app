import type { IsoDate, IsoWeekday, WorkCalendar } from "./types";

/**
 * Civil-date arithmetic for the schedule engine (SPEC §4).
 *
 * ## The one rule that matters
 *
 * A schedule date is a *civil* date — "March 3rd" — not an instant. It has no
 * time and no zone. SPEC §4 is blunt about why this matters: an off-by-one from
 * UTC drift is the bug that makes a contractor stop trusting the app.
 *
 * So every `Date` in this module is a **UTC-midnight anchor**: the instant
 * `YYYY-MM-DDT00:00:00Z`. All arithmetic uses the `getUTC*` / `setUTC*` family.
 * Nothing here ever calls `getDate()`, `getDay()`, or `new Date(isoString)`
 * without pinning the zone, because those read the *host machine's* timezone —
 * which on Vercel is UTC and on the contractor's phone is not, and that
 * disagreement is precisely the drift.
 *
 * The org's timezone enters in exactly one place: `todayInZone()`, which asks
 * "what is today's date over there right now?". After that it is civil dates
 * all the way down.
 */

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `YYYY-MM-DD` into its UTC-midnight anchor. */
export function parseIsoDate(value: IsoDate): Date {
  if (!ISO_DATE.test(value)) {
    throw new Error(`Not a YYYY-MM-DD date: "${value}"`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  // Date.UTC rolls impossible dates over silently — Feb 31st becomes March 3rd.
  // Round-tripping catches that instead of scheduling work on a day that does
  // not exist.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new Error(`Not a real calendar date: "${value}"`);
  }
  return date;
}

/** Format a UTC-midnight anchor back to `YYYY-MM-DD`. */
export function formatIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** Shift by whole calendar days. Pure; returns a new Date. */
export function addCalendarDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** ISO weekday (1 = Mon … 7 = Sun) of a UTC-midnight anchor. */
export function isoWeekday(date: Date): IsoWeekday {
  // getUTCDay() is 0 = Sunday; ISO wants 7.
  const day = date.getUTCDay();
  return (day === 0 ? 7 : day) as IsoWeekday;
}

/**
 * Today's civil date in a given IANA zone.
 *
 * The *only* function here that cares about zones. `en-CA` is not cosmetic —
 * its short date format is already `YYYY-MM-DD`, so this avoids reassembling
 * parts by hand.
 */
export function todayInZone(timeZone: string, now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function holidaySet(cal: WorkCalendar): ReadonlySet<IsoDate> {
  return cal.holidays instanceof Set
    ? (cal.holidays as ReadonlySet<IsoDate>)
    : new Set(cal.holidays);
}

/** Is work done on this date? False on non-working weekdays and holidays. */
export function isWorkingDay(date: Date, cal: WorkCalendar): boolean {
  if (!cal.workingDays.includes(isoWeekday(date))) return false;
  return !holidaySet(cal).has(formatIsoDate(date));
}

/**
 * Guard against an empty working-day set. Every search below walks forward
 * looking for a working day; with none, that never terminates. The DB has a
 * CHECK constraint for the same reason, but the engine also runs on values
 * that never came from the DB (a planner's hypothetical, a test fixture).
 */
function assertSchedulable(cal: WorkCalendar): void {
  if (cal.workingDays.length === 0) {
    throw new Error(
      "Work calendar has no working days, so no date can ever be scheduled. " +
        "Set at least one ISO weekday (1=Mon … 7=Sun).",
    );
  }
}

/**
 * The first working day on or after `date`.
 *
 * SPEC §4: "A task never starts on a non-working day. Push forward to the next
 * working day." Every entry point normalises through here.
 */
export function nextWorkingDay(date: Date, cal: WorkCalendar): Date {
  assertSchedulable(cal);
  let cursor = date;
  // Bounded so a pathological holiday list fails loudly rather than hanging a
  // request. Ten years of consecutive holidays is not a real schedule.
  for (let guard = 0; guard < 3_660; guard += 1) {
    if (isWorkingDay(cursor, cal)) return cursor;
    cursor = addCalendarDays(cursor, 1);
  }
  throw new Error(
    `No working day found within ten years of ${formatIsoDate(date)}. ` +
      `Check the calendar's holidays.`,
  );
}

/** The first working day on or before `date`. Used by FF/SF back-solving. */
export function previousWorkingDay(date: Date, cal: WorkCalendar): Date {
  assertSchedulable(cal);
  let cursor = date;
  for (let guard = 0; guard < 3_660; guard += 1) {
    if (isWorkingDay(cursor, cal)) return cursor;
    cursor = addCalendarDays(cursor, -1);
  }
  throw new Error(
    `No working day found within ten years before ${formatIsoDate(date)}. ` +
      `Check the calendar's holidays.`,
  );
}

/**
 * Move `n` working days from `start`.
 *
 * `start` is normalised to a working day first, so the result is always a
 * working day. `n = 0` therefore means "this day, or the next working one".
 * Negative `n` walks backwards, which is what negative lag (a lead) needs.
 *
 * This is the exact inverse of `workDaysBetween`:
 *   `addWorkDays(a, workDaysBetween(a, b), cal) === b` for working `a`, `b`.
 */
export function addWorkDays(start: Date, n: number, cal: WorkCalendar): Date {
  assertSchedulable(cal);
  const step = n < 0 ? -1 : 1;
  let cursor = n < 0 ? previousWorkingDay(start, cal) : nextWorkingDay(start, cal);
  let remaining = Math.abs(n);

  while (remaining > 0) {
    cursor = addCalendarDays(cursor, step);
    cursor = step > 0 ? nextWorkingDay(cursor, cal) : previousWorkingDay(cursor, cal);
    remaining -= 1;
  }
  return cursor;
}

/**
 * Working days from `a` to `b`. Positive when `b` is later, negative when
 * earlier, zero when they are the same working day.
 *
 * Counts the *steps between* them, not the days occupied — Monday to Tuesday is
 * 1, not 2. That makes it the inverse of `addWorkDays`, which is what the
 * cascade relies on.
 */
export function workDaysBetween(a: Date, b: Date, cal: WorkCalendar): number {
  assertSchedulable(cal);
  const from = nextWorkingDay(a, cal);
  const to = nextWorkingDay(b, cal);
  if (from.getTime() === to.getTime()) return 0;

  const forward = to.getTime() > from.getTime();
  const step = forward ? 1 : -1;
  let cursor = from;
  let count = 0;

  while (cursor.getTime() !== to.getTime()) {
    cursor = addCalendarDays(cursor, step);
    if (isWorkingDay(cursor, cal)) count += 1;
    if (count > 100_000) {
      throw new Error("workDaysBetween failed to converge — check the calendar.");
    }
  }
  return forward ? count : -count;
}

/**
 * Last working day of a task.
 *
 * A task occupies `durationDays` *working* days inclusive of its start, so the
 * finish is `durationDays - 1` steps on. SPEC §4's worked example: a task
 * starting Friday with 3 work days finishes Tuesday.
 */
export function finishDate(
  startDate: Date,
  durationDays: number,
  cal: WorkCalendar,
): Date {
  if (!Number.isInteger(durationDays) || durationDays < 1) {
    throw new Error(
      `Duration must be a whole number of work days, at least 1. Got ${durationDays}.`,
    );
  }
  return addWorkDays(startDate, durationDays - 1, cal);
}

/** `finishDate`, on ISO strings. */
export function finishIsoDate(
  startDate: IsoDate,
  durationDays: number,
  cal: WorkCalendar,
): IsoDate {
  return formatIsoDate(finishDate(parseIsoDate(startDate), durationDays, cal));
}
