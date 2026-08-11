import "server-only";

import { createClient } from "@/lib/supabase/server";
import { requireMembership } from "@/lib/auth/dal";
import { providerClientFor } from "@/lib/providers/factory";
import { ProviderAuthError } from "@/lib/providers/client";
import { getEnv } from "@/lib/env";

/**
 * Sending an outbound_messages row, for both channels.
 *
 * One implementation, two callers: the Outbox page's manual Send button, and
 * the voice pipeline's assignment notices, which dispatch straight after a
 * confirmed plan commits. Before this existed the outbox refused anything that
 * wasn't email, so `channel: 'calendar'` rows could be written and never sent
 * — the calendar half of the Graph seam had no caller at all.
 *
 * Idempotency exactly as SPEC §6 prescribes: the row (with its key) exists
 * before any provider call, and sending re-checks the current status first. A
 * duplicate invite to a subcontractor is a support call.
 */

export type DispatchResult = {
  sent: number;
  failed: number;
  /** No account connected — the sends were simulated, not real. */
  mocked: boolean;
};

type MessageRow = {
  id: string;
  status: string;
  channel: "email" | "calendar";
  subject: string | null;
  body: string | null;
  contact_id: string | null;
  task_id: string | null;
};

/**
 * Send specific queued messages, named by idempotency key.
 *
 * Keys rather than ids because the caller generated the keys before the rows
 * existed — they are the only handle it has on rows created inside an RPC that
 * returns a count, not a list.
 */
export async function dispatchQueued(
  orgId: string,
  userId: string,
  idempotencyKeys: string[],
): Promise<DispatchResult> {
  if (idempotencyKeys.length === 0) return { sent: 0, failed: 0, mocked: false };

  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("outbound_messages")
    .select("id, status, channel, subject, body, contact_id, task_id")
    .eq("org_id", orgId)
    .in("idempotency_key", idempotencyKeys);

  if (!rows || rows.length === 0) return { sent: 0, failed: 0, mocked: false };

  const { client, mocked } = await providerClientFor(orgId, userId);
  let sent = 0;
  let failed = 0;

  for (const row of rows as MessageRow[]) {
    const ok = await sendOne(orgId, row, client, mocked);
    if (ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed, mocked };
}

/**
 * Send one row. Returns whether it went.
 *
 * Never throws: a failed notification must not unwind the schedule change that
 * prompted it. The row carries its own error for the outbox to show.
 */
async function sendOne(
  orgId: string,
  row: MessageRow,
  client: Awaited<ReturnType<typeof providerClientFor>>["client"],
  mocked: boolean,
): Promise<boolean> {
  const supabase = await createClient();

  // Idempotency: already sent means done, not "send again".
  if (row.status === "sent") return true;
  if (!row.contact_id || !row.subject) return false;

  const fail = async (message: string) => {
    await supabase
      .from("outbound_messages")
      .update({ status: "failed", error: message })
      .eq("org_id", orgId)
      .eq("id", row.id);
    return false;
  };

  const { data: contact } = await supabase
    .from("contacts")
    .select("name, email")
    .eq("org_id", orgId)
    .eq("id", row.contact_id)
    .maybeSingle();

  if (!contact?.email) {
    return fail(
      `${contact?.name ?? "The recipient"} has no email address. Add one on the Crew page.`,
    );
  }

  try {
    if (row.channel === "email") {
      const { messageId } = await client.sendMail({
        to: [{ address: contact.email, name: contact.name }],
        subject: row.subject,
        body: row.body ?? "",
      });
      await supabase
        .from("outbound_messages")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          ms_message_id: messageId,
          error: null,
        })
        .eq("org_id", orgId)
        .eq("id", row.id);
      return true;
    }

    // ── Calendar invite ──────────────────────────────────────────────────
    //
    // Dates come from the task, not the message: the message body is prose a
    // human reads, and re-parsing dates out of it to build an event is how the
    // invite ends up disagreeing with the schedule.
    if (!row.task_id) return fail("That invite has no task to take dates from.");

    const { data: task } = await supabase
      .from("tasks")
      .select("name, start_date, end_date")
      .eq("org_id", orgId)
      .eq("id", row.task_id)
      .maybeSingle();

    if (!task?.start_date) {
      return fail("That task has no dates yet, so there is nothing to put in a calendar.");
    }

    const { data: org } = await supabase
      .from("orgs")
      .select("timezone")
      .eq("id", orgId)
      .maybeSingle();

    const { eventId } = await client.createEvent({
      subject: task.name,
      startDate: task.start_date,
      endDate: task.end_date ?? task.start_date,
      timeZone: org?.timezone ?? "UTC",
      body: row.body ?? undefined,
      attendees: getEnv().FEATURE_INVITE_ATTENDEES
        ? [{ address: contact.email, name: contact.name }]
        : undefined,
    });

    await supabase
      .from("outbound_messages")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        ms_event_id: eventId,
        error: null,
      })
      .eq("org_id", orgId)
      .eq("id", row.id);
    return true;
  } catch (err) {
    void mocked;
    return fail(
      err instanceof ProviderAuthError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Send failed.",
    );
  }
}

/** Send a single message by id — the Outbox page's Send button. */
export async function dispatchOne(
  messageId: string,
): Promise<{ error?: string; mocked?: boolean }> {
  const m = await requireMembership();
  const supabase = await createClient();

  const { data: row, error } = await supabase
    .from("outbound_messages")
    .select("id, status, channel, subject, body, contact_id, task_id")
    .eq("org_id", m.orgId)
    .eq("id", messageId)
    .maybeSingle();

  if (error || !row) return { error: "That message no longer exists." };
  if (row.status === "sent") return {};
  if (!row.subject || !row.body) return { error: "Give it a subject and a body first." };
  if (!row.contact_id) return { error: "That message has no recipient." };

  const { client, mocked } = await providerClientFor(m.orgId, m.userId);
  const ok = await sendOne(m.orgId, row as MessageRow, client, mocked);

  if (!ok) {
    const { data: after } = await supabase
      .from("outbound_messages")
      .select("error")
      .eq("org_id", m.orgId)
      .eq("id", messageId)
      .maybeSingle();
    return { error: after?.error ?? "Send failed." };
  }

  return { mocked };
}
