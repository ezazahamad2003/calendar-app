import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { PROVIDERS, providerConfig, providerConfigured } from "./catalog";
import { MockProviderClient } from "./mock";
import { MicrosoftClient } from "./microsoft";
import { GoogleClient } from "./google";
import type { MailCalendarClient, Provider } from "./client";
import type { ConnectionRow } from "./token";

/**
 * Which client does a given user get? (SPEC §6→§7 seam.)
 *
 *   primary active connection → that provider's real client
 *   anything else             → MockProviderClient (logged, fixture ids)
 *
 * "Primary" is the user's own choice on /connections, not something inferred
 * here. Someone with both accounts connected has one place mail goes out from,
 * and they picked it; the database enforces there is exactly one.
 *
 * Callers get `mocked` so the UI can say "simulated — connect an account to
 * send for real" instead of letting a mock send look like a real one.
 */

export type ClientSelection = {
  client: MailCalendarClient;
  mocked: boolean;
  /** Which provider is actually sending, when not mocked. */
  provider: Provider | null;
  /** Set when a connection exists but needs re-consent. */
  needsReauth: boolean;
};

const MOCKED: ClientSelection = {
  client: new MockProviderClient(),
  mocked: true,
  provider: null,
  needsReauth: false,
};

function realClient(row: ConnectionRow): MailCalendarClient {
  return row.provider === "google" ? new GoogleClient(row) : new MicrosoftClient(row);
}

export async function providerClientFor(
  orgId: string,
  userId: string,
): Promise<ClientSelection> {
  // Neither provider set up in this environment: no table to read, nothing to
  // pick from. (This has to stay a check, not a throw — see providerConfigured.)
  if (!PROVIDERS.some(providerConfigured)) return { ...MOCKED, client: new MockProviderClient() };

  const admin = createAdminClient();
  const { data } = await admin
    .from("provider_connections")
    .select("id, provider, refresh_token_encrypted, status, is_primary")
    .eq("org_id", orgId)
    .eq("user_id", userId);

  const rows = data ?? [];
  // Fall back to any active connection if the primary flag somehow points at a
  // dead one — a user with a working Gmail should not get simulated sends
  // because their Outlook grant expired while it held the primary slot.
  const usable = rows.filter(
    (r) => r.status === "active" && r.refresh_token_encrypted && providerConfigured(r.provider),
  );
  const chosen = usable.find((r) => r.is_primary) ?? usable[0];

  if (chosen) {
    return {
      client: realClient(chosen as ConnectionRow),
      mocked: false,
      provider: chosen.provider,
      needsReauth: false,
    };
  }

  return {
    ...MOCKED,
    client: new MockProviderClient(),
    needsReauth: rows.some((r) => r.status === "needs_reauth"),
  };
}

/** One provider's state, as the Connections page and the rail need it. */
export type ConnectionState = {
  provider: Provider;
  label: string;
  detail: string;
  connectPath: string;
  /** False when this provider is not set up in this environment at all. */
  available: boolean;
  connected: boolean;
  needsReauth: boolean;
  isPrimary: boolean;
  email: string | null;
  connectedAt: string | null;
};

/**
 * State for every provider, in catalog order.
 *
 * Never throws. This runs in the authenticated layout, so anything that can
 * fail here fails on every page at once — a missing key, a transient database
 * error, a revoked grant. All of those mean the same thing to the UI: no
 * outside account right now. The scheduling app keeps working regardless;
 * mail and calendar are an add-on to it, not a dependency of it.
 */
export async function connectionStates(
  orgId: string,
  userId: string,
): Promise<ConnectionState[]> {
  const base = PROVIDERS.map((provider): ConnectionState => {
    const config = providerConfig(provider);
    return {
      provider,
      label: config.label,
      detail: config.detail,
      connectPath: config.connectPath,
      available: providerConfigured(provider),
      connected: false,
      needsReauth: false,
      isPrimary: false,
      email: null,
      connectedAt: null,
    };
  });

  if (!base.some((s) => s.available)) return base;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("provider_connections")
      .select("provider, status, email, is_primary, connected_at")
      .eq("org_id", orgId)
      .eq("user_id", userId);

    if (error) return base;

    return base.map((state) => {
      const row = data?.find((r) => r.provider === state.provider);
      if (!row) return state;
      return {
        ...state,
        connected: row.status === "active",
        needsReauth: row.status === "needs_reauth",
        isPrimary: row.is_primary,
        email: row.email,
        connectedAt: row.connected_at,
      };
    });
  } catch {
    return base;
  }
}

/** Compact summary for the rail and the outbox banner. */
export type ConnectionSummary = {
  /** Any provider configured in this environment at all? */
  anyAvailable: boolean;
  /** The provider mail actually sends through, if any. */
  active: ConnectionState | null;
  /** Connected accounts that have gone stale and need re-consent. */
  stale: ConnectionState[];
  states: ConnectionState[];
};

export function summarize(states: ConnectionState[]): ConnectionSummary {
  const connected = states.filter((s) => s.connected);
  return {
    anyAvailable: states.some((s) => s.available),
    active: connected.find((s) => s.isPrimary) ?? connected[0] ?? null,
    stale: states.filter((s) => s.needsReauth),
    states,
  };
}
