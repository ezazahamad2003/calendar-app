import "server-only";

import { ProviderAuthError } from "./client";
import type { MailClient, SendMailOptions } from "./client";
import type { ConnectionSession } from "./token";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** RFC 2047 for anything outside ASCII — subjects carry names and accents. */
function encodeHeader(value: string): string {
  // Plain ASCII goes through untouched; anything else is base64'd, because a
  // stray accent in a company name is enough for a naive header to be rejected.
  const isAscii = [...value].every((c) => c.codePointAt(0)! < 128);
  return isAscii
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddress({ address, name }: { address: string; name?: string }): string {
  return name ? `${encodeHeader(name)} <${address}>` : address;
}

export class GoogleMailClient implements MailClient {
  constructor(private readonly session: ConnectionSession) {}

  async sendMail(opts: SendMailOptions): Promise<{ messageId: string | null }> {
    // Body is base64 rather than 7bit: contractors paste addresses, dashes and
    // the occasional accent, and a raw line over 998 characters or a stray
    // non-ASCII byte is exactly what a naive 7bit message gets rejected for.
    const mime = [
      `To: ${opts.to.map(formatAddress).join(", ")}`,
      `Subject: ${encodeHeader(opts.subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(opts.body, "utf8").toString("base64"),
    ].join("\r\n");

    const token = await this.session.token();
    const res = await fetch(`${GMAIL}/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }),
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError(
        "Gmail refused the send. Reconnect the account from Connections.",
        "google",
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gmail rejected the message (${res.status}). ${detail.slice(0, 200)}`);
    }

    const sent = (await res.json().catch(() => ({}))) as { id?: string };
    return { messageId: sent.id ?? null };
  }
}
