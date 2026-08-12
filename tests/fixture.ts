import { seedDoc } from "@/lib/store/seed";
import type { ScheduleDoc, StoreDriver } from "@/lib/store";

/**
 * Shared test fixtures.
 *
 * The seed is used as the fixture rather than a hand-written toy document,
 * deliberately: it is the client's real wall chart, with its real awkward
 * shapes — two activities with the same name, eighteen undated rows, a
 * ten-work-day span that crosses a weekend, teams with no email address. A
 * synthetic fixture would have none of those, and those are where the bugs are.
 */

export const SEED_DATE = new Date("2026-08-12T15:00:00Z");

export function doc(): ScheduleDoc {
  return seedDoc(SEED_DATE);
}

/** Ids from the real chart, so tests read as the thing they are testing. */
export const ID = {
  fireRiser: "install-fire-riser-sprinkler",
  hydro: "hydro-fire-pump-room",
  pumpTest: "fire-pump-start-up-test-flush",
  consultant: "the-fire-consultant-inpection",
  inspection: "inspection",
  finalInspection: "final-inspection",
  downspouts: "install-downspouts",
  colorCoat: "color-coat",
  grade: "finish-grade-for-ac-and-concrete",
  rebar: "rebar-inspection",
  interiorFinish: "interior-finish",
  electrical: "electrical-inspection",
} as const;

export function taskById(d: ScheduleDoc, id: string) {
  const task = d.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`No such activity in the fixture: ${id}`);
  return task;
}

/** An in-memory driver, so store tests touch no disk and no network. */
export class MemoryDriver implements StoreDriver {
  readonly name = "memory";
  body: string | null;
  writes = 0;

  constructor(body: string | null = null) {
    this.body = body;
  }

  async read() {
    return this.body === null ? null : { body: this.body };
  }

  async write(body: string) {
    this.writes += 1;
    this.body = body;
  }
}
