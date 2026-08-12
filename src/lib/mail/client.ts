import "server-only";

import { getEnv } from "@/lib/env";

/**
 * Sending mail.
 *
 * The client's ask was blunt: drop the calendar, and when something moves,
 * email the people it moves — with the reason. So this is the only outbound
 * channel now. It replaced the Microsoft Graph and Gmail OAuth flows entirely,
 * which is what made removing sign-in possible: an API key belongs to the
 * deployment, not to a signed-in user.
 *
 * Two drivers:
 *
 *   Resend   when a key is configured.
 *   Console  otherwise — composes the message, records it, logs it, and sends
 *            nothing.
 *
 * The console driver is the default on purpose. This schedule is full of real
 * subcontractors, and a half-configured deployment that silently mails them
 * is worse than one that visibly does not.
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

export function mailer(): Mailer {
  if (cached) return cached;

  const env = getEnv();

  if (!env.FEATURE_SEND_EMAIL) {
    cached = new ConsoleMailer("FEATURE_SEND_EMAIL is off");
  } else if (!env.RESEND_API_KEY) {
    cached = new ConsoleMailer("RESEND_API_KEY is not set");
  } else if (!env.MAIL_FROM) {
    cached = new ConsoleMailer("MAIL_FROM is not set");
  } else {
    cached = new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM, env.MAIL_REPLY_TO);
  }

  return cached;
}

/** Tests supply their own. */
export function setMailer(next: Mailer | null): void {
  cached = next;
}
