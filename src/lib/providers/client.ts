import "server-only";

/**
 * The mail + calendar seam (SPEC §6). Everything above this interface — outbox,
 * voice pipeline, calendar sync — is written once and works against whichever
 * account the user connected: Microsoft (Graph), Google (Gmail + Calendar), or
 * the mock when they have connected nothing.
 *
 * Adding a third provider means adding one file that implements this interface
 * plus an entry in `catalog.ts`. Callers never learn which one they got.
 */

/** The providers a user may connect. Mirrors the `oauth_provider` enum. */
export type Provider = "microsoft" | "google";

export type SendMailOptions = {
  to: { address: string; name?: string }[];
  subject: string;
  /** Plain text. Contractors send plain text. */
  body: string;
};

export type CreateEventOptions = {
  subject: string;
  /** Civil dates, org-local. Events are all-day: tasks are date ranges. */
  startDate: string;
  /** Inclusive last day; each client converts to its API's exclusive end. */
  endDate: string;
  timeZone: string;
  body?: string;
  attendees?: { address: string; name?: string }[];
  /** Target calendar; omitted = the account's default calendar. */
  calendarId?: string;
};

export type Calendar = { id: string; name: string };

export interface MailCalendarClient {
  /** Graph's sendMail returns 202 with no id; Gmail returns one. Hence null. */
  sendMail(opts: SendMailOptions): Promise<{ messageId: string | null }>;
  createEvent(opts: CreateEventOptions): Promise<{ eventId: string }>;
  updateEvent(eventId: string, opts: Partial<CreateEventOptions>): Promise<void>;
  listCalendars(): Promise<Calendar[]>;
  createCalendar(name: string): Promise<Calendar>;
}

/** Thrown when the connection is unusable and the user must re-consent. */
export class ProviderAuthError extends Error {
  constructor(
    message: string,
    /** Which account went stale — the banner names it. */
    readonly provider?: Provider,
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}
