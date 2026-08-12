import { composeNotifications, humanRange } from "@/lib/mail/compose";
import type { ScheduleDoc } from "@/lib/store/types";
import { applyOperations } from "./apply";
import type { Operation, Plan } from "./schema";

/**
 * What the contractor reads before tapping Confirm.
 *
 * SPEC's requirement stands and is the reason this file exists separately from
 * the server action: the diff must be readable at arm's length in sunlight,
 * and it must be testable without a store, a model or a browser.
 *
 * Every date here is `cascade()`'s, by way of `applyOperations` — the same code
 * path the write takes. The model's own description of what it is about to do
 * never reaches this screen.
 */

export type PreviewLine = {
  /** "Moved", "New", "Removed", "Booked" — the tag shown against the row. */
  tag: string;
  taskName: string;
  team: string | null;
  /** "Mon 17 Aug – Wed 19 Aug" or null when it has no dates. */
  from: string | null;
  to: string | null;
  /** Indented under the activity that caused it. */
  cascaded: boolean;
  /** Work days added or removed; null when the length did not change. */
  dayShift: number | null;
};

export type PreviewRecipient = {
  name: string;
  email: string;
  taskNames: string[];
  subject: string;
  body: string;
};

export type Preview = {
  summary: string;
  reason: string | null;
  lines: PreviewLine[];
  /** Who would be emailed, and exactly what they would receive. */
  recipients: PreviewRecipient[];
  /** Why someone affected is *not* being emailed. Shown, never hidden. */
  notNotified: string[];
  /** Things that happened but are not date changes. */
  notices: string[];
  /** True when nothing at all would change. */
  empty: boolean;
};

function dayDelta(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const days = Math.round((b - a) / 86_400_000);
  return days === 0 ? null : days;
}

export function buildPreview(
  doc: ScheduleDoc,
  plan: Pick<Plan, "summary" | "reason"> & { operations: readonly Operation[] },
): Preview {
  const result = applyOperations(doc, plan.operations);
  const beforeById = new Map(doc.tasks.map((t) => [t.id, t]));
  const afterById = new Map(result.doc.tasks.map((t) => [t.id, t]));

  const lines: PreviewLine[] = result.moves.map((move) => {
    const after = afterById.get(move.taskId);
    const before = beforeById.get(move.taskId);

    const tag = !before
      ? "New"
      : !after
        ? "Removed"
        : move.fromStartDate === null
          ? "Booked"
          : move.toStartDate === null
            ? "Unscheduled"
            : "Moved";

    return {
      tag,
      taskName: move.taskName,
      team: (after ?? before)?.team ?? null,
      from: move.fromStartDate ? humanRange(move.fromStartDate, move.fromEndDate) : null,
      to: move.toStartDate ? humanRange(move.toStartDate, move.toEndDate) : null,
      cascaded: !move.direct,
      dayShift: dayDelta(move.fromStartDate, move.toStartDate),
    };
  });

  // Direct changes first, each followed by what it dragged along — the shape
  // SPEC asks for, and the shape that makes a long cascade scannable.
  lines.sort((a, b) => Number(a.cascaded) - Number(b.cascaded));

  // Changes with no date movement at all still have to appear, or a rename or
  // a status change would confirm silently.
  for (const op of plan.operations) {
    if (op.type === "rename_activity") {
      const before = beforeById.get(op.taskId);
      if (before && before.name !== op.name) {
        lines.push({
          tag: "Renamed",
          taskName: `${before.name} → ${op.name}`,
          team: before.team,
          from: null,
          to: null,
          cascaded: false,
          dayShift: null,
        });
      }
    }
    if (op.type === "set_status") {
      const before = beforeById.get(op.taskId);
      if (before && before.status !== op.status) {
        lines.push({
          tag: "Status",
          taskName: `${before.name}: ${before.status} → ${op.status}`,
          team: before.team,
          from: null,
          to: null,
          cascaded: false,
          dayShift: null,
        });
      }
    }
    if (op.type === "set_team") {
      const before = beforeById.get(op.taskId);
      if (before && before.team !== op.team) {
        lines.push({
          tag: "Team",
          taskName: `${before.name}: ${before.team ?? "nobody"} → ${op.team ?? "nobody"}`,
          team: op.team,
          from: null,
          to: null,
          cascaded: false,
          dayShift: null,
        });
      }
    }
    if (op.type === "update_contact" || op.type === "add_contact") {
      const who = op.type === "add_contact" ? op.name : op.contactId;
      lines.push({
        tag: op.type === "add_contact" ? "New contact" : "Contact",
        taskName: op.email ? `${who} — ${op.email}` : String(who),
        team: null,
        from: null,
        to: null,
        cascaded: false,
        dayShift: null,
      });
    }
  }

  // Notifications are composed against the *resulting* document so a contact
  // added or corrected in this same plan is used, not the stale one.
  const { notify, skipped } = composeNotifications(
    result.doc,
    result.moves,
    plan.reason ?? null,
  );

  return {
    summary: plan.summary,
    reason: plan.reason ?? null,
    lines,
    recipients: notify.map((n) => ({
      name: n.contact.name,
      email: n.contact.email as string,
      taskNames: n.tasks.map((t) => t.name),
      subject: n.subject,
      body: n.text,
    })),
    notNotified: skipped.map((s) => `${s.task.name} — ${s.why}`),
    notices: result.notices,
    empty: lines.length === 0,
  };
}
