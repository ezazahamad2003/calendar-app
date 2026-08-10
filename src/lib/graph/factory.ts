import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { MockGraphClient } from "./mock";
import { RealGraphClient } from "./real";
import type { GraphClient } from "./client";

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
export async function msConnectionState(
  orgId: string,
  userId: string,
): Promise<{ connected: boolean; needsReauth: boolean; email: string | null }> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ms_connections")
    .select("status, email")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();

  return {
    connected: data?.status === "active",
    needsReauth: data?.status === "needs_reauth",
    email: data?.email ?? null,
  };
}
