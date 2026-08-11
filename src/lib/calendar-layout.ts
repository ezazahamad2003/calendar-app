/**
 * Laying timed work out on an hour grid.
 *
 * Pure arithmetic, no React and no dates — minutes since midnight in, columns
 * out. Same discipline as `lib/schedule`: the part that is easy to get subtly
 * wrong is the part that gets its own module and its own tests.
 *
 * The hard case is overlap. Two crews on site from 08:00, one until noon and
 * one until 16:00, plus an inspection at 10:00 — stacking those in a list
 * loses the only thing the day view exists to show, which is that they collide.
 */

/** `HH:MM` or `HH:MM:SS` → minutes since midnight. Null for anything else. */
export function minutesOf(time: string | null | undefined): number | null {
  if (!time) return null;
  const match = /^(\d{2}):(\d{2})/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** `540` → "9 AM", `570` → "9:30 AM". The scale reads as a clock, not a count. */
export function clockLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export type Span = { startMin: number; endMin: number };

/** A span with its place in a stack of overlapping ones. */
export type Placed<T> = T & {
  /** 0-based position across the width. */
  column: number;
  /** How many columns the whole overlapping cluster needs. */
  columns: number;
};

/**
 * Place overlapping spans side by side.
 *
 * Spans are grouped into clusters — runs where each item overlaps at least one
 * other, transitively — and every item in a cluster is drawn at the same width
 * so the columns line up. Within a cluster each span takes the leftmost column
 * that is free at its start time, which is what makes a long booking hold its
 * column while short ones come and go beside it.
 *
 * Cluster-wide width rather than per-span width is deliberate: it means a
 * booking's column never shifts as the eye travels down the day, which is the
 * property that lets you follow one crew's bar without re-finding it.
 */
export function placeSpans<T extends Span>(spans: T[]): Placed<T>[] {
  const ordered = [...spans].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin,
  );

  const out: Placed<T>[] = [];
  /** The current cluster, and the last end time in each of its columns. */
  let cluster: Placed<T>[] = [];
  let columnEnds: number[] = [];

  const flush = () => {
    for (const item of cluster) item.columns = columnEnds.length;
    out.push(...cluster);
    cluster = [];
    columnEnds = [];
  };

  for (const span of ordered) {
    // A gap with nothing running through it ends the cluster: what follows
    // shares no vertical space with what came before, so it starts again at
    // full width.
    if (columnEnds.length > 0 && span.startMin >= Math.max(...columnEnds)) flush();

    let column = columnEnds.findIndex((end) => end <= span.startMin);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(span.endMin);
    } else {
      columnEnds[column] = span.endMin;
    }

    cluster.push({ ...span, column, columns: columnEnds.length });
  }

  flush();
  return out;
}

/**
 * The hours worth drawing.
 *
 * A grid that always runs midnight to midnight is mostly empty: nobody pours
 * concrete at 3am, and the rows that matter get squeezed into a third of the
 * screen or pushed below the fold. So the window starts at the working day and
 * stretches only as far as the work actually goes.
 *
 * `[startHour, endHour)` — end is exclusive, so 7–19 draws 07:00 to 19:00.
 */
export function hourWindow(
  spans: Span[],
  defaultStart = 7,
  defaultEnd = 19,
): { startHour: number; endHour: number } {
  let startHour = defaultStart;
  let endHour = defaultEnd;

  for (const span of spans) {
    startHour = Math.min(startHour, Math.floor(span.startMin / 60));
    // A task ending at 17:00 needs the 17:00 line drawn, not the 17:00 row.
    endHour = Math.max(endHour, Math.ceil(span.endMin / 60));
  }

  return {
    startHour: Math.max(0, startHour),
    endHour: Math.min(24, Math.max(endHour, startHour + 1)),
  };
}
