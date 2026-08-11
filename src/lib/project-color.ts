/**
 * Project → color assignment.
 *
 * Same discipline as `trades.ts`: hash the name into a fixed palette, so a
 * project is the same color on every screen and every device with nothing
 * stored and nothing to keep in sync. `projects.color` overrides it, and is
 * only ever set when someone explicitly asked for a color.
 *
 * The palette is deliberately *not* the trade palette. On the calendar a
 * project band and a trade bar can sit in the same cell, and two scales that
 * share hues make them read as related when they are not. These are lighter
 * and cooler; trades keep the saturated mid-tones.
 */

export type ProjectColor = {
  /** Band / chip fill. */
  fill: string;
  /** Text that passes contrast on that fill. */
  text: string;
  /** Hairline edge, for chips on a pale background. */
  edge: string;
};

const PALETTE: readonly ProjectColor[] = [
  { fill: "#2f6f68", text: "#ffffff", edge: "#245650" }, // deep teal
  { fill: "#8c5a2b", text: "#ffffff", edge: "#6d4520" }, // bronze
  { fill: "#43608c", text: "#ffffff", edge: "#334a6d" }, // indigo
  { fill: "#7a4370", text: "#ffffff", edge: "#5e3356" }, // mulberry
  { fill: "#a04b3c", text: "#ffffff", edge: "#7d392d" }, // brick
  { fill: "#2c7d8c", text: "#ffffff", edge: "#216069" }, // lagoon
  { fill: "#5c7a35", text: "#ffffff", edge: "#465d28" }, // olive
  { fill: "#6b5b95", text: "#ffffff", edge: "#524673" }, // iris
];

/** Colors the planner may pick from by name, when the user asks out loud. */
export const NAMED_COLORS: Record<string, string> = {
  teal: "#2f6f68",
  green: "#5c7a35",
  blue: "#43608c",
  purple: "#6b5b95",
  red: "#a04b3c",
  orange: "#8c5a2b",
  brown: "#8c5a2b",
  pink: "#7a4370",
  cyan: "#2c7d8c",
};

function readable(fill: string): ProjectColor {
  const known = PALETTE.find((p) => p.fill.toLowerCase() === fill.toLowerCase());
  if (known) return known;

  // Relative luminance, so a hand-picked color still gets legible text on it.
  const r = parseInt(fill.slice(1, 3), 16) / 255;
  const g = parseInt(fill.slice(3, 5), 16) / 255;
  const b = parseInt(fill.slice(5, 7), 16) / 255;
  const channel = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const luminance =
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

  return {
    fill,
    text: luminance > 0.45 ? "#172322" : "#ffffff",
    edge: fill,
  };
}

export function projectColor(
  name: string,
  explicit?: string | null,
): ProjectColor {
  if (explicit && /^#[0-9a-fA-F]{6}$/.test(explicit)) return readable(explicit);

  const key = name.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
