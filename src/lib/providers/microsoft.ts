import "server-only";

import { ProviderAuthError } from "./client";
import type { MailClient, SendMailOptions } from "./client";
import type { ConnectionSession } from "./token";

const GRAPH = "https://graph.microsoft.com/v1.0";

export class MicrosoftMailClient implements MailClient {
  constructor(private readonly session: ConnectionSession) {}

  async sendMail(opts: SendMailOptions): Promise<{ messageId: string | null }> {
    const token = await this.session.token();
    const res = await fetch(`${GRAPH}/me/sendMail`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: opts.subject,
          body: { contentType: "Text", content: opts.body },
          toRecipients: opts.to.map((t) => ({
            emailAddress: { address: t.address, name: t.name },
          })),
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError(
        "Outlook refused the send. Reconnect the account from Connections.",
        "microsoft",
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Outlook rejected the message (${res.status}). ${detail.slice(0, 200)}`);
    }

    // sendMail is 202 Accepted with no body; there is no message id to keep.
    return { messageId: null };
  }
}
