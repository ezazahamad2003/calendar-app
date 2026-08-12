import { endDateOf } from "@/lib/chart";
import { todayInZone } from "@/lib/schedule";
import type { ScheduleDoc } from "@/lib/store/types";

/**
 * What the assistant is told about the job.
 *
 * The whole document, trimmed. That is affordable here in a way it was not
 * under the old multi-project model: one job, thirty-five activities, fifteen
 * teams. Everything fits in the prompt, so there is no "which project did they
 * mean" step and no chance of the model reasoning about a task it was not
 * shown.
 *
 * Two things are deliberately shaped rather than passed through:
 *
 *   · Finish dates are computed here, by the engine, and handed over as
 *     values. Asked to work out "three working days from Friday the 14th" a
 *     model gets it wrong often enough to matter, and the error is invisible
 *     in the transcript.
 *   · Email addresses are never included — only whether one exists. The model
 *     has no need for the address and every reason not to be able to recite
 *     one into a message body.
 */

export type AssistantContext = {
  today: string;
  timezone: string;
  projectName: string;
  client: string | null;
  workingDays: number[];
  holidays: string[];
  sections: { id: string; name: string }[];
  tasks: {
    id: string;
    name: string;
    section: string;
    team: string | null;
    contactId: string | null;
    start: string | null;
    end: string | null;
    days: number;
    status: string;
    notes: string | null;
  }[];
  deps: { from: string; to: string; type: string; lag: number }[];
  contacts: {
    id: string;
    name: string;
    company: string | null;
    trade: string | null;
    /** Never the address itself. */
    hasEmail: boolean;
  }[];
};

export function buildContext(doc: ScheduleDoc, now: Date = new Date()): AssistantContext {
  const sectionName = new Map(doc.sections.map((s) => [s.id, s.name]));

  return {
    today: todayInZone(doc.project.timezone, now),
    timezone: doc.project.timezone,
    projectName: doc.project.name,
    client: doc.project.client,
    workingDays: [...doc.calendar.workingDays],
    holidays: [...doc.calendar.holidays],
    sections: doc.sections
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ id: s.id, name: s.name })),
    tasks: doc.tasks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => ({
        id: t.id,
        name: t.name,
        section: sectionName.get(t.sectionId) ?? "",
        team: t.team,
        contactId: t.contactId,
        start: t.startDate,
        end: endDateOf(t, doc.calendar),
        days: t.durationDays,
        status: t.status,
        notes: t.notes,
      })),
    deps: doc.deps.map((d) => ({
      from: d.predecessorId,
      to: d.successorId,
      type: d.depType,
      lag: d.lagDays,
    })),
    contacts: doc.contacts.map((c) => ({
      id: c.id,
      name: c.name,
      company: c.company,
      trade: c.trade,
      hasEmail: Boolean(c.email),
    })),
  };
}
