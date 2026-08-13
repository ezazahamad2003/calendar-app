import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";

import { getEnv } from "@/lib/env";
import { writeDoc } from "@/lib/store";
import type { MailProvider } from "@/lib/store/types";
import { encryptToken } from "./crypto";
import { missingProviderEnv, providerConfig } from "./catalog";

/**
 * The OAuth dance, once, for both providers: authorization code + PKCE.
 *
 * Google and Microsoft differ only in endpoints, scopes and a couple of query
 * params — all of which live in `catalog.ts` — so the routes under
 * `/api/google` and `/api/microsoft` are thin wrappers around these two
 * functions.
 *
 * There is no sign-in on this app, so there is no session to tie a connection
 * to: the connected mailbox belongs to the schedule, and there is one of each.
 * Connecting a second account replaces the first.
 */

/** Per-provider cookie names, so connecting both in two tabs cannot collide. */
const verifierCookie = (p: MailProvider) => `${p}_pkce_verifier`;
const stateCookie = (p: MailProvider) => `${p}_oauth_state`;

function cookieOptions(provider: MailProvider) {
  return {
    httpOnly: true,
    secure: getEnv().NODE_ENV === "production",
    sameSite: "lax" as const,
    // Scoped to this provider's routes — these only need to survive the round
    // trip to the consent screen and back.
    path: `/api/${provider}`,
    maxAge: 600,
  };
}

/** Outbound leg: redirect to the provider's consent screen. */
export async function startOAuth(
  request: NextRequest,
  provider: MailProvider,
): Promise<NextResponse> {
  const config = providerConfig(provider);
  const missing = missingProviderEnv(provider);

  // A half-configured environment should say so on the page, not 500.
  if (missing.length > 0) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/connections?error=${encodeURIComponent(
        `${config.label} isn't set up here — missing ${missing.join(", ")}.`,
      )}`,
    );
  }

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const authorize = new URL(config.authorizeUrl);
  authorize.searchParams.set("client_id", config.clientId as string);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", config.redirectUri as string);
  authorize.searchParams.set("scope", config.scopes);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(config.extraAuthParams)) {
    authorize.searchParams.set(key, value);
  }

  const response = NextResponse.redirect(authorize);
  response.cookies.set(verifierCookie(provider), verifier, cookieOptions(provider));
  response.cookies.set(stateCookie(provider), state, cookieOptions(provider));
  return response;
}

/** Who connected? Both providers expose this differently; normalise here. */
async function fetchIdentity(
  provider: MailProvider,
  accessToken: string,
): Promise<{ id: string | null; email: string | null }> {
  const url =
    provider === "microsoft"
      ? "https://graph.microsoft.com/v1.0/me"
      : "https://www.googleapis.com/oauth2/v3/userinfo";

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { id: null, email: null };

  if (provider === "microsoft") {
    const me = (await res.json()) as {
      id?: string;
      mail?: string | null;
      userPrincipalName?: string | null;
    };
    return { id: me.id ?? null, email: me.mail ?? me.userPrincipalName ?? null };
  }

  const me = (await res.json()) as { sub?: string; email?: string | null };
  return { id: me.sub ?? null, email: me.email ?? null };
}

/**
 * Return leg. Validates state, exchanges code + verifier, and encrypts the
 * refresh token before it is written anywhere.
 */
export async function completeOAuth(
  request: NextRequest,
  provider: MailProvider,
): Promise<NextResponse> {
  const origin = request.nextUrl.origin;
  const config = providerConfig(provider);
  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/connections?error=${encodeURIComponent(reason)}`);

  const params = request.nextUrl.searchParams;
  const oauthError = params.get("error_description") ?? params.get("error");
  if (oauthError) return fail(oauthError);

  const code = params.get("code");
  const state = params.get("state");
  const expectedState = request.cookies.get(stateCookie(provider))?.value;
  const verifier = request.cookies.get(verifierCookie(provider))?.value;

  if (!code) return fail(`${config.label} sent no authorization code.`);
  if (!state || !expectedState || state !== expectedState) {
    return fail("Sign-in state mismatch. Start the connection again.");
  }
  if (!verifier) return fail("The sign-in attempt expired. Start again.");

  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId as string,
      client_secret: config.clientSecret as string,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri as string,
      code_verifier: verifier,
      // Google rejects a `scope` parameter on the code exchange; Microsoft
      // wants one. Only send it where it belongs.
      ...(provider === "microsoft" ? { scope: config.scopes } : {}),
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    return fail(`Token exchange failed (HTTP ${tokenRes.status}). ${detail.slice(0, 160)}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
  };

  if (!tokens.access_token) return fail(`${config.label} returned no access token.`);

  if (!tokens.refresh_token) {
    // Google's usual failure: consent was already granted, so it returns an
    // access token only and the connection would die in an hour.
    return fail(
      provider === "google"
        ? "Google returned no refresh token. Remove this app at " +
            "myaccount.google.com/permissions and connect again."
        : "Microsoft returned no refresh token. Check that offline_access is granted.",
    );
  }

  const identity = await fetchIdentity(provider, tokens.access_token);
  const now = new Date().toISOString();

  try {
    await writeDoc((current) => ({
      ...current,
      connection: {
        provider,
        email: identity.email,
        providerUserId: identity.id,
        // Encrypted before it touches storage, always.
        refreshTokenEncrypted: encryptToken(tokens.refresh_token as string),
        scopes: (tokens.scope ?? config.scopes).split(" ").filter(Boolean),
        status: "active",
        connectedAt: now,
        lastRefreshedAt: now,
      },
    }));
  } catch (err) {
    return fail(
      `Could not save the connection: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const response = NextResponse.redirect(`${origin}/connections?connected=${provider}`);
  response.cookies.delete(verifierCookie(provider));
  response.cookies.delete(stateCookie(provider));
  return response;
}
