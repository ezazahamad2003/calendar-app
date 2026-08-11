import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";

import { requireMembership } from "@/lib/auth/dal";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";
import { encryptToken } from "./crypto";
import { missingProviderEnv, providerConfig } from "./catalog";
import type { Provider } from "./client";

/**
 * The OAuth dance, once, for both providers (SPEC §6: authorization code +
 * PKCE). Microsoft and Google differ only in endpoints, scopes, and a couple
 * of query params — all of which live in `catalog.ts` — so the routes under
 * /api/microsoft and /api/google are thin wrappers around these two functions.
 *
 * The Microsoft route paths are deliberately unchanged from when it was the
 * only provider: they are registered as redirect URIs in Entra, and moving
 * them would break every existing connection for the sake of symmetry.
 */

/** Per-provider cookie names, so connecting both in two tabs can't collide. */
const verifierCookie = (p: Provider) => `${p}_pkce_verifier`;
const stateCookie = (p: Provider) => `${p}_oauth_state`;

function cookieOptions(provider: Provider) {
  return {
    httpOnly: true,
    secure: getEnv().NODE_ENV === "production",
    sameSite: "lax" as const,
    // Scoped to this provider's routes — the cookies only need to survive the
    // round trip to the consent screen and back.
    path: `/api/${provider === "microsoft" ? "microsoft" : "google"}`,
    maxAge: 600,
  };
}

/** Outbound leg: redirect the user to the provider's consent screen. */
export async function startOAuth(
  request: NextRequest,
  provider: Provider,
): Promise<NextResponse> {
  try {
    await requireMembership();
  } catch {
    return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  }

  // A half-configured environment should say so, not throw a 500.
  const missing = missingProviderEnv(provider);
  const config = providerConfig(provider);

  if (missing.length > 0) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/connections?error=${encodeURIComponent(
        `${config.label} isn't configured here — missing ${missing.join(", ")}.`,
      )}`,
    );
  }

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const authorize = new URL(config.authorizeUrl);
  authorize.searchParams.set("client_id", config.clientId!);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", config.redirectUri!);
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
  provider: Provider,
  accessToken: string,
): Promise<{ id: string | null; email: string | null }> {
  const url =
    provider === "microsoft"
      ? "https://graph.microsoft.com/v1.0/me"
      : "https://www.googleapis.com/oauth2/v3/userinfo";

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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
 * Return leg. Validates state, exchanges code+verifier, encrypts the refresh
 * token before it touches the database (SPEC §6), and upserts the row through
 * the admin client — the only road to that table, since the client role was
 * revoked in Phase 1.
 */
export async function completeOAuth(
  request: NextRequest,
  provider: Provider,
): Promise<NextResponse> {
  const origin = request.nextUrl.origin;
  const config = providerConfig(provider);
  const fail = (reason: string) =>
    NextResponse.redirect(
      `${origin}/connections?error=${encodeURIComponent(reason)}`,
    );

  let membership;
  try {
    membership = await requireMembership();
  } catch {
    return NextResponse.redirect(`${origin}/login`);
  }

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
      client_id: config.clientId!,
      client_secret: config.clientSecret!,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri!,
      code_verifier: verifier,
      // Google rejects a `scope` parameter on the code exchange; Microsoft
      // wants one. Only send it where it belongs.
      ...(provider === "microsoft" ? { scope: config.scopes } : {}),
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    return fail(
      `Token exchange failed (HTTP ${tokenRes.status}). ${detail.slice(0, 160)}`,
    );
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
  };
  if (!tokens.access_token) {
    return fail(`${config.label} returned no access token.`);
  }
  if (!tokens.refresh_token) {
    // Google's failure mode: consent already granted, so it hands back an
    // access token only and the connection would die in an hour.
    return fail(
      provider === "google"
        ? "Google returned no refresh token. Remove this app at " +
            "myaccount.google.com/permissions and connect again."
        : "Microsoft returned no refresh token. Check that offline_access is granted.",
    );
  }

  const identity = await fetchIdentity(provider, tokens.access_token);
  const admin = createAdminClient();

  // Primary = where mail actually sends from. First connection wins it; any
  // later one joins as a secondary and the user can promote it on /connections.
  // Computed before the write because the database enforces one primary per
  // user with a partial unique index — two primaries is the state where the
  // app cannot answer "send from where?".
  const { data: existing } = await admin
    .from("provider_connections")
    .select("provider, is_primary")
    .eq("org_id", membership.orgId)
    .eq("user_id", membership.userId);

  const hasPrimaryElsewhere = (existing ?? []).some(
    (row) => row.is_primary && row.provider !== provider,
  );

  const { error } = await admin.from("provider_connections").upsert(
    {
      org_id: membership.orgId,
      user_id: membership.userId,
      provider,
      provider_user_id: identity.id,
      email: identity.email,
      refresh_token_encrypted: encryptToken(tokens.refresh_token),
      scopes: (tokens.scope ?? config.scopes).split(" ").filter(Boolean),
      status: "active",
      is_primary: !hasPrimaryElsewhere,
      connected_at: new Date().toISOString(),
      last_refreshed_at: new Date().toISOString(),
    },
    { onConflict: "org_id,user_id,provider" },
  );

  if (error) return fail(`Could not save the connection: ${error.message}`);

  const response = NextResponse.redirect(`${origin}/connections?connected=${provider}`);
  response.cookies.delete(verifierCookie(provider));
  response.cookies.delete(stateCookie(provider));
  return response;
}
