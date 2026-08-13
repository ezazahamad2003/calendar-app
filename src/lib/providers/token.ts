import "server-only";

import { writeDoc } from "@/lib/store";
import type { MailConnection } from "@/lib/store/types";
import { decryptToken, encryptToken } from "./crypto";
import { providerConfig } from "./catalog";
import { ProviderAuthError } from "./client";

/**
 * Getting an access token, shared by both providers.
 *
 * Access tokens are never stored. Each send redeems the encrypted refresh
 * token once, uses the fresh access token for its short burst of calls, and
 * persists the refresh token if the provider rotated it. There is no stored
 * access token to expire mid-flight, which is the simplest sound reading of
 * "refresh proactively, not on 401".
 *
 * A refresh failure marks the connection `needs_reauth` and throws, so the
 * Connections page can say so. It must never fail silently into a queue of
 * mail that never sends — a subcontractor who was never told is the whole
 * failure this app exists to prevent.
 */
export class ConnectionSession {
  private accessToken: string | null = null;

  constructor(private readonly connection: MailConnection) {}

  get provider() {
    return this.connection.provider;
  }

  async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    const config = providerConfig(this.provider);

    if (this.connection.status !== "active") {
      throw new ProviderAuthError(
        `${config.label} needs to be reconnected.`,
        this.provider,
      );
    }

    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId as string,
        client_secret: config.clientSecret as string,
        grant_type: "refresh_token",
        refresh_token: decryptToken(this.connection.refreshTokenEncrypted),
        // Microsoft wants the scopes echoed back; Google rejects the parameter
        // on a refresh grant.
        ...(this.provider === "microsoft" ? { scope: config.scopes } : {}),
      }),
    });

    if (!res.ok) {
      // The refresh token is dead — revoked, expired, or the password changed.
      // Flag it so the UI shows a reconnect prompt rather than quietly wedging.
      await markNeedsReauth();
      throw new ProviderAuthError(
        `${config.label} sign-in expired. Reconnect it from Connections.`,
        this.provider,
      );
    }

    const tokens = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
    };

    if (!tokens.access_token) {
      await markNeedsReauth();
      throw new ProviderAuthError(
        `${config.label} returned no access token.`,
        this.provider,
      );
    }

    // Providers may hand back a new refresh token and invalidate the old one.
    // Missing this is how a connection works for weeks and then dies.
    if (tokens.refresh_token) {
      await storeRotatedToken(tokens.refresh_token);
    } else {
      await touchRefreshedAt();
    }

    this.accessToken = tokens.access_token;
    return this.accessToken;
  }
}

async function markNeedsReauth(): Promise<void> {
  await writeDoc((current) =>
    current.connection
      ? { ...current, connection: { ...current.connection, status: "needs_reauth" } }
      : current,
  );
}

async function storeRotatedToken(refreshToken: string): Promise<void> {
  const encrypted = encryptToken(refreshToken);
  await writeDoc((current) =>
    current.connection
      ? {
          ...current,
          connection: {
            ...current.connection,
            refreshTokenEncrypted: encrypted,
            lastRefreshedAt: new Date().toISOString(),
          },
        }
      : current,
  );
}

async function touchRefreshedAt(): Promise<void> {
  await writeDoc((current) =>
    current.connection
      ? {
          ...current,
          connection: {
            ...current.connection,
            lastRefreshedAt: new Date().toISOString(),
          },
        }
      : current,
  );
}
