import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken, encryptToken } from "./crypto";
import { providerConfig } from "./catalog";
import { ProviderAuthError } from "./client";
import type { Provider } from "./client";

/**
 * Access-token acquisition, shared by every provider client.
 *
 * Token strategy — "refresh proactively on a margin, not on 401" taken to its
 * simplest sound form: access tokens are never stored at all. Each client
 * instance redeems the encrypted refresh token once, uses the fresh access
 * token for its (short) burst of calls, and persists any rotated refresh
 * token. There is no stored access token to expire mid-flight.
 *
 * Refresh failure marks the connection needs_reauth and throws
 * ProviderAuthError — the layout banner picks the status up. It never fails
 * silently into a queue of mail that never sends (SPEC §6).
 *
 * `provider_connections` is reachable only through the admin client by design:
 * the authenticated role was revoked outright in Phase 1. Every query here is
 * pinned to the connection row's id.
 */

export type ConnectionRow = {
  id: string;
  provider: Provider;
  refresh_token_encrypted: string | null;
  status: "active" | "needs_reauth";
};

export class ConnectionSession {
  private accessToken: string | null = null;

  constructor(readonly connection: ConnectionRow) {}

  get provider(): Provider {
    return this.connection.provider;
  }

  async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    const config = providerConfig(this.provider);

    if (this.connection.status !== "active" || !this.connection.refresh_token_encrypted) {
      throw new ProviderAuthError(
        `${config.label} needs to be reconnected.`,
        this.provider,
      );
    }

    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId!,
        client_secret: config.clientSecret!,
        grant_type: "refresh_token",
        refresh_token: decryptToken(this.connection.refresh_token_encrypted),
        // Microsoft wants the scopes echoed back; Google rejects the parameter
        // on a refresh grant.
        ...(this.provider === "microsoft" ? { scope: config.scopes } : {}),
      }),
    });

    const admin = createAdminClient();

    if (!res.ok) {
      // The refresh token is dead (revoked, expired, password change). Flag it
      // so the UI shows the reconnect banner instead of quietly wedging.
      await admin
        .from("provider_connections")
        .update({ status: "needs_reauth" })
        .eq("id", this.connection.id);
      throw new ProviderAuthError(
        `${config.label} sign-in expired. Reconnect it from Connections.`,
        this.provider,
      );
    }

    const payload = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!payload.access_token) {
      throw new ProviderAuthError(
        `${config.label} returned no access token. Reconnect it.`,
        this.provider,
      );
    }

    // Microsoft rotates refresh tokens on every redemption — persist the
    // replacement or the next call dies. Google normally returns none and the
    // original stays valid, so an absent one here is not an error.
    if (payload.refresh_token) {
      await admin
        .from("provider_connections")
        .update({
          refresh_token_encrypted: encryptToken(payload.refresh_token),
          last_refreshed_at: new Date().toISOString(),
          status: "active",
        })
        .eq("id", this.connection.id);
    } else {
      await admin
        .from("provider_connections")
        .update({ last_refreshed_at: new Date().toISOString(), status: "active" })
        .eq("id", this.connection.id);
    }

    this.accessToken = payload.access_token;
    return this.accessToken;
  }

  /** Authenticated fetch with the shared 401/403 → re-consent translation. */
  async call<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.token();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError(
        `${providerConfig(this.provider).label} rejected the request. ` +
          `Reconnect it from Connections.`,
        this.provider,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `${this.provider} ${method} ${url} failed (HTTP ${res.status}): ${detail.slice(0, 300)}`,
      );
    }
    if (res.status === 202 || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
