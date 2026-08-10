"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { requeueMessage, sendMessage, updateMessage } from "@/lib/outbox/actions";

export type OutboxMessage = {
  id: string;
  subject: string;
  body: string;
  status: "draft" | "queued" | "sent" | "failed";
  channel: "email" | "calendar";
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  recipientName: string;
  recipientEmail: string | null;
};

export function OutboxList({ messages }: { messages: OutboxMessage[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  function run(fn: () => Promise<{ error?: string; mocked?: boolean }>, doneMsg: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.error) setNotice(result.error);
      else {
        setNotice(result.mocked ? `${doneMsg} (simulated — Outlook not connected)` : doneMsg);
        setEditing(null);
        router.refresh();
      }
    });
  }

  return (
    <section aria-label="Messages">
      <div aria-live="polite" className="gantt-notice">
        {pending ? "Working…" : notice}
      </div>
      <ul className="outbox-list">
        {messages.map((msg) => (
          <li key={`${msg.id}:${msg.status}`} className={`outbox-item outbox-item--${msg.status}`}>
            <div className="outbox-head">
              <span className={`outbox-status outbox-status--${msg.status}`}>{msg.status}</span>
              <span className="outbox-to">
                {msg.recipientName}
                {msg.recipientEmail ? ` · ${msg.recipientEmail}` : ""}
              </span>
              <span className="outbox-when">
                {(msg.sentAt ?? msg.createdAt).slice(0, 16).replace("T", " ")}
              </span>
            </div>

            {editing === msg.id ? (
              <form
                className="stack-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  run(
                    () =>
                      updateMessage({
                        id: msg.id,
                        subject: String(form.get("subject") ?? ""),
                        body: String(form.get("body") ?? ""),
                      }),
                    "Saved.",
                  );
                }}
              >
                <input className="field-input" name="subject" defaultValue={msg.subject} aria-label="Subject" />
                <textarea className="field-input outbox-bodyedit" name="body" rows={6} defaultValue={msg.body} aria-label="Body" />
                <div className="plan-actions">
                  <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)} disabled={pending}>
                    Cancel
                  </button>
                  <button type="submit" className="btn" disabled={pending}>
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="outbox-subject">{msg.subject || "(no subject)"}</p>
                <p className="outbox-body">{msg.body}</p>
                {msg.error ? <p className="form-error">{msg.error}</p> : null}
                <div className="plan-actions">
                  {msg.status === "queued" || msg.status === "draft" ? (
                    <>
                      <button type="button" className="btn btn--ghost" onClick={() => setEditing(msg.id)} disabled={pending}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => run(() => sendMessage({ id: msg.id }), "Sent.")}
                        disabled={pending}
                      >
                        Send
                      </button>
                    </>
                  ) : null}
                  {msg.status === "failed" ? (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => run(() => requeueMessage({ id: msg.id }), "Requeued.")}
                      disabled={pending}
                    >
                      Requeue
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
