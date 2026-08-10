import { z } from "zod";

/**
 * The Plan contract (SPEC §5): what the planner model must return, validated
 * with Zod before anything reads it (SPEC §8 — every OpenAI response is
 * validated before use). Nothing in a Plan executes; it is a proposal the
 * user confirms.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Ids must come from the supplied context; validated against it after parse
 *  (a hallucinated id is a hard failure, not a silent skip — SPEC §5). */
const id = z.string().min(1);

export const operationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_task"),
    projectId: id,
    name: z.string().trim().min(1).max(160),
    trade: z.string().trim().max(60).nullish(),
    startDate: isoDate.nullish(),
    durationDays: z.number().int().min(1).max(365).default(1),
    isMilestone: z.boolean().default(false),
    assigneeId: id.nullish(),
    /** Predecessor task ids (FS, no lag) — existing ids or "$tN" temp refs. */
    deps: z.array(id).max(8).default([]),
  }),
  z.object({ type: z.literal("move_task"), taskId: id, startDate: isoDate }),
  z.object({
    type: z.literal("shift_task"),
    taskId: id,
    byDays: z.number().int().min(-260).max(260),
  }),
  z.object({
    type: z.literal("resize_task"),
    taskId: id,
    durationDays: z.number().int().min(1).max(365),
  }),
  z.object({ type: z.literal("assign_task"), taskId: id, contactId: id }),
  z.object({
    type: z.literal("set_status"),
    taskId: id,
    status: z.enum(["planned", "active", "blocked", "done"]),
  }),
  z.object({
    type: z.literal("add_dependency"),
    predecessorId: id,
    successorId: id,
    depType: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
    lagDays: z.number().int().min(-60).max(365).default(0),
  }),
  z.object({
    type: z.literal("shift_project"),
    projectId: id,
    byDays: z.number().int().min(-260).max(260),
  }),
  z.object({
    type: z.literal("send_email"),
    contactIds: z.array(id).min(1).max(10),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    taskId: id.nullish(),
  }),
  z.object({
    type: z.literal("create_contact"),
    name: z.string().trim().min(1).max(120),
    company: z.string().trim().max(120).nullish(),
    trade: z.string().trim().max(60).nullish(),
    email: z.string().trim().max(200).nullish(),
    phone: z.string().trim().max(40).nullish(),
  }),
]);

export type Operation = z.infer<typeof operationSchema>;

export const planSchema = z.object({
  /** One sentence, read back to the user before they confirm. */
  summary: z.string().trim().min(1).max(300),
  operations: z.array(operationSchema).max(20),
  /** Set when the request is ambiguous — and then operations must be empty. */
  clarification: z.string().trim().max(400).nullish(),
  confidence: z.enum(["high", "low"]),
});

export type Plan = z.infer<typeof planSchema>;
