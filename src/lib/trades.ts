/**
 * Trade → color assignment.
 *
 * SPEC §7 wants trade colors on the Gantt. Trades are free text (an org can
 * type anything), so colors are assigned by hashing the normalised trade name
 * into a fixed palette. Deterministic: the same trade is the same color on
 * every screen, every visit, every device — no per-org color table to keep in
 * sync, nothing to migrate.
 *
 * The palette is hand-picked to sit with the app's forest/cream scheme and to
 * stay tellable-apart on a phone in sunlight; adjacent hues differ in
 * lightness as well as hue for that reason.
 */

export type TradeColor = {
  /** Bar fill. */
  fill: string;
  /** Text that passes contrast on that fill. */
  text: string;
};

const PALETTE: readonly TradeColor[] = [
  { fill: "#447a72", text: "#ffffff" }, // sage
  { fill: "#ad8347", text: "#ffffff" }, // gold
  { fill: "#5a6c8f", text: "#ffffff" }, // slate blue
  { fill: "#8a5a83", text: "#ffffff" }, // plum
  { fill: "#a86532", text: "#ffffff" }, // rust
  { fill: "#3d7ca0", text: "#ffffff" }, // steel
  { fill: "#6b8e4e", text: "#ffffff" }, // moss
  { fill: "#946b5c", text: "#ffffff" }, // adobe
];

/** Neutral for tasks with no trade set. */
export const NO_TRADE: TradeColor = { fill: "#7d8783", text: "#ffffff" };

export function tradeColor(trade: string | null | undefined): TradeColor {
  if (!trade || trade.trim() === "") return NO_TRADE;
  const key = trade.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
