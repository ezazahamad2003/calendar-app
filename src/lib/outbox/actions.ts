"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireMembership } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { dispatchOne } from "./dispatch";

/**
 * Outbox (SPEC §7): queued and sent messages, editable before send.
 *
 * Idempotency exactly as SPEC §6 prescribes: the outbound_messages row exists
 * (with its key) *before* any Graph call, and sending re-checks the current
 * status first. A duplicate invite to a subcontractor is a support call.
 */

const editSchema = z.object({
  id: z.uuid(),
  subject: z.string().trim().min(1, "Subject is required").max(200),
  body: z.string().trim().min(1, "Body is required").max(4000),
});

export async function updateMessage(input: {
  id: string;
  subject: string;
  body: string;
}): Promise<{ error?: string }> {
  const m = await requireMembership();
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid edit." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("outbound_messages")
    .update({ subject: parsed.data.subject, body: parsed.data.body })
    .eq("org_id", m.orgId)
    .eq("id", parsed.data.id)
    .in("status", ["draft", "queued"]); // sent history is immutable

  if (error) return { error: `Could not save the edit: ${error.message}` };
  revalidatePath("/outbox");
  return {};
}

export async function sendMessage(input: {
  id: string;
}): Promise<{ error?: string; mocked?: boolean }> {
  const m = await requireMembership();
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Unknown message." };

  // Both channels go through the shared dispatcher — this used to refuse
  // anything that wasn't email, which meant calendar rows could be queued and
  // never sent.
  const result = await dispatchOne(parsed.data.id);

  if (!result.error) {
    const supabase = await createClient();
    await supabase.from("change_log").insert({
      org_id: m.orgId,
      actor_user_id: m.userId,
      entity_type: "outbound_message",
      entity_id: parsed.data.id,
      action: result.mocked ? "send_mock" : "send",
      source: "ui",
    });
  }

  revalidatePath("/outbox");
  return result;
}

/** Failed → queued again, after the user has seen the error. */
export async function requeueMessage(input: { id: string }): Promise<{ error?: string }> {
  const m = await requireMembership();
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Unknown message." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("outbound_messages")
    .update({ status: "queued", error: null })
    .eq("org_id", m.orgId)
    .eq("id", parsed.data.id)
    .eq("status", "failed");
  if (error) return { error: `Could not requeue: ${error.message}` };
  revalidatePath("/outbox");
  return {};
}
