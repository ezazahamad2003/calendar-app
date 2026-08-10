import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { requireEnv } from "@/lib/env";

/**
 * Supabase client carrying the **secret** key. Bypasses RLS entirely.
 *
 * There is exactly one legitimate reason to use this in Phase 2, and the
 * tenancy migration spells it out: creating an org and its first membership is
 * a chicken-and-egg problem. At that instant `auth_org_ids()` is empty, so no
 * policy can admit the insert, and widening one would let any user attach a
 * membership to someone else's org and read their data. So onboarding runs
 * server-side with this key instead.
 *
 * Rules for every future caller:
 *
 *   1. Never import this from a Client Component. `server-only` will fail the
 *      build if you try, which is the intent.
 *   2. Always scope queries by an `org_id` you derived from a verified session
 *      (see `lib/auth/dal.ts`). RLS is not there to catch your mistake here —
 *      it is switched off.
 *   3. Prefer `lib/supabase/server.ts`. If you cannot articulate why RLS must
 *      be bypassed for a given query, it must not be.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SECRET_KEY"),
    {
      auth: {
        // No cookie, no refresh, no persistence: this client has no user and
        // must never pick one up from ambient state.
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}
