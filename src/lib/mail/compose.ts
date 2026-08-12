import { humanDay as humanDate, humanRange } from "@/lib/format-date";
import { todayInZone } from "@/lib/schedule";
import type { Activity, Contact, Move, ScheduleDoc } from "@/lib/store/types";

export { humanDay as humanDate, humanRange } from "@/lib/format-date";

/**
 * What the subcontractor actually reads.
 *
 * The client asked for one thing here: when a date changes, mail the people it
 * affects, and say *why*. So the reason is not a footnote — it is the second
 * line of the message, above the dates, because it is the part that decides
 * whether the reader is annoyed or informed.
 *
 * Pure functions on plain values: no store, no network. The wording is a
 * product decision and deserves tests that do not need either.
 */

export type ComposedNotification = {
  contact: Contact;
  tasks: Activity[];
  subject: string;
  text: string;
};

function signOff(doc: ScheduleDoc): string {
  const who = doc.project.client ? `${doc.project.name} — ${doc.project.client}` : doc.project.name;
  return `\n${who}\nThis is an automatic note from the job schedule.`;
}

/**
 * Group the moves by who needs to hear about them, and write each one a note.
 *
 * Grouping matters. A cascade of eight tasks across three trades is three
 * emails, not eight — a sub who gets four separate messages about the same
 * slip stops reading them.
 *
 * Deliberately skipped, and why:
 *
 *   · a task with no contact, or a contact with no address — never guess one
 *   · a task that ends up with no date — there is nothing to tell anyone
 *   · a task whose dates did not actually change
 *
 * The caller records the skips against the change so they are visible in the
 * app rather than being silently absent.
 */
export function composeNotifications(
  doc: ScheduleDoc,
  moves: readonly Move[],
  reason: string | null,
): { notify: ComposedNotification[]; skipped: { task: Activity; why: string }[] } {
  const taskById = new Map(doc.tasks.map((t) => [t.id, t]));
  const contactById = new Map(doc.contacts.map((c) => [c.id, c]));

  const byContact = new Map<string, { contact: Contact; moves: Move[]; tasks: Activity[] }>();
  const skipped: { task: Activity; why: string }[] = [];

  for (const move of moves) {
    const task = taskById.get(move.taskId);
    if (!task) continue;

    if (move.fromStartDate === move.toStartDate && move.fromEndDate === move.toEndDate) {
      continue;
    }

    if (!move.toStartDate) {
      skipped.push({ task, why: "it has no date, so there is nothing to tell anyone" });
      continue;
    }
    if (!task.contactId) {
      skipped.push({ task, why: `no contact is set for ${task.team ?? "this activity"}` });
      continue;
    }
    const contact = contactById.get(task.contactId);
    if (!contact) {
      skipped.push({ task, why: "its contact no longer exists" });
      continue;
    }
    if (!contact.email) {
      skipped.push({ task, why: `${contact.name} has no email address on file` });
      continue;
    }

    const bucket = byContact.get(contact.id) ?? { contact, moves: [], tasks: [] };
    bucket.moves.push(move);
    bucket.tasks.push(task);
    byContact.set(contact.id, bucket);
  }

  const notify: ComposedNotification[] = [...byContact.values()].map(
    ({ contact, moves: theirs, tasks }) => {
      const lines: string[] = [];
      lines.push(`Hi ${contact.name.split(/[\s/]/)[0]},`);
      lines.push("");
      lines.push(
        theirs.length === 1
          ? `A date has changed on ${doc.project.name}.`
          : `${theirs.length} dates have changed on ${doc.project.name}.`,
      );

      if (reason) {
        lines.push("");
        lines.push(`Reason: ${reason}`);
      }

      lines.push("");
      for (const move of theirs) {
        const to = move.toStartDate
          ? humanRange(move.toStartDate, move.toEndDate)
          : "no date yet";
        const from = move.fromStartDate
          ? humanRange(move.fromStartDate, move.fromEndDate)
          : "no date yet";
        lines.push(`  ${move.taskName}`);
        lines.push(`    was ${from}`);
        lines.push(`    now ${to}`);
        // A task that only moved because something upstream did is worth
        // flagging: the reason given will be about that other trade, and
        // without this the message reads as a non sequitur.
        if (!move.direct) lines.push(`    (moved to stay in step with the work before it)`);
        lines.push("");
      }

      lines.push("Reply to this message if that does not work for you.");
      lines.push(signOff(doc));

      const subject =
        theirs.length === 1
          ? `${doc.project.name}: ${theirs[0].taskName} moved to ${
              theirs[0].toStartDate ? humanDate(theirs[0].toStartDate) : "a new date"
            }`
          : `${doc.project.name}: ${theirs.length} dates changed`;

      return { contact, tasks, subject, text: lines.join("\n") };
    },
  );

  // Stable order so a retry produces the same idempotency keys.
  notify.sort((a, b) => a.contact.id.localeCompare(b.contact.id));
  return { notify, skipped };
}

/**
 * A stable key for one notification.
 *
 * Built from the change it belongs to and the recipient, so retrying a failed
 * batch cannot re-send the ones that already went. Deliberately not
 * time-based: a key that includes `Date.now()` is a key that never matches on
 * retry, which is the same as having no idempotency at all.
 */
export function idempotencyKey(changeId: string, contactId: string): string {
  return `${changeId}:${contactId}`;
}

/** Today's date in the project's zone, for "as of" lines. */
export function todayLabel(doc: ScheduleDoc, now = new Date()): string {
  return humanDate(todayInZone(doc.project.timezone, now));
}
