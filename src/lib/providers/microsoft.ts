import "server-only";

import { ConnectionSession, type ConnectionRow } from "./token";
import type {
  Calendar,
  CreateEventOptions,
  MailCalendarClient,
  SendMailOptions,
} from "./client";

/**
 * Microsoft Graph: delegated mail + calendar for one connected user.
 *
 * Token handling, refresh-token rotation and the 401 → needs_reauth
 * translation all live in ConnectionSession, shared with the Google client.
 * What is left here is the shape of Graph's own requests.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export class MicrosoftClient implements MailCalendarClient {
  private readonly session: ConnectionSession;

  constructor(connection: ConnectionRow) {
    this.session = new ConnectionSession(connection);
  }

  async sendMail(opts: SendMailOptions): Promise<{ messageId: string | null }> {
    await this.session.call("POST", `${GRAPH}/me/sendMail`, {
      message: {
        subject: opts.subject,
        body: { contentType: "Text", content: opts.body },
        toRecipients: opts.to.map((t) => ({
          emailAddress: { address: t.address, name: t.name },
        })),
      },
      saveToSentItems: true,
    });
    // sendMail is 202 Accepted with no body; there is no message id to keep.
    return { messageId: null };
  }

  /** Graph all-day events use an *exclusive* end date at midnight. */
  private static eventBody(opts: CreateEventOptions | Partial<CreateEventOptions>) {
    const out: Record<string, unknown> = {};
    if (opts.subject !== undefined) out.subject = opts.subject;
    if (opts.body !== undefined) {
      out.body = { contentType: "Text", content: opts.body };
    }
    if (opts.startDate && opts.endDate && opts.timeZone) {
      const end = new Date(`${opts.endDate}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      out.isAllDay = true;
      out.start = { dateTime: `${opts.startDate}T00:00:00`, timeZone: opts.timeZone };
      out.end = {
        dateTime: `${end.toISOString().slice(0, 10)}T00:00:00`,
        timeZone: opts.timeZone,
      };
    }
    if (opts.attendees) {
      // Subs as attendees, so accept/decline flows back (SPEC §6).
      out.attendees = opts.attendees.map((a) => ({
        emailAddress: { address: a.address, name: a.name },
        type: "required",
      }));
    }
    return out;
  }

  async createEvent(opts: CreateEventOptions): Promise<{ eventId: string }> {
    const url = opts.calendarId
      ? `${GRAPH}/me/calendars/${encodeURIComponent(opts.calendarId)}/events`
      : `${GRAPH}/me/events`;
    const created = await this.session.call<{ id: string }>(
      "POST",
      url,
      MicrosoftClient.eventBody(opts),
    );
    return { eventId: created.id };
  }

  async updateEvent(eventId: string, opts: Partial<CreateEventOptions>): Promise<void> {
    await this.session.call(
      "PATCH",
      `${GRAPH}/me/events/${encodeURIComponent(eventId)}`,
      MicrosoftClient.eventBody(opts),
    );
  }

  async listCalendars(): Promise<Calendar[]> {
    const res = await this.session.call<{ value: { id: string; name: string }[] }>(
      "GET",
      `${GRAPH}/me/calendars`,
    );
    return res.value.map((c) => ({ id: c.id, name: c.name }));
  }

  async createCalendar(name: string): Promise<Calendar> {
    const created = await this.session.call<{ id: string; name: string }>(
      "POST",
      `${GRAPH}/me/calendars`,
      { name },
    );
    return { id: created.id, name: created.name };
  }
}
