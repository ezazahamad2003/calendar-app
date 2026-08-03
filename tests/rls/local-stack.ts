import { execSync } from "node:child_process";
import { z } from "zod";

/**
 * Connection details for the local Supabase stack (`supabase start`).
 *
 * RLS tests run against local, never against the hosted project: they create
 * throwaway orgs, users and Microsoft-connection rows, and none of that belongs
 * in a real database.
 */

const statusSchema = z.object({
  API_URL: z.url(),
  ANON_KEY: z.string().min(1),
  SERVICE_ROLE_KEY: z.string().min(1),
});

export type LocalStack = {
  /** PostgREST/Auth endpoint, e.g. http://127.0.0.1:54321 */
  apiUrl: string;
  /** Client role. Subject to RLS — this is what the browser would hold. */
  anonKey: string;
  /** Bypasses RLS. Used only to seed fixtures and to verify what the client cannot see. */
  serviceRoleKey: string;
};

let cached: LocalStack | null = null;

export function localStack(): LocalStack {
  if (cached) return cached;

  let raw: string;
  try {
    raw = execSync("npx supabase status -o json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "Could not read the local Supabase stack. Start it first:\n\n" +
        "  pnpm db:start\n\n" +
        "(RLS tests never run against the hosted project — they create throwaway users.)",
    );
  }

  const parsed = statusSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Unexpected output from \`supabase status\`: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ")}`,
    );
  }

  cached = {
    apiUrl: parsed.data.API_URL,
    anonKey: parsed.data.ANON_KEY,
    serviceRoleKey: parsed.data.SERVICE_ROLE_KEY,
  };
  return cached;
}
