import "server-only";

import type {
  Calendar,
  CreateEventOptions,
  GraphClient,
  SendMailOptions,
} from "./client";

/**
 * MockGraphClient (SPEC §6): logs and returns fixture responses. Used whenever
 * the caller has no active Microsoft connection, so the entire send/sync flow
 * is exercisable — outbox statuses, idempotency, change_log — before OAuth
 * exists in the account.
 *
 * Ids are prefixed "mock-" so a fixture id can never be mistaken for a real
 * Graph id in the database.
 */
export class MockGraphClient implements GraphClient {
  private calendars: Calendar[] = [{ id: "mock-cal-default", name: "Calendar" }];

  async sendMail(opts: SendMailOptions): Promise<{ messageId: string | null }> {
    console.log(
      `[MockGraph] sendMail to=${opts.to.map((t) => t.address).join(",")} subject="${opts.subject}"`,
    );
    return { messageId: `mock-msg-${crypto.randomUUID()}` };
  }

  async createEvent(opts: CreateEventOptions): Promise<{ eventId: string }> {
    console.log(
      `[MockGraph] createEvent "${opts.subject}" ${opts.startDate}→${opts.endDate} attendees=${opts.attendees?.length ?? 0}`,
    );
    return { eventId: `mock-evt-${crypto.randomUUID()}` };
  }

  async updateEvent(eventId: string, opts: Partial<CreateEventOptions>): Promise<void> {
    console.log(`[MockGraph] updateEvent ${eventId} "${opts.subject ?? ""}"`);
  }

  async listCalendars(): Promise<Calendar[]> {
    return [...this.calendars];
  }

  async createCalendar(name: string): Promise<Calendar> {
    const cal = { id: `mock-cal-${crypto.randomUUID()}`, name };
    this.calendars.push(cal);
    console.log(`[MockGraph] createCalendar "${name}" -> ${cal.id}`);
    return cal;
  }
}
