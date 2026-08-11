/**
 * Dates as a contractor reads them.
 *
 * ISO is the storage and transport format and stays that way everywhere
 * internal — it sorts, it compares, it has no ambiguity. This is only for text
 * a person sees: an email subject, a plan diff, an invite body. "2026-08-18"
 * in a message to a subcontractor reads like a machine wrote it, because one
 * did.
 *
 * Fixed to UTC because the app's dates are civil dates with no time — a task
 * runs on the 18th, not from an instant to an instant. Formatting them in a
 * local zone is what turns the 18th into the 17th for someone west of you.
 */

const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** "Tue 18 Aug". */
export function humanDay(iso: string): string {
  return DAY.format(new Date(`${iso}T00:00:00Z`));
}

/** "Tue 18 Aug", or "Tue 18 Aug – Thu 20 Aug" for a run of days. */
export function humanRange(startIso: string, endIso: string | null): string {
  if (!endIso || endIso === startIso) return humanDay(startIso);
  return `${humanDay(startIso)} – ${humanDay(endIso)}`;
}
