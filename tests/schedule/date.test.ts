import { describe, expect, it } from "vitest";

import {
  addWorkDays,
  finishIsoDate,
  formatIsoDate,
  isWorkingDay,
  isoWeekday,
  nextWorkingDay,
  parseIsoDate,
  todayInZone,
  workDaysBetween,
} from "@/lib/schedule";
import type { WorkCalendar } from "@/lib/schedule";

/** Mon–Fri, no holidays. The default an org gets at onboarding. */
const MON_FRI: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: [] };

/** Mon–Sat — plenty of contractors work Saturdays. */
const MON_SAT: WorkCalendar = { workingDays: [1, 2, 3, 4, 5, 6], holidays: [] };

// 2026-03-06 is a Friday; 2026-03-09 the following Monday.
const FRIDAY = "2026-03-06";

const add = (start: string, n: number, cal = MON_FRI) =>
  formatIsoDate(addWorkDays(parseIsoDate(start), n, cal));

describe("civil date handling", () => {
  it("round-trips without timezone drift", () => {
    // The bug SPEC §4 warns about: parsing an ISO date in a non-UTC zone and
    // losing a day. Every date here is a UTC-midnight anchor, so this holds
    // regardless of the machine's TZ.
    for (const d of ["2026-01-01", "2026-03-06", "2026-12-31", "2024-02-29"]) {
      expect(formatIsoDate(parseIsoDate(d))).toBe(d);
    }
  });

  it("rejects dates that do not exist", () => {
    expect(() => parseIsoDate("2026-02-31")).toThrow(/not a real calendar date/i);
    expect(() => parseIsoDate("2026-13-01")).toThrow(/not a real calendar date/i);
    expect(() => parseIsoDate("06-03-2026")).toThrow(/YYYY-MM-DD/);
  });

  it("maps Sunday to ISO 7, not 0", () => {
    expect(isoWeekday(parseIsoDate("2026-03-08"))).toBe(7); // Sunday
    expect(isoWeekday(parseIsoDate("2026-03-09"))).toBe(1); // Monday
  });

  it("resolves today in the org's zone, not the host's", () => {
    // 2026-03-07T02:00Z is still the 6th in Denver (UTC-7).
    const instant = new Date("2026-03-07T02:00:00Z");
    expect(todayInZone("America/Denver", instant)).toBe("2026-03-06");
    expect(todayInZone("UTC", instant)).toBe("2026-03-07");
    // ...and already the 7th in Sydney.
    expect(todayInZone("Australia/Sydney", instant)).toBe("2026-03-07");
  });
});

describe("working days", () => {
  it("knows weekends are not working days on a Mon-Fri calendar", () => {
    expect(isWorkingDay(parseIsoDate(FRIDAY), MON_FRI)).toBe(true);
    expect(isWorkingDay(parseIsoDate("2026-03-07"), MON_FRI)).toBe(false); // Sat
    expect(isWorkingDay(parseIsoDate("2026-03-08"), MON_FRI)).toBe(false); // Sun
  });

  it("respects a calendar that includes Saturday", () => {
    expect(isWorkingDay(parseIsoDate("2026-03-07"), MON_SAT)).toBe(true);
  });

  it("treats a holiday as non-working even on a weekday", () => {
    const cal: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: ["2026-03-09"] };
    expect(isWorkingDay(parseIsoDate("2026-03-09"), cal)).toBe(false);
  });

  it("pushes a non-working start forward to the next working day", () => {
    // SPEC §4: "A task never starts on a non-working day."
    expect(formatIsoDate(nextWorkingDay(parseIsoDate("2026-03-07"), MON_FRI))).toBe(
      "2026-03-09",
    );
    expect(formatIsoDate(nextWorkingDay(parseIsoDate(FRIDAY), MON_FRI))).toBe(FRIDAY);
  });

  it("refuses a calendar with no working days rather than hanging", () => {
    const broken: WorkCalendar = { workingDays: [], holidays: [] };
    expect(() => nextWorkingDay(parseIsoDate(FRIDAY), broken)).toThrow(
      /no working days/i,
    );
  });
});

