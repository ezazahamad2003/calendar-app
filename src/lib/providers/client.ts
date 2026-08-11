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
  /** Civil dates, org-local. */
  startDate: string;
  /** Inclusive last day; each client converts to its API's exclusive end. */
  endDate: string;
  timeZone: string;
  /**
   * `HH:MM` on-site window. Both absent = an all-day event, which is what a
   * task with no times has always produced and still the common case.
   *
   * A multi-day task with a window repeats it on each day, so what goes on the
   * provider's calendar is the FIRST day's block: neither Graph nor Google has
   * a "same hours, several days" event short of a recurrence rule, and one
   * timed block plus the right dates is closer to the truth than a single
   * event running through two nights.
   */
  startTime?: string | null;
  endTime?: string | null;
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
  /**
   * Remove an event. Must treat "already gone" as success — the caller is
   * cleaning up after a deleted task and has no way to know whether the user
   * removed the event by hand first.
   */
  deleteEvent(eventId: string, calendarId?: string): Promise<void>;
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
