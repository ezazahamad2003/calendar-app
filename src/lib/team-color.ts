import type { ScheduleDoc } from "@/lib/store/types";

/**
 * Team → colour.
 *
 * Assigned by **position** in the sorted list of teams on the job, not by
 * hashing the name. A hash spreads names evenly across the palette in the
 * abstract, but this job has fifteen teams and a hash will cheerfully give two
 * of them the same colour — and the two that collide are the two the eye is
 * trying to tell apart on one row of the chart. Position guarantees the first
 * eight are all different, which covers the trades on site in any given week.
 *
 * The chart itself is mostly monochrome, as the paper one is. Colour is a
 * secondary cue on the left-hand team column, not the thing that carries the
 * meaning — that is the status mark in the cell.
 */

export type TeamColor = {
  /** Chip fill. */
  fill: string;
  /** Text that passes contrast on that fill. */
  text: string;
};

/**
 * Ordered so consecutive entries sit far apart in hue *and* lightness — the
 * two are needed together for a phone screen in direct sun, where lightness
 * survives and hue washes out.
 */
const PALETTE: readonly TeamColor[] = [
  { fill: "#2f6f68", text: "#ffffff" }, // teal
  { fill: "#a04b3c", text: "#ffffff" }, // brick
  { fill: "#43608c", text: "#ffffff" }, // indigo
  { fill: "#8c5a2b", text: "#ffffff" }, // bronze
  { fill: "#6b5b95", text: "#ffffff" }, // iris
  { fill: "#5c7a35", text: "#ffffff" }, // olive
  { fill: "#7a4370", text: "#ffffff" }, // mulberry
  { fill: "#2c7d8c", text: "#ffffff" }, // lagoon
  { fill: "#94603f", text: "#ffffff" }, // umber
  { fill: "#4a6a55", text: "#ffffff" }, // fern
];

/** For a row with no team named — the chart's "?" in the TEAM column. */
export const NO_TEAM: TeamColor = { fill: "#6f7671", text: "#ffffff" };

/**
 * A stable team → colour map for one document.
 *
 * Built once per render and passed down, rather than recomputed per row:
 * ordering by the whole set is the entire point, so a per-row function would
 * need the whole set anyway.
 */
export function teamColors(doc: ScheduleDoc): Map<string, TeamColor> {
  const teams = [
    ...new Set(
      doc.tasks
        .map((t) => t.team?.trim())
        .filter((t): t is string => Boolean(t)),
    ),
  ].sort((a, b) => a.localeCompare(b));

  return new Map(teams.map((team, i) => [team, PALETTE[i % PALETTE.length]]));
}

export function colorFor(
  colors: ReadonlyMap<string, TeamColor>,
  team: string | null | undefined,
): TeamColor {
  if (!team) return NO_TEAM;
  return colors.get(team.trim()) ?? NO_TEAM;
}
