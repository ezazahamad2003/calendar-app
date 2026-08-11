import "server-only";

import { getEnv } from "@/lib/env";
import type { Provider } from "./client";

/**
 * Everything that differs between providers, in one table.
 *
 * The OAuth dance itself is identical for both (authorization code + PKCE), so
 * `oauth.ts` runs it generically and reads the differences from here. Keeping
 * the endpoints and labels together also means the UI, the routes, and the
 * token refresh can never disagree about, say, which scopes were requested.
 */

export type ProviderConfig = {
  id: Provider;
  /** What the user calls it. */
  label: string;
  /** Longer form for prose: "send mail and write events". */
  detail: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUri: string | undefined;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Where the "Connect" link points. */
  connectPath: string;
  /**
   * Provider-specific query params on the authorize call.
   *
   * Microsoft issues a refresh token whenever `offline_access` is in scope.
   * Google needs to be asked twice over: `access_type=offline` to issue one at
   * all, and `prompt=consent` to issue one *again* on reconnect — without it a
   * user who already consented gets an access token and no refresh token, and
   * the connection dies silently an hour later. This is the single most common
   * way a Google integration ships broken.
   */
  extraAuthParams: Record<string, string>;
};

export const PROVIDERS: readonly Provider[] = ["microsoft", "google"] as const;

export function providerConfig(provider: Provider): ProviderConfig {
  const env = getEnv();

  if (provider === "microsoft") {
    return {
      id: "microsoft",
      label: "Outlook",
      detail: "Outlook mail and calendar",
      clientId: env.MS_CLIENT_ID,
      clientSecret: env.MS_CLIENT_SECRET,
      redirectUri: env.MS_REDIRECT_URI,
      scopes: env.MS_SCOPES,
      authorizeUrl: `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
      connectPath: "/api/microsoft/connect",
      extraAuthParams: { response_mode: "query" },
    };
  }

  return {
    id: "google",
    label: "Gmail",
    detail: "Gmail and Google Calendar",
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    scopes: env.GOOGLE_SCOPES,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    connectPath: "/api/google/connect",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  };
}

/**
 * Is this provider usable in this environment?
 *
 * The secret key is part of the answer: `provider_connections` is reachable
 * only through it, so without one there is nowhere to put the token. This has
 * to be a *check* rather than a throw — connection status is read by the
 * authenticated layout on every page, and an unconfigured optional integration
 * must never take down the whole app. (It did exactly that once.)
 */
export function providerConfigured(provider: Provider): boolean {
  const { clientId, clientSecret, redirectUri } = providerConfig(provider);
  return Boolean(
    getEnv().SUPABASE_SECRET_KEY && clientId && clientSecret && redirectUri,
  );
}

/** Names of the env vars a half-configured provider is missing, for the error. */
export function missingProviderEnv(provider: Provider): string[] {
  const config = providerConfig(provider);
  const prefix = provider === "microsoft" ? "MS" : "GOOGLE";
  return (
    [
      [`${prefix}_CLIENT_ID`, config.clientId],
      [`${prefix}_CLIENT_SECRET`, config.clientSecret],
      [`${prefix}_REDIRECT_URI`, config.redirectUri],
      ["SUPABASE_SECRET_KEY", getEnv().SUPABASE_SECRET_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
}
