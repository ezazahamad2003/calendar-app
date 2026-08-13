import "server-only";

import { getEnv } from "@/lib/env";
import type { MailProvider } from "@/lib/store/types";

/**
 * Everything that differs between Google and Microsoft, in one table.
 *
 * The OAuth dance itself is identical for both (authorization code + PKCE), so
 * `oauth.ts` runs it generically and reads the differences from here. Keeping
 * endpoints, scopes and labels together also means the UI, the routes and the
 * token refresh can never disagree about, say, which scopes were requested.
 */

export type ProviderConfig = {
  id: MailProvider;
  /** What the user calls it. */
  label: string;
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
   * Google needs asking twice over: `access_type=offline` to issue one at all,
   * and `prompt=consent` to issue one *again* on reconnect — without it a user
   * who already consented gets an access token and no refresh token, and the
   * connection dies silently an hour later. This is the single most common way
   * a Google integration ships broken.
   */
  extraAuthParams: Record<string, string>;
};

export const PROVIDERS: readonly MailProvider[] = ["microsoft", "google"] as const;

export function providerConfig(provider: MailProvider): ProviderConfig {
  const env = getEnv();

  if (provider === "microsoft") {
    return {
      id: "microsoft",
      label: "Outlook",
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
 * Which variables this provider still needs.
 *
 * Reported rather than thrown, so a half-configured deployment shows "Outlook
 * isn't set up here — missing MS_CLIENT_ID" on the Connections page instead of
 * a 500 from the consent redirect.
 */
export function missingProviderEnv(provider: MailProvider): string[] {
  const config = providerConfig(provider);
  const prefix = provider === "microsoft" ? "MS" : "GOOGLE";

  const missing: string[] = [];
  if (!config.clientId) missing.push(`${prefix}_CLIENT_ID`);
  if (!config.clientSecret) missing.push(`${prefix}_CLIENT_SECRET`);
  if (!config.redirectUri) missing.push(`${prefix}_REDIRECT_URI`);
  if (!getEnv().TOKEN_ENCRYPTION_KEY) missing.push("TOKEN_ENCRYPTION_KEY");
  return missing;
}

/** True when this provider could be connected right now. */
export function providerIsConfigured(provider: MailProvider): boolean {
  return missingProviderEnv(provider).length === 0;
}
