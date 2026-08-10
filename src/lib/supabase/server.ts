import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";
import { requireEnv } from "@/lib/env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Carries the publishable key and the caller's session cookies, so RLS applies
 * exactly as it does in the browser. This is the client to reach for by
 * default; `createAdminClient()` is the exception, not the rule.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. That is fine and expected:
            // `proxy.ts` refreshes the session on every request, so a token
            // rotated during a render is persisted there instead. Swallowing
            // this is the documented pattern, not a shrug.
          }
        },
      },
    },
  );
}
