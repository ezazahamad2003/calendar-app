import { requireMembership } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { msConnectionState } from "@/lib/graph/factory";
import { OutboxList } from "./outbox-list";
import type { OutboxMessage } from "./outbox-list";

/** Outbox (SPEC §7): queued and sent messages, editable before send. */
export default async function OutboxPage() {
  const m = await requireMembership();
  const supabase = await createClient();

  const [{ data: rows }, connection] = await Promise.all([
    supabase
      .from("outbound_messages")
      .select(
        "id, subject, body, status, channel, error, created_at, sent_at, contact_id, contacts(name, email)",
      )
      .eq("org_id", m.orgId)
      .order("created_at", { ascending: false })
      .limit(100),
    msConnectionState(m.orgId, m.userId),
  ]);

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

      {!connection.connected ? (
        <p className="outbox-mode">
          Outlook isn&rsquo;t connected, so sends are <strong>simulated</strong> —
          messages get marked sent without leaving the app.{" "}
          <a href="/api/microsoft/connect">Connect Outlook</a> to send for real.
        </p>
      ) : (
        <p className="outbox-mode">
          Sending as <strong>{connection.email ?? "your Outlook account"}</strong>.
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
