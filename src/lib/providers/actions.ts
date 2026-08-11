"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireMembership } from "@/lib/auth/dal";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "./crypto";
import { providerConfig } from "./catalog";

/**
 * Managing connections after they exist: choose which account sends, or drop
 * one entirely. Connecting is the OAuth routes' job; everything else is here.
 *
 * All writes go through the admin client — `provider_connections` was revoked
 * from the authenticated role in Phase 1 — so every query is pinned to the
 * caller's own org and user id. That pinning is the whole authorisation check;
 * there is no RLS underneath to catch a mistake.
 */

const providerSchema = z.object({ provider: z.enum(["microsoft", "google"]) });

/** Make this account the one mail sends from and events land in. */
export async function setPrimaryProvider(input: {
  provider: string;
}): Promise<{ error?: string }> {
  const m = await requireMembership();
  const parsed = providerSchema.safeParse(input);
  if (!parsed.success) return { error: "Unknown provider." };
  const { provider } = parsed.data;

  const admin = createAdminClient();
  const { data: target } = await admin
    .from("provider_connections")
    .select("id, status")
    .eq("org_id", m.orgId)
    .eq("user_id", m.userId)
    .eq("provider", provider)
    .maybeSingle();

  if (!target) return { error: "That account isn't connected." };
  if (target.status !== "active") {
    return { error: "Reconnect that account before sending from it." };
  }

  // Clear first, then set. One primary per user is a partial unique index, so
  // doing it the other way round trips the constraint instead of replacing.
  const { error: clearErr } = await admin
    .from("provider_connections")
    .update({ is_primary: false })
    .eq("org_id", m.orgId)
    .eq("user_id", m.userId)
    .eq("is_primary", true);

  if (clearErr) return { error: `Could not switch accounts: ${clearErr.message}` };

  const { error } = await admin
    .from("provider_connections")
    .update({ is_primary: true })
    .eq("id", target.id);

  if (error) return { error: `Could not switch accounts: ${error.message}` };

  revalidatePath("/connections");
  revalidatePath("/", "layout");
  return {};
}

/**
 * Best-effort revocation at the provider before the row goes.
 *
 * Deleting our copy of the token is what protects the user's data; asking the
 * provider to invalidate it too is the courteous, safer extra. Google offers a
 * revoke endpoint, Microsoft does not — for Outlook the user drops the grant
 * at account.live.com. A failure here must not block the disconnect.
 */
async function revokeAtProvider(
  provider: "microsoft" | "google",
  encryptedRefreshToken: string | null,
): Promise<void> {
  if (provider !== "google" || !encryptedRefreshToken) return;
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: decryptToken(encryptedRefreshToken) }),
    });
  } catch {
    // Network hiccup or an already-dead token. Either way the row still goes.
  }
}

/** Drop a connection. Sends fall back to the other account, or to simulated. */
export async function disconnectProvider(input: {
  provider: string;
}): Promise<{ error?: string }> {
  const m = await requireMembership();
  const parsed = providerSchema.safeParse(input);
  if (!parsed.success) return { error: "Unknown provider." };
  const { provider } = parsed.data;

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("provider_connections")
    .select("id, is_primary, refresh_token_encrypted")
    .eq("org_id", m.orgId)
    .eq("user_id", m.userId)
    .eq("provider", provider)
    .maybeSingle();

  if (!row) return {};

  await revokeAtProvider(provider, row.refresh_token_encrypted);

  const { error } = await admin.from("provider_connections").delete().eq("id", row.id);
  if (error) {
    return { error: `Could not disconnect ${providerConfig(provider).label}: ${error.message}` };
  }

  // If the account that just left was the primary, hand the slot to whatever
  // active connection remains rather than leaving the user with connected
  // accounts and simulated sends.
  if (row.is_primary) {
    const { data: survivor } = await admin
      .from("provider_connections")
      .select("id")
      .eq("org_id", m.orgId)
      .eq("user_id", m.userId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (survivor) {
      await admin
        .from("provider_connections")
        .update({ is_primary: true })
        .eq("id", survivor.id);
    }
  }

  revalidatePath("/connections");
  revalidatePath("/", "layout");
  return {};
}
