import { z } from "zod";

import { TASK_STATUSES } from "@/lib/store/types";

/**
 * Everything that can happen to the schedule.
 *
 * This is the whole vocabulary — the UI and the assistant both speak it, and
 * nothing changes the document except by producing one of these and having a
 * person confirm it.
 *
 * Two properties matter more than completeness:
 *
 *   · **Adding is not moving.** `add_activity` and `move_activity` are
 *     separate operations with no overlap. An assistant that cannot express
 *     "put a new plumbing job on Tuesday" will reach for the nearest thing it
 *     can express, and the nearest thing is moving the plumbing job that
 *     already exists — which cancels a crew instead of booking one.
 *   · **The vocabulary is small.** Anything not here cannot be described, and
 *     an assistant that cannot describe what was asked must say so rather than
 *     approximate. Every operation added is a new way to be misunderstood.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1);

export const operationSchema = z.discriminatedUnion("type", [
  /**
   * The one the client described: "they didn't come, push it two days."
   *
   * Separate from `move_activity` because it is the common case and because
   * the arithmetic belongs on this side — a model asked to compute "two
   * working days after the 14th" over a weekend gets it wrong often enough to
   * matter, and the mistake is invisible in the transcript.
   */
  z.object({
    type: z.literal("push_activity"),
    taskId: id,
    /** Work days. Negative pulls it earlier. */
    byDays: z.number().int().min(-260).max(260).refine((n) => n !== 0, {
      message: "A push of zero days is not a change.",
    }),
  }),
  z.object({ type: z.literal("move_activity"), taskId: id, startDate: isoDate }),
  z.object({
    type: z.literal("resize_activity"),
    taskId: id,
    durationDays: z.number().int().min(1).max(365),
  }),
  z.object({
    type: z.literal("set_status"),
    taskId: id,
    status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]),
  }),
  /** Take a date off entirely — back to the chart's undated backlog. */
  z.object({ type: z.literal("clear_dates"), taskId: id }),
  z.object({
    type: z.literal("add_activity"),
    sectionId: id.nullish(),
    name: z.string().trim().min(1).max(160),
    team: z.string().trim().max(80).nullish(),
    startDate: isoDate.nullish(),
    durationDays: z.number().int().min(1).max(365).default(1),
    status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).default("planned"),
    /** Existing activity ids this one follows, FS with no lag. */
    after: z.array(id).max(8).default([]),
  }),
  z.object({ type: z.literal("remove_activity"), taskId: id }),
  z.object({
    type: z.literal("rename_activity"),
    taskId: id,
    name: z.string().trim().min(1).max(160),
  }),
  z.object({
    type: z.literal("set_team"),
    taskId: id,
    /** Null takes the trade off the row. */
    team: z.string().trim().max(80).nullable(),
    contactId: id.nullish(),
  }),
  z.object({
    type: z.literal("set_notes"),
    taskId: id,
    notes: z.string().trim().max(2000).nullable(),
  }),
  z.object({
    type: z.literal("add_dependency"),
    predecessorId: id,
    successorId: id,
    depType: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
    lagDays: z.number().int().min(-60).max(365).default(0),
  }),
  z.object({
    type: z.literal("remove_dependency"),
    predecessorId: id,
    successorId: id,
  }),
  z.object({
    type: z.literal("update_contact"),
    contactId: id,
    name: z.string().trim().min(1).max(120).nullish(),
    company: z.string().trim().max(120).nullish(),
    trade: z.string().trim().max(60).nullish(),
    email: z.email().nullish(),
    phone: z.string().trim().max(40).nullish(),
  }),
  z.object({
    type: z.literal("add_contact"),
    name: z.string().trim().min(1).max(120),
    company: z.string().trim().max(120).nullish(),
    trade: z.string().trim().max(60).nullish(),
    email: z.email().nullish(),
    phone: z.string().trim().max(40).nullish(),
  }),
]);

export type Operation = z.infer<typeof operationSchema>;

export const planSchema = z.object({
  /** One sentence, read back before anything is confirmed. */
  summary: z.string().trim().min(1).max(300),
  /**
   * Why the schedule is changing, in the words the subcontractor will read.
   * The client asked for this specifically — the email says what moved *and*
   * why. Null when the request carried no reason; the UI then asks for one.
   */
  reason: z.string().trim().max(300).nullish(),
  operations: z.array(operationSchema).max(20),
  /**
   * A question that has to be answered before anything can safely happen.
   * Blocking: when set, `operations` must be empty.
   */
  clarification: z.string().trim().max(400).nullish(),
  /**
   * What was left out while doing the rest — a request the vocabulary above
   * cannot express. Not blocking, and shown beside the diff.
   *
   * The distinction from `clarification` is the point: "which Tom" cannot be
   * guessed and must stop everything; "I ignored the bit about the crane"
   * must be said but must not throw away the rest of the work.
   */
  notes: z.string().trim().max(400).nullish(),
  confidence: z.enum(["high", "low"]),
});

export type Plan = z.infer<typeof planSchema>;
