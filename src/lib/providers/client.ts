import "server-only";

import type { MailProvider } from "@/lib/store/types";

/**
 * The send seam.
 *
 * Deliberately one method. This used to carry the calendar too — createEvent,
 * updateEvent, listCalendars, createCalendar — and all of it went when the
 * client dropped the calendar in favour of email. Sending is the only thing a
 * connected account is for now, and an interface that says so cannot grow a
 * caller that quietly writes to someone's calendar.
 */

export type SendMailOptions = {
  to: { address: string; name?: string }[];
  subject: string;
  /** Plain text. Contractors read this on a phone, often on bad signal. */
  body: string;
};

export interface MailClient {
  /** Graph's sendMail returns 202 with no id; Gmail returns one. Hence null. */
  sendMail(opts: SendMailOptions): Promise<{ messageId: string | null }>;
}

/** Thrown when the connection is unusable and the user must re-consent. */
export class ProviderAuthError extends Error {
  constructor(
    message: string,
    /** Which account went stale — the banner names it. */
    readonly provider?: MailProvider,
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}
