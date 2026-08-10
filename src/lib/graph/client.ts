import "server-only";

/**
 * The Graph seam (SPEC §6). Everything above this interface — outbox, voice
 * pipeline, calendar sync — is complete and testable against the mock; the
 * real client (Phase 7) slots in underneath without touching callers.
 */

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
  /** Inclusive last day; the client converts to Graph's exclusive end. */
  endDate: string;
  timeZone: string;
  body?: string;
  attendees?: { address: string; name?: string }[];
  /** Target calendar; omitted = default calendar. */
  calendarId?: string;
};

export type Calendar = { id: string; name: string };

export interface GraphClient {
  /** Graph's sendMail returns 202 with no id; the mock invents one. */
  sendMail(opts: SendMailOptions): Promise<{ messageId: string | null }>;
  createEvent(opts: CreateEventOptions): Promise<{ eventId: string }>;
  updateEvent(eventId: string, opts: Partial<CreateEventOptions>): Promise<void>;
  listCalendars(): Promise<Calendar[]>;
  createCalendar(name: string): Promise<Calendar>;
}

/** Thrown when the connection is unusable and the user must re-consent. */
export class GraphAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphAuthError";
  }
}
