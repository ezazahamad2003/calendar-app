import { describe, expect, it } from "vitest";

import {
  clockLabel,
  hourWindow,
  minutesOf,
  placeSpans,
} from "@/lib/calendar-layout";

/**
 * The day and week grids.
 *
 * Overlap is the whole reason the hour grid exists — two crews on site at once
 * is exactly what a list of names under a date cannot show — so most of this
 * file is about what happens when spans collide.
 */

const span = (startMin: number, endMin: number, id = `${startMin}`) => ({
  id,
  startMin,
  endMin,
});

const at = (h: number, m = 0) => h * 60 + m;

describe("reading the clock", () => {
  it("parses both the time and the timestamp Postgres returns", () => {
    expect(minutesOf("07:30")).toBe(450);
    expect(minutesOf("07:30:00")).toBe(450);
  });

  it("treats an absent or malformed time as all-day rather than midnight", () => {
    expect(minutesOf(null)).toBeNull();
    expect(minutesOf("")).toBeNull();
    expect(minutesOf("half seven")).toBeNull();
    expect(minutesOf("29:00")).toBeNull();
  });

  it("labels the scale the way a clock reads", () => {
    expect(clockLabel(0)).toBe("12 AM");
    expect(clockLabel(at(7))).toBe("7 AM");
    expect(clockLabel(at(12))).toBe("12 PM");
    expect(clockLabel(at(13, 30))).toBe("1:30 PM");
  });
});

describe("placing overlapping work side by side", () => {
  it("gives a lone booking the full width", () => {
    const [only] = placeSpans([span(at(9), at(11))]);
    expect(only).toMatchObject({ column: 0, columns: 1 });
  });

  it("splits two overlapping bookings into two columns", () => {
    const placed = placeSpans([span(at(8), at(12), "a"), span(at(10), at(16), "b")]);
    expect(placed.map((p) => [p.id, p.column, p.columns])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
    ]);
  });

  it("gives every span in a cluster the same width, so columns line up", () => {
    const placed = placeSpans([
      span(at(7), at(15, 30), "pour"),
      span(at(8), at(12), "rebar"),
      span(at(10, 30), at(16), "crane"),
    ]);
    expect(placed.every((p) => p.columns === 3)).toBe(true);
    expect(placed.map((p) => p.column)).toEqual([0, 1, 2]);
  });

  it("starts a fresh cluster once nothing is running", () => {
    const placed = placeSpans([
      span(at(8), at(12), "morning-a"),
      span(at(9), at(11), "morning-b"),
      span(at(14), at(15), "afternoon"),
    ]);
    const afternoon = placed.find((p) => p.id === "afternoon");
    // Nothing overlaps it, so it takes the whole column back.
    expect(afternoon).toMatchObject({ column: 0, columns: 1 });
    expect(placed.filter((p) => p.id.startsWith("morning")).every((p) => p.columns === 2)).toBe(
      true,
    );
  });

  it("reuses a column the moment it is free", () => {
    const placed = placeSpans([
      span(at(8), at(16), "all-day-ish"),
      span(at(8), at(10), "early"),
      span(at(10), at(12), "later"),
    ]);
    // `later` starts exactly when `early` ends, so it slots into the same
    // column rather than opening a third.
    expect(placed.find((p) => p.id === "later")?.column).toBe(1);
    expect(placed.every((p) => p.columns === 2)).toBe(true);
  });

  it("keeps a long booking in one column while short ones come and go", () => {
    const placed = placeSpans([
      span(at(7), at(18), "long"),
      span(at(8), at(9), "s1"),
      span(at(10), at(11), "s2"),
      span(at(12), at(13), "s3"),
    ]);
    expect(placed.find((p) => p.id === "long")?.column).toBe(0);
    expect(placed.filter((p) => p.id.startsWith("s")).map((p) => p.column)).toEqual([1, 1, 1]);
  });

  it("does not care what order it is handed the spans in", () => {
    const forwards = placeSpans([span(at(8), at(12), "a"), span(at(10), at(16), "b")]);
    const backwards = placeSpans([span(at(10), at(16), "b"), span(at(8), at(12), "a")]);
    expect(backwards).toEqual(forwards);
  });

  it("handles an empty day", () => {
    expect(placeSpans([])).toEqual([]);
  });
});

describe("choosing which hours to draw", () => {
  it("shows the working day when there is nothing unusual on it", () => {
    expect(hourWindow([span(at(9), at(17))])).toEqual({ startHour: 7, endHour: 19 });
  });

  it("stretches up to meet an early start", () => {
    expect(hourWindow([span(at(5, 30), at(14))]).startHour).toBe(5);
  });

  it("stretches down to cover a late finish, including the closing line", () => {
    expect(hourWindow([span(at(9), at(21, 15))]).endHour).toBe(22);
  });

  it("never runs past midnight or before it", () => {
    const w = hourWindow([span(0, at(23, 59))]);
    expect(w.startHour).toBe(0);
    expect(w.endHour).toBe(24);
  });

  it("always draws at least one hour", () => {
    const w = hourWindow([], 9, 9);
    expect(w.endHour).toBeGreaterThan(w.startHour);
  });
});
