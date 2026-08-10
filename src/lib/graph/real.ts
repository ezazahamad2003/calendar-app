import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEnv, requireEnv } from "@/lib/env";
import { decryptToken, encryptToken } from "./crypto";
import { GraphAuthError } from "./client";
import type {
  Calendar,
  CreateEventOptions,
  GraphClient,
  SendMailOptions,
} from "./client";

/**
 * RealGraphClient (Phase 7): delegated Microsoft Graph calls for one user.
 *
 * Token strategy — "refresh proactively on a margin, not on 401" taken to its
 * simplest sound form: access tokens are never stored at all. Each client
 * instance redeems the encrypted refresh token once, uses the fresh access
 * token for its (short) burst of calls, and persists the rotated refresh
 * token. There is no stored access token to expire mid-flight.
 *
 * Refresh failure marks the connection needs_reauth and throws GraphAuthError
 * — the layout banner picks the status up. It never fails silently into a
 * queue of mail that never sends (SPEC §6).
 *
 * ms_connections is reachable only through the admin client by design: the
 * authenticated role was revoked outright in Phase 1. Every query here is
 * pinned to the connection row's id.
 */

type ConnectionRow = {
  id: string;
  refresh_token_encrypted: string | null;
  status: "active" | "needs_reauth";
};

const GRAPH = "https://graph.microsoft.com/v1.0";

export class RealGraphClient implements GraphClient {
  private accessToken: string | null = null;

  constructor(private readonly connection: ConnectionRow) {}

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    if (this.connection.status !== "active" || !this.connection.refresh_token_encrypted) {
      throw new GraphAuthError("Outlook needs to be reconnected.");
    }

    const env = getEnv();
    const body = new URLSearchParams({
      client_id: requireEnv("MS_CLIENT_ID"),
      client_secret: requireEnv("MS_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: decryptToken(this.connection.refresh_token_encrypted),
      scope: env.MS_SCOPES,
    });

    const res = await fetch(
      `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );

    const admin = createAdminClient();

    if (!res.ok) {
      // The refresh token is dead (revoked, expired, password change). Flag it
      // so the UI shows the reconnect banner instead of quietly wedging.
      await admin
        .from("ms_connections")
        .update({ status: "needs_reauth" })
        .eq("id", this.connection.id);
      throw new GraphAuthError(
        "Microsoft sign-in expired. Reconnect Outlook from the dashboard.",
      );
    }

    const payload = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!payload.access_token) {
      throw new GraphAuthError("Microsoft returned no access token. Reconnect Outlook.");
    }

    // Refresh tokens rotate; persist the replacement or the next call dies.
    if (payload.refresh_token) {
      await admin
        .from("ms_connections")
        .update({
          refresh_token_encrypted: encryptToken(payload.refresh_token),
          last_refreshed_at: new Date().toISOString(),
          status: "active",
        })
        .eq("id", this.connection.id);
    }

    this.accessToken = payload.access_token;
    return this.accessToken;
  }

  private async call<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.token();
    const res = await fetch(`${GRAPH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 || res.status === 403) {
      throw new GraphAuthError(
        "Microsoft rejected the request. Reconnect Outlook from the dashboard.",
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Microsoft Graph ${method} ${path} failed (HTTP ${res.status}): ${detail.slice(0, 300)}`,
      );
    }
    if (res.status === 202 || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async sendMail(opts: SendMailOptions): Promise<{ messageId: string | null }> {
    await this.call("POST", "/me/sendMail", {
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
    const path = opts.calendarId
      ? `/me/calendars/${encodeURIComponent(opts.calendarId)}/events`
      : "/me/events";
    const created = await this.call<{ id: string }>(
      "POST",
      path,
      RealGraphClient.eventBody(opts),
    );
    return { eventId: created.id };
  }

  async updateEvent(eventId: string, opts: Partial<CreateEventOptions>): Promise<void> {
    await this.call(
      "PATCH",
      `/me/events/${encodeURIComponent(eventId)}`,
      RealGraphClient.eventBody(opts),
    );
  }

  async listCalendars(): Promise<Calendar[]> {
    const res = await this.call<{ value: { id: string; name: string }[] }>(
      "GET",
      "/me/calendars",
    );
    return res.value.map((c) => ({ id: c.id, name: c.name }));
  }

  async createCalendar(name: string): Promise<Calendar> {
    const created = await this.call<{ id: string; name: string }>(
      "POST",
      "/me/calendars",
      { name },
    );
    return { id: created.id, name: created.name };
  }
}
