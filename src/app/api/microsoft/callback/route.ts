import { NextResponse, type NextRequest } from "next/server";

import { requireMembership } from "@/lib/auth/dal";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/graph/crypto";
import { getEnv, requireEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth return leg. Validates state, exchanges code+verifier, encrypts the
 * refresh token before it touches the database (SPEC §6), and upserts the
 * caller's ms_connections row through the admin client — the only road to
 * that table, since the client role was revoked in Phase 1.
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/?ms_error=${encodeURIComponent(reason)}`);

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
  const expectedState = request.cookies.get("ms_oauth_state")?.value;
  const verifier = request.cookies.get("ms_pkce_verifier")?.value;

  if (!code) return fail("Microsoft sent no authorization code.");
  if (!state || !expectedState || state !== expectedState) {
    return fail("Sign-in state mismatch. Start the connection again.");
  }
  if (!verifier) return fail("The sign-in attempt expired. Start again.");

  const env = getEnv();
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: requireEnv("MS_CLIENT_ID"),
        client_secret: requireEnv("MS_CLIENT_SECRET"),
        grant_type: "authorization_code",
        code,
        redirect_uri: requireEnv("MS_REDIRECT_URI"),
        code_verifier: verifier,
        scope: env.MS_SCOPES,
      }),
    },
  );

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    return fail(`Token exchange failed (HTTP ${tokenRes.status}). ${detail.slice(0, 160)}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
  };
  if (!tokens.refresh_token || !tokens.access_token) {
    return fail(
      "Microsoft returned no refresh token. Check that offline_access is granted.",
    );
  }

  // Who connected? /me gives the stable id and address for the row.
  const meRes = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const me = meRes.ok
    ? ((await meRes.json()) as {
        id?: string;
        mail?: string | null;
        userPrincipalName?: string | null;
      })
    : {};

  const admin = createAdminClient();
  const { error } = await admin.from("ms_connections").upsert(
    {
      org_id: membership.orgId,
      user_id: membership.userId,
      ms_user_id: me.id ?? null,
      email: me.mail ?? me.userPrincipalName ?? null,
      refresh_token_encrypted: encryptToken(tokens.refresh_token),
      scopes: (tokens.scope ?? env.MS_SCOPES).split(" ").filter(Boolean),
      status: "active",
      connected_at: new Date().toISOString(),
      last_refreshed_at: new Date().toISOString(),
    },
    { onConflict: "org_id,user_id" },
  );

  if (error) return fail(`Could not save the connection: ${error.message}`);

  const response = NextResponse.redirect(`${origin}/?ms_connected=1`);
  response.cookies.delete("ms_pkce_verifier");
  response.cookies.delete("ms_oauth_state");
  return response;
}
