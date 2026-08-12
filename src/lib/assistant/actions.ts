"use server";

import { revalidatePath } from "next/cache";

import { requireOwner } from "@/lib/auth";
import { commitPlan } from "@/lib/ops/commit";
import { buildPreview } from "@/lib/ops/preview";
import { planSchema } from "@/lib/ops/schema";
import type { Plan } from "@/lib/ops/schema";
import type { Preview } from "@/lib/ops/preview";
import { validatePlan } from "@/lib/ops/validate";
import { readDoc } from "@/lib/store";
import { AgentError, converse } from "./agent";
import type { Turn } from "./agent";
import { buildContext } from "./context";

/**
 * The assistant's two server actions: ask, then confirm.
 *
 * Both start with `requireOwner()`. A server action is reachable by POST
 * without ever rendering a page, so the proxy's redirect is not a gate — this
 * is. Anyone holding only the read-only share link fails here.
 */

export type AskResult = {
  reply: string;
  /** The proposal, if there is one. Carried back on confirm. */
  plan: Plan | null;
  preview: Preview | null;
  turns: Turn[];
  error?: string;
};

export async function ask(text: string, history: Turn[]): Promise<AskResult> {
  await requireOwner();

  const said = text.trim();
  if (!said) {
    return { reply: "", plan: null, preview: null, turns: history, error: "Nothing was said." };
  }

  const doc = await readDoc();

  let result;
  try {
    result = await converse(said, history, buildContext(doc));
  } catch (err) {
    return {
      reply: "",
      plan: null,
      preview: null,
      turns: history,
      error:
        err instanceof AgentError
          ? err.message
          : "The assistant is not available right now. Try again in a moment.",
    };
  }

  if (!result.plan || result.plan.operations.length === 0) {
    return { reply: result.reply, plan: null, preview: null, turns: result.turns };
  }

  // Ids are checked in code, against the document, never trusted from the
  // model. A hallucinated id is a hard failure — silently skipping the
  // operation would turn "push framing and roofing" into "push roofing" and
  // report success.
  const check = validatePlan(doc, result.plan);
  if (!check.ok) {
    return {
      reply: result.reply,
      plan: null,
      preview: null,
      turns: result.turns,
      error: `That proposal referred to something that is not on this job:\n${check.problems.join("\n")}`,
    };
  }

  return {
    reply: result.reply,
    plan: result.plan,
    // Every date on the confirmation screen comes from the schedule engine
    // here, not from the model's description of what it intends.
    preview: buildPreview(doc, result.plan),
    turns: result.turns,
  };
}

export type ConfirmResult = {
  ok: boolean;
  message: string;
  /** Set when mail was composed but no mail service is configured. */
  simulated?: boolean;
};

/**
 * Apply a plan the user has read and confirmed.
 *
 * The plan arrives from the browser, so it is revalidated from scratch:
 * re-parsed against the schema, re-checked against the document as it is *now*
 * (not as it was when the preview was built), and only then applied. Trusting
 * the round-tripped object would make the confirm button an arbitrary write
 * endpoint.
 */
export async function confirm(
  plan: unknown,
  options: {
    reason: string | null;
    notify: boolean;
    /** What was said, when it was spoken. Null for a typed change. */
    transcript: string | null;
    source: "voice" | "ui";
  },
): Promise<ConfirmResult> {
  await requireOwner();

  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) {
    return { ok: false, message: "That change is no longer valid. Ask for it again." };
  }
  if (parsed.data.operations.length === 0) {
    return { ok: false, message: "There was nothing to change." };
  }

  const doc = await readDoc();
  const check = validatePlan(doc, parsed.data);
  if (!check.ok) {
    return {
      ok: false,
      message:
        "The schedule changed since that was proposed, and it no longer fits:\n" +
        check.problems.join("\n"),
    };
  }

  const reason = options.reason?.trim() || parsed.data.reason?.trim() || null;

  try {
    const result = await commitPlan({
      operations: parsed.data.operations,
      summary: parsed.data.summary,
      reason,
      source: options.source,
      transcript: options.transcript,
      notify: options.notify,
    });

    revalidatePath("/", "layout");

    const parts: string[] = [];
    const moved = result.change.moves.length;
    parts.push(moved === 1 ? "1 activity changed" : `${moved} activities changed`);
    if (result.sent > 0) parts.push(`${result.sent} notified`);
    if (result.failed > 0) parts.push(`${result.failed} failed to send`);
    if (result.skipped > 0) parts.push(`${result.skipped} not notified`);

    return {
      ok: true,
      message: parts.join(", ") + ".",
      simulated: result.simulated,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "That change could not be saved.",
    };
  }
}
