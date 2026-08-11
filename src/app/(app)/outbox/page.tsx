import Link from "next/link";

import { requireMembership } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { connectionStates, summarize } from "@/lib/providers/factory";
import { OutboxList } from "./outbox-list";
import type { OutboxMessage } from "./outbox-list";

/** Outbox (SPEC §7): queued and sent messages, editable before send. */
export default async function OutboxPage() {
  const m = await requireMembership();
  const supabase = await createClient();

  const [{ data: rows }, states] = await Promise.all([
    supabase
      .from("outbound_messages")
      .select(
        "id, subject, body, status, channel, error, created_at, sent_at, contact_id, contacts(name, email)",
      )
      .eq("org_id", m.orgId)
      .order("created_at", { ascending: false })
      .limit(100),
    connectionStates(m.orgId, m.userId),
  ]);
  const connections = summarize(states);

  const messages: OutboxMessage[] = (rows ?? []).map((r) => ({
    id: r.id,
    subject: r.subject ?? "",
    body: r.body ?? "",
    status: r.status,
    channel: r.channel,
    error: r.error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    recipientName: r.contacts?.name ?? "—",
    recipientEmail: r.contacts?.email ?? null,
  }));

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <p className="page-eyebrow">{m.orgName}</p>
          <h1 className="page-title">Outbox</h1>
        </div>
      </header>

      {!connections.anyAvailable ? (
        <p className="outbox-mode">
          No email account is set up in this environment, so sends are{" "}
          <strong>simulated</strong> — messages get marked sent without leaving
          the app.
        </p>
      ) : !connections.active ? (
        <p className="outbox-mode">
          No email account is connected, so sends are <strong>simulated</strong>{" "}
          — messages get marked sent without leaving the app.{" "}
          <Link href="/connections">Connect Outlook or Gmail</Link> to send for
          real.
        </p>
      ) : (
        <p className="outbox-mode">
          Sending via {connections.active.label} as{" "}
          <strong>{connections.active.email ?? "your connected account"}</strong>.{" "}
          <Link href="/connections">Change</Link>
        </p>
      )}

      {messages.length === 0 ? (
        <section className="empty-card">
          <h2 className="empty-title">Nothing here yet</h2>
          <p className="empty-body">
            Emails you queue — by voice or from a plan — land here first. You
            read, edit and send them; nothing goes out on its own.
          </p>
        </section>
      ) : (
        <OutboxList messages={messages} />
      )}
    </main>
  );
}
