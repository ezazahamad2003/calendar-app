"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireMembership } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { providerClientFor } from "@/lib/providers/factory";
import { ProviderAuthError } from "@/lib/providers/client";

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

  const supabase = await createClient();
  const { data: msg, error: loadErr } = await supabase
    .from("outbound_messages")
    .select("id, status, subject, body, contact_id, channel")
    .eq("org_id", m.orgId)
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (loadErr || !msg) return { error: "That message no longer exists." };
  // Idempotency: already sent means done, not "send again".
  if (msg.status === "sent") return {};
  if (msg.channel !== "email") return { error: "Only email sends from the outbox." };
  if (!msg.subject || !msg.body) return { error: "Give it a subject and a body first." };
  if (!msg.contact_id) return { error: "That message has no recipient." };

  const { data: contact } = await supabase
    .from("contacts")
    .select("name, email")
    .eq("org_id", m.orgId)
    .eq("id", msg.contact_id)
    .maybeSingle();

  if (!contact?.email) {
    return {
      error: `${contact?.name ?? "The recipient"} has no email address. Add one on the Crew page.`,
    };
  }

  const { client, mocked } = await providerClientFor(m.orgId, m.userId);

  try {
    const { messageId } = await client.sendMail({
      to: [{ address: contact.email, name: contact.name }],
      subject: msg.subject,
      body: msg.body,
    });

    const { error: upErr } = await supabase
      .from("outbound_messages")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        ms_message_id: messageId,
        error: null,
      })
      .eq("org_id", m.orgId)
      .eq("id", msg.id);
    if (upErr) {
      return {
        error:
          `The email went out but recording it failed: ${upErr.message}. ` +
          `Do NOT send again — refresh first.`,
      };
    }

    await supabase.from("change_log").insert({
      org_id: m.orgId,
      actor_user_id: m.userId,
      entity_type: "outbound_message",
      entity_id: msg.id,
      action: mocked ? "send_mock" : "send",
      after: { subject: msg.subject, to: contact.name },
      source: "ui",
    });

    revalidatePath("/outbox");
    return { mocked };
  } catch (err) {
    const message =
      err instanceof ProviderAuthError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Send failed.";

    await supabase
      .from("outbound_messages")
      .update({ status: "failed", error: message })
      .eq("org_id", m.orgId)
      .eq("id", msg.id);

    revalidatePath("/outbox");
    return { error: message };
  }
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
