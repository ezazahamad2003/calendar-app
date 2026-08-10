"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";

/**
 * Supabase client for the browser. Carries the *publishable* key, so every
 * query it makes is subject to RLS as the signed-in user — which is the point.
 *
 * This deliberately reads `process.env` directly rather than going through
 * `getEnv()`. That helper validates the whole server schema (secret key, MS
 * credentials, the lot); importing it here would drag those names into the
 * client bundle and throw on the first missing server-only var. Next inlines
 * `NEXT_PUBLIC_*` at build time, so these two are the only ones that exist here.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    // Inlining happens at build time, so an absent value here means the var was
    // missing when the bundle was built — rebuilding is the fix, not a restart.
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be " +
        "set at build time. Add them to .env and rebuild.",
    );
  }

  return createBrowserClient<Database>(url, key);
}
