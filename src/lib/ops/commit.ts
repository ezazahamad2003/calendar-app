import "server-only";

import { randomUUID } from "node:crypto";

import { composeNotifications, idempotencyKey } from "@/lib/mail/compose";
import { mailer } from "@/lib/mail/client";
import { writeDoc } from "@/lib/store";
import type { ChangeEntry, Notification, ScheduleDoc } from "@/lib/store/types";
import { applyOperations } from "./apply";
import type { Operation } from "./schema";

/**
 * Commit a confirmed plan.
 *
 * This is the only function in the application that changes the schedule.
 * Everything else — the assistant, the preview, the chart — reads. That is not
 * tidiness: it is the property that makes "nothing happens until you tap
 * Confirm" true by construction rather than by everyone remembering.
 *
 * Order matters and is deliberate:
 *
 *   1. Apply the operations and store the result, with the notifications
 *      recorded as `queued`.
 *   2. Only then send.
 *   3. Store the outcome of each send.
 *
 * The rows exist before any mail leaves, so a crash between the two leaves a
 * visible queue rather than mail nobody knows about; and a retry checks the
 * recorded status first. A subcontractor who gets the same date change twice
 * telephones about it, which costs more than the schedule being a second late.
 */

/** Enough to settle an argument, not so much that the document bloats. */
const MAX_CHANGE_LOG = 200;

export type CommitInput = {
  operations: readonly Operation[];
  summary: string;
  reason: string | null;
  source: "voice" | "ui";
  transcript: string | null;
  /** False sends nothing and records why — the "just change it quietly" case. */
  notify: boolean;
};

export type CommitResult = {
  doc: ScheduleDoc;
  change: ChangeEntry;
  sent: number;
  failed: number;
  skipped: number;
  /** True when mail was composed but the mailer does not actually deliver. */
  simulated: boolean;
};

export async function commitPlan(input: CommitInput): Promise<CommitResult> {
  const changeId = randomUUID();
  const at = new Date().toISOString();

  // ── 1. Apply and store ──────────────────────────────────────────────────────

  let change: ChangeEntry | null = null;

  const stored = await writeDoc((current) => {
    const result = applyOperations(current, input.operations);
    const { notify, skipped } = composeNotifications(
      result.doc,
      result.moves,
      input.reason,
    );

    const notifications: Notification[] = [];

    if (input.notify) {
      for (const composed of notify) {
        notifications.push({
          id: randomUUID(),
          contactId: composed.contact.id,
          to: composed.contact.email,
          recipientName: composed.contact.name,
          subject: composed.subject,
          body: composed.text,
          status: "queued",
          error: null,
          createdAt: at,
          sentAt: null,
          idempotencyKey: idempotencyKey(changeId, composed.contact.id),
        });
      }
    }

    // Everything not being mailed is recorded as a skip with its reason, so
    // "who did we tell?" has an answer that includes the people we did not.
    for (const skip of skipped) {
      notifications.push({
        id: randomUUID(),
        contactId: null,
        to: null,
        recipientName: skip.task.team ?? skip.task.name,
        subject: `Not notified: ${skip.task.name}`,
        body: "",
        status: "skipped",
        error: skip.why,
        createdAt: at,
        sentAt: null,
        idempotencyKey: idempotencyKey(changeId, `skip-${skip.task.id}`),
      });
    }

    if (!input.notify && notify.length > 0) {
      for (const composed of notify) {
        notifications.push({
          id: randomUUID(),
          contactId: composed.contact.id,
          to: composed.contact.email,
          recipientName: composed.contact.name,
          subject: composed.subject,
          body: composed.text,
          status: "skipped",
          error: "Nobody was notified — that was turned off for this change.",
          createdAt: at,
          sentAt: null,
          idempotencyKey: idempotencyKey(changeId, composed.contact.id),
        });
      }
    }

    change = {
      id: changeId,
      at,
      summary: input.summary,
      reason: input.reason,
      source: input.source,
      transcript: input.transcript,
      moves: result.moves,
      notifications,
    };

    return {
      ...result.doc,
      changeLog: [change, ...current.changeLog].slice(0, MAX_CHANGE_LOG),
    };
  });

  if (!change) throw new Error("The change was not recorded.");

  // ── 2. Send ─────────────────────────────────────────────────────────────────

  const post = mailer();
  const queued = (change as ChangeEntry).notifications.filter((n) => n.status === "queued");
  const outcomes = new Map<string, { status: Notification["status"]; error: string | null }>();

  for (const notification of queued) {
    if (!notification.to) {
      outcomes.set(notification.id, {
        status: "skipped",
        error: "No email address.",
      });
      continue;
    }

    const result = await post.send({
      to: notification.to,
      toName: notification.recipientName,
      subject: notification.subject,
      text: notification.body,
    });

    outcomes.set(
      notification.id,
      result.ok
        ? { status: "sent", error: null }
        : { status: "failed", error: result.error },
    );
  }

  // ── 3. Record what happened ─────────────────────────────────────────────────

  const sentAt = new Date().toISOString();
  const finalDoc =
    outcomes.size === 0
      ? stored
      : await writeDoc((current) => ({
          ...current,
          changeLog: current.changeLog.map((entry) =>
            entry.id !== changeId
              ? entry
              : {
                  ...entry,
                  notifications: entry.notifications.map((n) => {
                    const outcome = outcomes.get(n.id);
                    // Idempotency: a row already marked sent is never
                    // reconsidered, whatever this pass decided.
                    if (!outcome || n.status === "sent") return n;
                    return {
                      ...n,
                      status: outcome.status,
                      error: outcome.error,
                      sentAt: outcome.status === "sent" ? sentAt : null,
                    };
                  }),
                },
          ),
        }));

  const finalChange =
    finalDoc.changeLog.find((c) => c.id === changeId) ?? (change as ChangeEntry);

  return {
    doc: finalDoc,
    change: finalChange,
    sent: finalChange.notifications.filter((n) => n.status === "sent").length,
    failed: finalChange.notifications.filter((n) => n.status === "failed").length,
    skipped: finalChange.notifications.filter((n) => n.status === "skipped").length,
    simulated: !post.delivers && queued.length > 0,
  };
}
