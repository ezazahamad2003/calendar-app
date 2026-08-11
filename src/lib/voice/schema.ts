import { z } from "zod";

/**
 * The Plan contract (SPEC §5): what the planner model must return, validated
 * with Zod before anything reads it (SPEC §8 — every OpenAI response is
 * validated before use). Nothing in a Plan executes; it is a proposal the
 * user confirms.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * `HH:MM`, 24-hour. The pairing rules — an end needs a start, and it has to be
 * later — are enforced in validate.ts rather than here, so a model that gets
 * one wrong reads a sentence explaining it and tries again instead of hitting
 * a regex.
 */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Ids must come from the supplied context; validated against it after parse
 *  (a hallucinated id is a hard failure, not a silent skip — SPEC §5). */
const id = z.string().min(1);

/** #rrggbb, the only color form the projects table accepts. */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const operationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_project"),
    name: z.string().trim().min(1).max(160),
    clientName: z.string().trim().max(120).nullish(),
    address: z.string().trim().max(200).nullish(),
    jobNumber: z.string().trim().max(40).nullish(),
    startsOn: isoDate.nullish(),
    /** Only when the user actually asked for one; otherwise the name hash. */
    color: hexColor.nullish(),
  }),
  z.object({
    type: z.literal("create_task"),
    /** An existing project id, or "$pN" for one created in this same plan. */
    projectId: id,
    name: z.string().trim().min(1).max(160),
    trade: z.string().trim().max(60).nullish(),
    startDate: isoDate.nullish(),
    /** The on-site window, repeated on each day the task runs. Both or neither. */
    startTime: clockTime.nullish(),
    endTime: clockTime.nullish(),
    durationDays: z.number().int().min(1).max(365).default(1),
    isMilestone: z.boolean().default(false),
    assigneeId: id.nullish(),
    /** Predecessor task ids (FS, no lag) — existing ids or "$tN" temp refs. */
    deps: z.array(id).max(8).default([]),
  }),
  /**
   * Edits to things that already exist. Separate from the create operations
   * because the model reached for `create_project` when asked to rename one —
   * it had no way to say "change this", so it said "make another".
   *
   * Every field is optional and only applied when present, so "rename it" does
   * not quietly blank the client name.
   */
  z.object({
    type: z.literal("update_project"),
    projectId: id,
    name: z.string().trim().min(1).max(160).nullish(),
    clientName: z.string().trim().max(120).nullish(),
    address: z.string().trim().max(200).nullish(),
    jobNumber: z.string().trim().max(40).nullish(),
    status: z.enum(["active", "complete", "on_hold"]).nullish(),
    color: hexColor.nullish(),
  }),
  z.object({
    type: z.literal("update_task"),
    taskId: id,
    name: z.string().trim().min(1).max(160).nullish(),
    trade: z.string().trim().max(60).nullish(),
    /**
     * Times, with an explicit way to take them off again. `null` means "leave
     * this alone" like every other field here, so clearing needs its own flag
     * — otherwise "make that an all-day job" has no expression at all.
     */
    startTime: clockTime.nullish(),
    endTime: clockTime.nullish(),
    clearTimes: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("update_contact"),
    contactId: id,
    name: z.string().trim().min(1).max(120).nullish(),
    company: z.string().trim().max(120).nullish(),
    trade: z.string().trim().max(60).nullish(),
    email: z.string().trim().max(200).nullish(),
    phone: z.string().trim().max(40).nullish(),
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
  /**
   * Removals.
   *
   * The assistant could add and amend but never take away, so the schedule
   * only ever grew and its own mistakes were the user's to clean up by hand.
   * These go through the same diff-then-confirm gate as everything else; what
   * makes them safe is not that the model is forbidden to propose them, it is
   * that a person reads what goes with them first.
   *
   * Never a temp id: you cannot delete something this same plan is creating,
   * and a plan that tries is confused rather than clever.
   */
  z.object({ type: z.literal("delete_project"), projectId: id }),
  z.object({ type: z.literal("delete_task"), taskId: id }),
  z.object({ type: z.literal("delete_contact"), contactId: id }),
  z.object({ type: z.literal("unassign_task"), taskId: id, contactId: id }),
  z.object({
    type: z.literal("remove_dependency"),
    predecessorId: id,
    successorId: id,
  }),
]);

export type Operation = z.infer<typeof operationSchema>;

export const planSchema = z.object({
  /** One sentence, read back to the user before they confirm. */
  summary: z.string().trim().min(1).max(300),
  operations: z.array(operationSchema).max(20),
  /**
   * A question that must be answered before anything can safely happen —
   * which Tom, which project, what address. Blocks: operations must be empty.
   */
  clarification: z.string().trim().max(400).nullish(),
  /**
   * What was dropped while doing the rest — a request for times of day, say,
   * when the app schedules by whole days. Does NOT block; the plan still
   * applies, and this is shown alongside it.
   *
   * The distinction is the whole point: "which Alex did you mean" cannot be
   * guessed, but "I ignored the 8pm" is worth saying and not worth stopping
   * for. Collapsing the two is why asking for a project with times attached
   * used to create nothing at all.
   */
  notes: z.string().trim().max(400).nullish(),
  confidence: z.enum(["high", "low"]),
});

export type Plan = z.infer<typeof planSchema>;
