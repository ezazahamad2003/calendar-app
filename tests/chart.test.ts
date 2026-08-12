import { describe, expect, it } from "vitest";

import {
  buildAgenda,
  buildChart,
  defaultWindow,
  statusMark,
  undatedTasks,
  weekStart,
} from "@/lib/chart";
import { teamColors } from "@/lib/team-color";
import { doc, ID, SEED_DATE } from "./fixture";

/**
 * The chart's geometry.
 *
 * Tested as a value, so the awkward parts — a bar crossing a weekend, a job
 * running off the edge of the window, a row with no dates at all — are pinned
 * down without a browser.
 */

const WINDOW = { from: "2026-08-10", to: "2026-10-11" };

describe("the day header", () => {
  it("covers the window a day at a time, weekends included", () => {
    const chart = buildChart(doc(), WINDOW, SEED_DATE);
    expect(chart.days).toHaveLength(63); // nine weeks
    expect(chart.days[0].date).toBe("2026-08-10");
    expect(chart.days[0].initial).toBe("M");
    expect(chart.days.at(-1)?.date).toBe("2026-10-11");
  });

  it("shades Saturday and Sunday", () => {
    const chart = buildChart(doc(), WINDOW, SEED_DATE);
    const sat = chart.days.find((d) => d.date === "2026-08-15");
    const mon = chart.days.find((d) => d.date === "2026-08-17");
    expect(sat?.off).toBe(true);
    expect(mon?.off).toBe(false);
  });

  it("banners each month once, spanning its own days", () => {
    const chart = buildChart(doc(), WINDOW, SEED_DATE);
    const banners = chart.days.filter((d) => d.monthLabel);
    expect(banners.map((b) => b.monthLabel)).toEqual([
      "AUGUST",
      "SEPTEMBER",
      "OCTOBER",
    ]);
    // 10–31 August is 22 days.
    expect(banners[0].monthSpan).toBe(22);
    expect(banners.reduce((n, b) => n + b.monthSpan, 0)).toBe(63);
  });

  it("marks today, in the project's timezone", () => {
    const chart = buildChart(doc(), WINDOW, SEED_DATE);
    // 12 Aug 2026, 15:00 UTC is still 12 Aug in California.
    expect(chart.today).toBe("2026-08-12");
    expect(chart.days.filter((d) => d.isToday)).toHaveLength(1);
  });

  it("uses the project's zone rather than the server's", () => {
    // 03:00 UTC on the 13th is still the evening of the 12th in California,
    // and the app must agree with the person standing on the slab.
    const chart = buildChart(doc(), WINDOW, new Date("2026-08-13T03:00:00Z"));
    expect(chart.today).toBe("2026-08-12");
  });
});

describe("bars", () => {
  it("spans the weekend a two-day job straddles", () => {
    const chart = buildChart(doc(), WINDOW, SEED_DATE);
    const row = chart.sections
      .flatMap((s) => s.rows)
      .find((r) => r.task.id === ID.hydro);

    // Fri 14 and Mon 17: two work days, four calendar columns.
    expect(row?.bar?.workDays).toBe(2);
    expect(row?.bar?.span).toBe(4);
    expect(row?.endDate).toBe("2026-08-17");
  });

  it("keeps a row for an activity with no date", () => {
    const chart = buildChart(doc(), WINDOW, SEED_DATE);
    const row = chart.sections
      .flatMap((s) => s.rows)
      .find((r) => r.task.id === ID.rebar);

    expect(row).toBeDefined();
    expect(row?.bar).toBeNull();
    expect(row?.offscreen).toBeNull();
  });

  it("flags an activity that finished before the window", () => {
    const chart = buildChart(doc(), { from: "2026-09-01", to: "2026-09-30" }, SEED_DATE);
    const row = chart.sections
      .flatMap((s) => s.rows)
      .find((r) => r.task.id === ID.fireRiser);

    expect(row?.bar).toBeNull();
    expect(row?.offscreen).toBe("before");
  });

  it("clamps a bar that starts before the window and notes it runs off", () => {
    // Color Coat runs 10–21 Aug; a window opening on the 17th cuts it.
    const chart = buildChart(doc(), { from: "2026-08-17", to: "2026-08-30" }, SEED_DATE);
    const row = chart.sections
      .flatMap((s) => s.rows)
      .find((r) => r.task.id === ID.colorCoat);

    expect(row?.bar?.startIndex).toBe(0);
    expect(row?.bar?.continuesLeft).toBe(true);
    expect(row?.bar?.continuesRight).toBe(false);
  });

  it("puts every activity in a section, and drops empty sections", () => {
    const d = doc();
    const chart = buildChart(d, WINDOW, SEED_DATE);
    const rows = chart.sections.flatMap((s) => s.rows);
    expect(rows).toHaveLength(d.tasks.length);
    expect(chart.sections.map((s) => s.section.name)).toEqual([
      "AG SHOP BUILDING",
      "ORDERS",
    ]);
  });
});

describe("the marks match the paper", () => {
  it("uses the chart's own shorthand", () => {
    expect(statusMark("confirmed")).toBe("X");
    expect(statusMark("tentative")).toBe("?");
    expect(statusMark("done")).toBe("D");
    expect(statusMark("planned")).toBe("");
  });
});

describe("the phone's agenda", () => {
  it("lists only days that have work on them", () => {
    const agenda = buildAgenda(doc(), WINDOW, SEED_DATE);
    expect(agenda.length).toBeGreaterThan(0);
    expect(agenda.every((day) => day.entries.length > 0)).toBe(true);
  });

  it("never puts a crew on a weekend a job merely spans", () => {
    const agenda = buildAgenda(doc(), WINDOW, SEED_DATE);
    expect(agenda.some((day) => day.date === "2026-08-15")).toBe(false);
    expect(agenda.some((day) => day.date === "2026-08-17")).toBe(true);
  });

  it("counts the working day within a multi-day job", () => {
    const agenda = buildAgenda(doc(), WINDOW, SEED_DATE);
    const monday = agenda.find((day) => day.date === "2026-08-17");
    const hydro = monday?.entries.find((e) => e.task.id === ID.hydro);
    // Friday was day 1; Monday is day 2 of 2.
    expect(hydro?.dayNumber).toBe(2);
    expect(hydro?.totalWorkDays).toBe(2);
  });
});

describe("the backlog", () => {
  it("collects everything real with no date", () => {
    const d = doc();
    const undated = undatedTasks(d);
    expect(undated.length).toBeGreaterThan(10);
    expect(undated.every((t) => t.startDate === null)).toBe(true);
    // Finished work is not a thing to chase.
    expect(undated.every((t) => t.status !== "done")).toBe(true);
  });
});

describe("the window", () => {
  it("opens on the Monday of the current week", () => {
    const { from } = defaultWindow(doc(), 9, SEED_DATE);
    // Wednesday 12 August 2026 → Monday 10 August.
    expect(from).toBe("2026-08-10");
    expect(weekStart("2026-08-16")).toBe("2026-08-10"); // Sunday belongs to the week before
    expect(weekStart("2026-08-17")).toBe("2026-08-17");
  });
});

describe("team colours", () => {
  it("gives the trades on one row different colours", () => {
    const d = doc();
    const colors = teamColors(d);
    const first = [...colors.values()].slice(0, 8).map((c) => c.fill);
    // Assigned by position, so the first eight cannot collide the way a hash
    // would.
    expect(new Set(first).size).toBe(8);
  });

  it("gives a team the same colour every time", () => {
    const a = teamColors(doc());
    const b = teamColors(doc());
    expect(a.get("Harvpro")).toEqual(b.get("Harvpro"));
  });
});