describe("addWorkDays", () => {
  it("rolls a Friday start over the weekend", () => {
    expect(add(FRIDAY, 1)).toBe("2026-03-09"); // Mon
    expect(add(FRIDAY, 2)).toBe("2026-03-10"); // Tue
    expect(add(FRIDAY, 5)).toBe("2026-03-13"); // following Fri
  });

  it("returns the same day for n = 0 on a working day", () => {
    expect(add(FRIDAY, 0)).toBe(FRIDAY);
  });

  it("normalises a weekend start before counting", () => {
    expect(add("2026-03-07", 0)).toBe("2026-03-09"); // Sat -> Mon
    expect(add("2026-03-07", 1)).toBe("2026-03-10"); // Sat -> Tue
  });

  it("skips a holiday that falls inside the span", () => {
    const cal: WorkCalendar = {
      workingDays: [1, 2, 3, 4, 5],
      holidays: ["2026-03-10"], // the Tuesday
    };
    // Fri +2 would be Tue, but Tue is a holiday, so Wed.
    expect(add(FRIDAY, 2, cal)).toBe("2026-03-11");
  });

  it("walks backwards for negative n (a lead)", () => {
    expect(add("2026-03-09", -1)).toBe(FRIDAY); // Mon back to Fri
    expect(add("2026-03-09", -3)).toBe("2026-03-04"); // back to Wed
  });

  it("is the inverse of workDaysBetween", () => {
    const a = parseIsoDate(FRIDAY);
    for (const n of [0, 1, 3, 7, 20, -1, -6]) {
      const b = addWorkDays(a, n, MON_FRI);
      expect(workDaysBetween(a, b, MON_FRI)).toBe(n);
    }
  });
});

describe("workDaysBetween", () => {
  it("counts steps between, not days occupied", () => {
    // Mon -> Tue is one step.
    expect(workDaysBetween(parseIsoDate("2026-03-09"), parseIsoDate("2026-03-10"), MON_FRI)).toBe(1);
  });

  it("ignores the weekend in between", () => {
    expect(workDaysBetween(parseIsoDate(FRIDAY), parseIsoDate("2026-03-09"), MON_FRI)).toBe(1);
  });

  it("is signed", () => {
    expect(workDaysBetween(parseIsoDate("2026-03-09"), parseIsoDate(FRIDAY), MON_FRI)).toBe(-1);
    expect(workDaysBetween(parseIsoDate(FRIDAY), parseIsoDate(FRIDAY), MON_FRI)).toBe(0);
  });
});

describe("finishDate", () => {
  it("matches the worked example in SPEC §4", () => {
    // "A task starting Friday with 3 work days finishes Tuesday."
    expect(finishIsoDate(FRIDAY, 3, MON_FRI)).toBe("2026-03-10");
  });

  it("finishes a one-day task on its start day", () => {
    expect(finishIsoDate(FRIDAY, 1, MON_FRI)).toBe(FRIDAY);
    expect(finishIsoDate("2026-03-09", 1, MON_FRI)).toBe("2026-03-09");
  });

  it("extends across a holiday inside the span", () => {
    const cal: WorkCalendar = {
      workingDays: [1, 2, 3, 4, 5],
      holidays: ["2026-03-10"],
    };
    // Fri, (Sat/Sun), Mon, (Tue holiday), Wed -> 3 work days ends Wednesday.
    expect(finishIsoDate(FRIDAY, 3, cal)).toBe("2026-03-11");
  });

  it("rejects a duration below one work day", () => {
    expect(() => finishIsoDate(FRIDAY, 0, MON_FRI)).toThrow(/at least 1/);
    expect(() => finishIsoDate(FRIDAY, 1.5, MON_FRI)).toThrow(/whole number/);
  });
});
