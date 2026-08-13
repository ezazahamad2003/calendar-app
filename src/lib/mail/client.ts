import "server-only";

import { getEnv } from "@/lib/env";
import { ProviderAuthError } from "@/lib/providers/client";
import type { MailClient } from "@/lib/providers/client";
import type { MailProvider } from "@/lib/store/types";

/**
 * Sending mail.
 *
 * The client's ask was blunt: drop the calendar, and when something moves,
 * email the people it moves — with the reason. So this is the only outbound
 * channel.
 *
 * Three drivers, in the order `mailer()` prefers them:
 *
 *   Connected  the contractor's own Gmail or Outlook, connected on
 *              /connections. Mail arrives from the address his subs already
 *              know, and their replies reach him.
 *   Resend     an API key belonging to the deployment. The fallback when no
 *              mailbox is connected.
 *   Console    composes the message, records it, logs it, sends nothing.
 *
 * The console driver is the default on purpose. This schedule is full of real
 * subcontractors, and a half-configured deployment that silently mails them is
 * worse than one that visibly does not.
 */

export type MailMessage = {
  to: string;
  toName: string;
  subject: string;
  /** Plain text. Contractors read this on a phone, often on bad signal. */
  text: string;
};

export type MailResult =
  | { ok: true; id: string; delivered: boolean }
  | { ok: false; error: string };

export interface Mailer {
  readonly name: string;
  /** True when a send actually leaves the building. */
  readonly delivers: boolean;
  send(message: MailMessage): Promise<MailResult>;
}

class ConsoleMailer implements Mailer {
  readonly name = "console";
  readonly delivers = false;
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async send(message: MailMessage): Promise<MailResult> {
    console.info(
      `[mail:console] not sent (${this.reason})\n` +
        `  to:      ${message.toName} <${message.to}>\n` +
        `  subject: ${message.subject}\n` +
        message.text.replace(/^/gm, "  | "),
    );
    return { ok: true, id: `console-${Date.now()}`, delivered: false };
  }
}

class ResendMailer implements Mailer {
  readonly name = "resend";
  readonly delivers = true;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly replyTo: string | undefined;

  constructor(apiKey: string, from: string, replyTo: string | undefined) {
    this.apiKey = apiKey;
    this.from = from;
    this.replyTo = replyTo;
  }

  async send(message: MailMessage): Promise<MailResult> {
    // Plain fetch rather than the SDK: this is one POST with four fields, and
    // it keeps a dependency (and its transitive tree) out of the bundle.
    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A notification failing must never unwind the schedule change that
      // prompted it, so this returns rather than throws all the way up.
      return {
        ok: false,
        error:
          err instanceof Error && err.name === "TimeoutError"
            ? "The mail service did not respond in time."
            : `Could not reach the mail service: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      let message_ = `Mail service refused the message (${response.status}).`;
      try {
        const parsed = JSON.parse(detail) as { message?: string };
        if (parsed.message) message_ = parsed.message;
      } catch {
        if (detail) message_ = `${message_} ${detail.slice(0, 200)}`;
      }
      return { ok: false, error: message_ };
    }

    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: body.id ?? `resend-${Date.now()}`, delivered: true };
  }
}

let cached: Mailer | null = null;

/**
 * Sends through the contractor's own connected Gmail or Outlook.
 *
 * This is the one the client asked for. Mail arrives from his real address, so
 * a subcontractor recognises the sender and a reply lands in his inbox rather
 * than in a no-reply void — which matters, because the message ends with
 * "reply if that doesn't work for you" and people do.
 */
class ConnectedAccountMailer implements Mailer {
  readonly name: string;
  readonly delivers = true;

  constructor(
    private readonly client: MailClient,
    provider: MailProvider,
    readonly from: string | null,
  ) {
    this.name = provider === "google" ? "gmail" : "outlook";
  }

  async send(message: MailMessage): Promise<MailResult> {
    try {
      const { messageId } = await this.client.sendMail({
        to: [{ address: message.to, name: message.toName }],
        subject: message.subject,
        body: message.text,
      });
      // Graph accepts with 202 and no id; a null id is a success, not a gap.
      return { ok: true, id: messageId ?? `sent-${Date.now()}`, delivered: true };
    } catch (err) {
      // A dead connection must look like a failure, never be simulated away.
      return {
        ok: false,
        error:
          err instanceof ProviderAuthError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Send failed.",
      };
    }
  }
}

/**
 * Which mailer this send uses.
 *
 * Order matters and is deliberate:
 *
 *   1. A connected Gmail/Outlook account — what the contractor set up, and the
 *      only option that sends from an address his subs recognise.
 *   2. Resend, if a key is configured. The fallback for a deployment with no
 *      mailbox connected.
 *   3. Console. Composes, records, shows it in History, sends nothing.
 *
 * Not cached, unlike the others: the connection lives in the schedule document
 * and can be connected, revoked or go stale between two sends. A cached mailer
 * would keep using an account that was disconnected minutes ago.
 */
export async function mailer(): Promise<Mailer> {
  if (cached) return cached;

  const env = getEnv();
  if (!env.FEATURE_SEND_EMAIL) return new ConsoleMailer("FEATURE_SEND_EMAIL is off");

  const connected = await connectedMailer();
  if (connected) return connected;

  if (!env.RESEND_API_KEY) {
    return new ConsoleMailer("no mailbox is connected and RESEND_API_KEY is not set");
  }
  if (!env.MAIL_FROM) return new ConsoleMailer("MAIL_FROM is not set");

  return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM, env.MAIL_REPLY_TO);
}

async function connectedMailer(): Promise<Mailer | null> {
  const { readDoc } = await import("@/lib/store");
  const { ConnectionSession } = await import("@/lib/providers/token");
  const { GoogleMailClient } = await import("@/lib/providers/google");
  const { MicrosoftMailClient } = await import("@/lib/providers/microsoft");

  let connection;
  try {
    connection = (await readDoc()).connection;
  } catch {
    // Storage trouble is the store's problem to report, not the mailer's.
    return null;
  }

  // A stale connection falls through to Resend/console rather than throwing —
  // but it is NOT silently simulated: `commitPlan` records the failure, and
  // the Connections page shows the reconnect prompt.
  if (!connection || connection.status !== "active") return null;

  const session = new ConnectionSession(connection);
  const client =
    connection.provider === "google"
      ? new GoogleMailClient(session)
      : new MicrosoftMailClient(session);

  return new ConnectedAccountMailer(client, connection.provider, connection.email);
}

/** Tests supply their own. */
export function setMailer(next: Mailer | null): void {
  cached = next;
}
