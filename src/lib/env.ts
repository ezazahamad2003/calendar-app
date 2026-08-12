import { z } from "zod";

/**
 * Environment validation.
 *
 * Every variable the app reads is declared here and nowhere else. Validation
 * runs once at boot via `src/instrumentation.ts`, and a missing or malformed
 * value aborts with one message listing every problem — you fix them all in a
 * single pass rather than one restart at a time.
 *
 * The list is short now by design. Dropping Supabase, both OAuth providers, the
 * calendar sync and finally the passcode took twenty-one variables with them.
 * What is left is a URL, a storage token, and two optional API keys — nothing
 * here is required for `pnpm dev` to run.
 */

const trueish = new Set(["1", "true", "yes", "on"]);
const boolFlag = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : trueish.has(v.toLowerCase())));

/** Validated only if provided. `FOO=` in a .env file counts as absent. */
const optionalString = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(1).optional(),
  );

const serverSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    /** Absolute, and used to build the share link that gets texted to the crew. */
    NEXT_PUBLIC_APP_URL: z
      .string()
      .trim()
      .min(1, "NEXT_PUBLIC_APP_URL is required")
      .pipe(z.url()),

    // ── Storage ───────────────────────────────────────────────────────────────
    // Unset locally: the store falls back to `data/schedule.json`. Required on
    // Vercel, where the filesystem does not persist — `driver.ts` says so with
    // instructions rather than losing writes quietly.
    BLOB_READ_WRITE_TOKEN: optionalString(),

    // ── Voice ─────────────────────────────────────────────────────────────────
    OPENAI_API_KEY: optionalString(),
    OPENAI_STT_MODEL: z.string().trim().min(1).default("whisper-1"),
    OPENAI_PLANNER_MODEL: z.string().trim().min(1).default("gpt-4o"),

    // ── Email ─────────────────────────────────────────────────────────────────
    // Unset means the console driver: notifications are composed, recorded and
    // shown in the app, but nothing leaves the building. That is the right
    // default for a schedule full of real subcontractors.
    RESEND_API_KEY: optionalString(),
    /** Must be on a domain verified with Resend, or every send bounces. */
    MAIL_FROM: optionalString(),
    /** Replies from subs should reach a person, not the sending domain. */
    MAIL_REPLY_TO: optionalString(),

    // ── Feature flags ─────────────────────────────────────────────────────────
    /** Off sends nothing regardless of key — the switch for a dry run on real data. */
    FEATURE_SEND_EMAIL: boolFlag(true),
  });

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Fix the following, then restart:\n${problems}\n\n` +
        `See .env.example for the full list.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Read a variable that is optional at boot but required by the feature calling
 * it. Fails with a named, actionable error instead of a 401 from someone
 * else's API.
 */
export function requireEnv<K extends keyof ServerEnv>(key: K): NonNullable<ServerEnv[K]> {
  const value = getEnv()[key];
  if (value == null || value === "") {
    throw new Error(
      `${String(key)} is not set, and this feature needs it. ` +
        `Add it to your environment (see .env.example) and restart.`,
    );
  }
  return value as NonNullable<ServerEnv[K]>;
}

/** Tests mutate `process.env` and need the cache dropped. */
export function resetEnvCache(): void {
  cached = null;
}
