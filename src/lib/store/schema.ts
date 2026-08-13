import { z } from "zod";

import { TASK_STATUSES } from "./types";
import type { ScheduleDoc } from "./types";

/**
 * The document, validated on the way in.
 *
 * The store is a JSON blob on a URL rather than a database with column types,
 * so nothing else checks its shape. A hand-edited file, a half-written blob, or
 * a document from an older build all arrive here looking like `unknown`, and
 * the app has to find out now rather than three components deep when
 * `task.durationDays` turns out to be a string.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoWeekday = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);

export const sectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  order: z.number().int(),
});

export const activitySchema = z.object({
  id: z.string().min(1),
  sectionId: z.string().min(1),
  name: z.string().min(1).max(160),
  team: z.string().max(80).nullable(),
  contactId: z.string().min(1).nullable(),
  startDate: isoDate.nullable(),
  durationDays: z.number().int().min(1).max(365),
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]),
  notes: z.string().max(2000).nullable(),
  order: z.number().int(),
});

export const contactSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  company: z.string().max(120).nullable(),
  trade: z.string().max(60).nullable(),
  email: z.email().nullable(),
  phone: z.string().max(40).nullable(),
});

export const depSchema = z.object({
  predecessorId: z.string().min(1),
  successorId: z.string().min(1),
  depType: z.enum(["FS", "SS", "FF", "SF"]),
  lagDays: z.number().int().min(-365).max(365),
});

export const moveSchema = z.object({
  taskId: z.string().min(1),
  taskName: z.string(),
  fromStartDate: isoDate.nullable(),
  toStartDate: isoDate.nullable(),
  fromEndDate: isoDate.nullable(),
  toEndDate: isoDate.nullable(),
  direct: z.boolean(),
});

export const notificationSchema = z.object({
  id: z.string().min(1),
  contactId: z.string().nullable(),
  to: z.string().nullable(),
  recipientName: z.string(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(["queued", "sent", "failed", "skipped"]),
  error: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  idempotencyKey: z.string().min(1),
});

export const changeEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  summary: z.string(),
  reason: z.string().nullable(),
  source: z.enum(["voice", "ui"]),
  transcript: z.string().nullable(),
  moves: z.array(moveSchema),
  notifications: z.array(notificationSchema),
});

export const scheduleDocSchema = z.object({
  version: z.number().int().min(0),
  updatedAt: z.string(),
  project: z.object({
    name: z.string().min(1).max(160),
    client: z.string().max(120).nullable(),
    address: z.string().max(200).nullable(),
    timezone: z.string().min(1),
  }),
  calendar: z.object({
    // An empty set makes "the next working day" unanswerable and hangs every
    // date computation in the app.
    workingDays: z.array(isoWeekday).min(1),
    holidays: z.array(isoDate),
  }),
  sections: z.array(sectionSchema),
  tasks: z.array(activitySchema),
  deps: z.array(depSchema),
  contacts: z.array(contactSchema),
  changeLog: z.array(changeEntrySchema),
  share: z.object({ token: z.string().min(1), enabled: z.boolean() }),
  /**
   * Absent in documents written before mail connections existed, so this
   * defaults rather than failing. A stored schedule must never become
   * unreadable because the app gained a feature.
   */
  connection: z
    .object({
      provider: z.enum(["microsoft", "google"]),
      email: z.string().nullable(),
      providerUserId: z.string().nullable(),
      refreshTokenEncrypted: z.string().min(1),
      scopes: z.array(z.string()),
      status: z.enum(["active", "needs_reauth"]),
      connectedAt: z.string(),
      lastRefreshedAt: z.string().nullable(),
    })
    .nullish()
    .transform((v) => v ?? null),
});

/**
 * Parse a document read from storage.
 *
 * Referential integrity is checked here too, not just field types: a task
 * pointing at a section that no longer exists renders nowhere and looks to the
 * user like data loss, and a dependency naming a deleted task makes `cascade`
 * throw somewhere far away from the cause.
 */
export function parseDoc(value: unknown): ScheduleDoc {
  const doc = scheduleDocSchema.parse(value) as ScheduleDoc;

  const sectionIds = new Set(doc.sections.map((s) => s.id));
  const taskIds = new Set(doc.tasks.map((t) => t.id));
  const contactIds = new Set(doc.contacts.map((c) => c.id));

  const problems: string[] = [];

  if (taskIds.size !== doc.tasks.length) problems.push("duplicate task ids");
  if (sectionIds.size !== doc.sections.length) problems.push("duplicate section ids");
  if (contactIds.size !== doc.contacts.length) problems.push("duplicate contact ids");

  for (const task of doc.tasks) {
    if (!sectionIds.has(task.sectionId)) {
      problems.push(`task "${task.id}" is in unknown section "${task.sectionId}"`);
    }
    if (task.contactId && !contactIds.has(task.contactId)) {
      problems.push(`task "${task.id}" names unknown contact "${task.contactId}"`);
    }
  }
  for (const dep of doc.deps) {
    if (!taskIds.has(dep.predecessorId)) {
      problems.push(`dependency names unknown task "${dep.predecessorId}"`);
    }
    if (!taskIds.has(dep.successorId)) {
      problems.push(`dependency names unknown task "${dep.successorId}"`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Schedule document is inconsistent:\n  • ${problems.join("\n  • ")}`);
  }

  return doc;
}
