import "server-only";

import { ConnectionSession, type ConnectionRow } from "./token";
import type {
  Calendar,
  CreateEventOptions,
  MailCalendarClient,
  SendMailOptions,
} from "./client";

/**
 * Gmail + Google Calendar: the Google half of the seam, behaving identically to
 * MicrosoftClient from the caller's side.
 *
 * Two places where Google is genuinely different, not just differently spelled:
 *
 *   1. Gmail has no "send this structured object" endpoint. It takes a raw
 *      RFC 5322 message, base64url-encoded — so this file builds MIME by hand.
 *   2. Calendar all-day events use a bare `date` (no time, no zone) rather than
 *      Graph's `isAllDay` + midnight dateTime. Both take an *exclusive* end.
 */

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";

/**
 * RFC 2047 encoded-word, so a non-ASCII name or subject survives the header.
 *
 * The test is "not printable ASCII" rather than "not ASCII" on purpose: it
 * catches CR and LF too, which is what stops a subject line typed into the
 * outbox from injecting extra headers into a message we assemble by hand.
 */
function encodeHeader(value: string): string {
  if (!/[^\x20-\x7E]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddress(a: { address: string; name?: string }): string {
  return a.name ? `${encodeHeader(a.name)} <${a.address}>` : a.address;
}

/** Exclusive end date, as both Google Calendar and Graph want for all-day. */
function exclusiveEnd(endDate: string): string {
  const end = new Date(`${endDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString().slice(0, 10);
}

export class GoogleClient implements MailCalendarClient {
  private readonly session: ConnectionSession;

  constructor(connection: ConnectionRow) {
    this.session = new ConnectionSession(connection);
  }

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

    const sent = await this.session.call<{ id?: string }>(
      "POST",
      `${GMAIL}/messages/send`,
      { raw: Buffer.from(mime, "utf8").toString("base64url") },
    );
    return { messageId: sent.id ?? null };
  }

  private static eventBody(opts: CreateEventOptions | Partial<CreateEventOptions>) {
    const out: Record<string, unknown> = {};
    if (opts.subject !== undefined) out.summary = opts.subject;
    if (opts.body !== undefined) out.description = opts.body;
    if (opts.startDate && opts.endDate) {
      out.start = { date: opts.startDate, timeZone: opts.timeZone };
      out.end = { date: exclusiveEnd(opts.endDate), timeZone: opts.timeZone };
    }
    if (opts.attendees) {
      // Subs as attendees, so accept/decline flows back (SPEC §6).
      out.attendees = opts.attendees.map((a) => ({
        email: a.address,
        displayName: a.name,
      }));
    }
    return out;
  }

  async createEvent(opts: CreateEventOptions): Promise<{ eventId: string }> {
    const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
    const created = await this.session.call<{ id: string }>(
      "POST",
      // Without sendUpdates=all Google writes the event and tells nobody —
      // the attendee sees it only if they happen to look at their calendar.
      `${CALENDAR}/calendars/${calendarId}/events?sendUpdates=all`,
      GoogleClient.eventBody(opts),
    );
    return { eventId: created.id };
  }

  async updateEvent(eventId: string, opts: Partial<CreateEventOptions>): Promise<void> {
    const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
    await this.session.call(
      "PATCH",
      `${CALENDAR}/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      GoogleClient.eventBody(opts),
    );
  }

  async listCalendars(): Promise<Calendar[]> {
    const res = await this.session.call<{
      items?: { id: string; summary: string }[];
    }>("GET", `${CALENDAR}/users/me/calendarList`);
    return (res.items ?? []).map((c) => ({ id: c.id, name: c.summary }));
  }

  async createCalendar(name: string): Promise<Calendar> {
    const created = await this.session.call<{ id: string; summary: string }>(
      "POST",
      `${CALENDAR}/calendars`,
      { summary: name },
    );
    return { id: created.id, name: created.summary };
  }
}
