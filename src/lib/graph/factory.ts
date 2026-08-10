import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";
import { MockGraphClient } from "./mock";
import { RealGraphClient } from "./real";
import type { GraphClient } from "./client";

/**
 * Is the Microsoft integration configured at all?
 *
 * `ms_connections` is reachable only through the secret key, so without it the
 * integration simply does not exist. This has to be a *check*, not a throw:
 * the connection status is read by the authenticated layout on every page, and
 * an unconfigured optional integration must never take down the whole app.
 * (It did exactly that once — every signed-in route 500ing on a missing key.)
 */
function graphConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.SUPABASE_SECRET_KEY && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
}

/**
 * Pick the Graph client for a user (SPEC §6→§7 seam).
 *
 *   active ms_connection  → RealGraphClient (their own Outlook)
 *   anything else         → MockGraphClient (logged, fixture ids)
 *
 * Callers get `mocked` so the UI can say "simulated — connect Outlook to send
 * for real" instead of letting a mock send look like a real one.
 */
export type GraphSelection = {
  client: GraphClient;
  mocked: boolean;
  /** Set when a connection exists but needs re-consent. */
  needsReauth: boolean;
};

export async function graphClientFor(
  orgId: string,
  userId: string,
): Promise<GraphSelection> {
  if (!graphConfigured()) {
    return { client: new MockGraphClient(), mocked: true, needsReauth: false };
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("ms_connections")
    .select("id, refresh_token_encrypted, status")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();

  if (data && data.status === "active" && data.refresh_token_encrypted) {
    return { client: new RealGraphClient(data), mocked: false, needsReauth: false };
  }

  return {
    client: new MockGraphClient(),
    mocked: true,
    needsReauth: data?.status === "needs_reauth",
  };
}

/** Connection state for the banner and the dashboard button. */
export type MsConnectionState = {
  connected: boolean;
  needsReauth: boolean;
  email: string | null;
  /** False when the integration is not set up in this environment. */
  available: boolean;
};

const UNAVAILABLE: MsConnectionState = {
  connected: false,
  needsReauth: false,
  email: null,
  available: false,
};

/**
 * Connection state for the rail and the reauth banner.
 *
 * Never throws. This runs in the authenticated layout, so anything that can
 * fail here fails on every page at once — a missing key, a transient database
 * error, a revoked grant. All of those mean the same thing to the UI: no
 * Outlook right now. The scheduling app keeps working regardless; Microsoft
 * is an add-on to it, not a dependency of it.
 */
export async function msConnectionState(
  orgId: string,
  userId: string,
): Promise<MsConnectionState> {
  if (!graphConfigured()) return UNAVAILABLE;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ms_connections")
      .select("status, email")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) return UNAVAILABLE;

    return {
      connected: data?.status === "active",
      needsReauth: data?.status === "needs_reauth",
      email: data?.email ?? null,
      available: true,
    };
  } catch {
    return UNAVAILABLE;
  }
}
