import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";

/**
 * Data Access Layer — the real authorization boundary.
 *
 * `proxy.ts` redirects unauthenticated users, but that is a UX convenience and
 * can be bypassed in ways a route handler cannot afford to trust. Every server
 * entry point that touches org data starts here instead.
 *
 * Each function is wrapped in React's `cache()`, so a page that calls
 * `requireMembership()` in three components pays for one round trip per render
 * pass, not three.
 */

export type OrgRole = Database["public"]["Enums"]["org_role"];

export type Membership = {
  userId: string;
  email: string | null;
  orgId: string;
  orgName: string;
  timezone: string;
  role: OrgRole;
};

/**
 * The signed-in user, or `null`. Use this where being signed out is a normal
 * outcome you want to branch on; use `requireUser()` where it isn't.
 *
 * Always `getUser()`, never `getSession()` — the latter returns whatever is in
 * the cookie without verifying it, which is worthless as an auth check.
 */
export const getUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/** The signed-in user, or a redirect to /login. */
export const requireUser = cache(async () => {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
});

/**
 * The caller's membership, or `null` if they are signed in but not yet in an
 * org — the state a user sits in between confirming their email and finishing
 * onboarding.
 *
 * Reads through the user-scoped client on purpose. RLS restricts this to the
 * caller's own rows, so a bug here leaks nothing; the same query with the
 * admin client would be one missing `.eq()` away from cross-tenant exposure.
 *
 * SPEC scopes v1 to a single org per user, so this takes the earliest
 * membership rather than offering an org switcher.
 */
export const getMembership = cache(async (): Promise<Membership | null> => {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("memberships")
    .select("org_id, role, orgs(name, timezone)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Could not load your organisation membership: ${error.message}. ` +
        `If this persists, sign out and back in.`,
    );
  }
  if (!data?.orgs) return null;

  return {
    userId: user.id,
    email: user.email ?? null,
    orgId: data.org_id,
    orgName: data.orgs.name,
    timezone: data.orgs.timezone,
    role: data.role,
  };
});

/**
 * The caller's membership, or a redirect to onboarding. This is what a page
 * rendering org data should call — it guarantees an `orgId` to scope by.
 */
export const requireMembership = cache(async (): Promise<Membership> => {
  const membership = await getMembership();
  if (!membership) redirect("/onboarding");
  return membership;
});
