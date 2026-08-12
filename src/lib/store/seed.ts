import { randomBytes } from "node:crypto";

import type { IsoWeekday } from "@/lib/schedule";
import raw from "../../../data/seed.json";
import type { Activity, Contact, ScheduleDoc, Section, TaskStatus } from "./types";

/**
 * The document the app boots with, built from the client's wall chart.
 *
 * `data/seed.json` is a faithful transcription of `AG SHOP 8.10.26.xls` — see
 * `scripts/extract-client-files.py`. Keeping it verbatim and doing the
 * app-shaped assembly here means re-importing an updated chart never has to
 * think about contacts, ids or share tokens.
 */

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/**
 * Contacts, derived from the chart's TEAM column.
 *
 * Every one starts with `email: null`. That is deliberate and it is the whole
 * point: the chart names companies, not addresses, and the app must never
 * invent one. An activity whose team has no address simply does not notify,
 * and says so, until somebody types the address in.
 */
function contactsFromTeams(teams: readonly string[]): Contact[] {
  return [...new Set(teams)].sort().map((team) => ({
    id: `team-${slug(team)}`,
    name: team,
    company: team,
    trade: null,
    email: null,
    phone: null,
  }));
}

export function seedDoc(now: Date = new Date()): ScheduleDoc {
  const sections: Section[] = raw.sections.map((name, index) => ({
    id: slug(name),
    name,
    order: index,
  }));
  const sectionByName = new Map(sections.map((s) => [s.name, s.id]));

  const teams = raw.tasks
    .map((t) => t.team)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const contacts = contactsFromTeams(teams);
  const contactByTeam = new Map(contacts.map((c) => [c.name, c.id]));

  const tasks: Activity[] = raw.tasks.map((t) => ({
    id: t.id,
    sectionId: sectionByName.get(t.section ?? "") ?? sections[0].id,
    name: t.name,
    team: t.team ?? null,
    contactId: t.team ? (contactByTeam.get(t.team) ?? null) : null,
    startDate: t.startDate ?? null,
    durationDays: t.durationDays,
    status: t.status as TaskStatus,
    notes: null,
    order: t.order,
  }));

  return {
    version: 1,
    updatedAt: now.toISOString(),
    project: {
      name: raw.project.name,
      client: raw.project.client,
      address: null,
      timezone: raw.project.timezone,
    },
    calendar: {
      workingDays: raw.calendar.workingDays as IsoWeekday[],
      holidays: raw.calendar.holidays,
    },
    sections,
    tasks,
    deps: raw.deps.map((d) => ({
      predecessorId: d.predecessorId,
      successorId: d.successorId,
      depType: d.depType as "FS" | "SS" | "FF" | "SF",
      lagDays: d.lagDays,
    })),
    contacts,
    changeLog: [],
    // 24 bytes of base64url. Long enough that the read-only link cannot be
    // guessed or walked, short enough to survive being texted to a foreman.
    share: { token: randomBytes(18).toString("base64url"), enabled: true },
  };
}
