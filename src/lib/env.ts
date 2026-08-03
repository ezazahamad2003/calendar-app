import { z } from "zod";

/**
 * Environment validation for Foreman.
 *
 * Every variable the app reads is declared here and nowhere else. If a new
 * variable is needed, add it to `.env.example` first, then here. See SPEC §1.
 *
 * Validation runs once at server boot via `src/instrumentation.ts`. Missing or
 * malformed *required* vars abort boot with a single message listing every
 * problem — you fix them all in one pass, not one reboot at a time.
 *
 * Phasing: variables belonging to features not yet wired (Supabase in Phase 1,
 * Microsoft Graph in Phase 7) are optional-but-format-checked. They are not
 * required to boot Phase 0, but if you fill them in with a malformed value you
 * hear about it immediately. Access them through `requireEnv()` at the point of
 * use so a feature that needs an unset var fails with a clear, named error.
 */

const trueish = new Set(["1", "true", "yes", "on"]);
const boolFlag = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : trueish.has(v.toLowerCase())));

/** Present and non-empty. Empty string in `.env` counts as absent. */
const requiredString = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`);

/**
 * Validated only if provided. An empty string in `.env` (`MS_CLIENT_ID=`) is
 * treated as absent, not as an invalid zero-length value — so unset Phase-7
 * vars don't block Phase-0 boot.
 */
const optionalString = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(1).optional(),
  );

/**
 * `.env.example` fills unknown values with `xxxx` runs and a literal `PASSWORD`
 * inside the Postgres URLs. Copying the example across and missing a line is the
 * most common setup mistake, and a half-filled value fails far from its cause —
 * a 401 from Supabase, a DNS error on the fake `aws-0-region` host — so catch it
 * at boot instead.
 */
const PLACEHOLDER = /xxxx|:PASSWORD@|aws-0-region/i;

const notPlaceholder = (v: unknown) => typeof v !== "string" || !PLACEHOLDER.test(v);

const placeholderMessage = (label: string) =>
  `${label} is still the .env.example placeholder — replace it with the real value`;

/** Optional, but if set must be a real `postgresql://` connection string. */
const postgresUrl = (label: string) =>
  optionalString()
    .pipe(
      z
        .string()
        .regex(/^postgres(ql)?:\/\/./, `${label} must be a postgresql:// connection string`)
        .optional(),
    )
    .refine(notPlaceholder, placeholderMessage(label));

const serverSchema = z.object({
  // ── App (required to boot) ────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: requiredString("NEXT_PUBLIC_APP_URL").pipe(z.url()),

  // 32 raw bytes, base64-encoded → AES-256-GCM key. `openssl rand -base64 32`.
  TOKEN_ENCRYPTION_KEY: requiredString("TOKEN_ENCRYPTION_KEY").refine(
    (v) => tryDecodeBytes(v) === 32,
    "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)",
  ),
  CRON_SECRET: requiredString("CRON_SECRET"),

  // ── Supabase (Phase 1+) ───────────────────────────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: optionalString()
    .pipe(z.url().optional())
    .refine(notPlaceholder, placeholderMessage("NEXT_PUBLIC_SUPABASE_URL")),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalString().refine(
    notPlaceholder,
    placeholderMessage("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  ),
  SUPABASE_SECRET_KEY: optionalString().refine(
    notPlaceholder,
    placeholderMessage("SUPABASE_SECRET_KEY"),
  ),
  DATABASE_URL: postgresUrl("DATABASE_URL"),
  DIRECT_URL: postgresUrl("DIRECT_URL"),

  // ── OpenAI (Phase 5+) ─────────────────────────────────────────────────────
  OPENAI_API_KEY: optionalString().refine(
    notPlaceholder,
    placeholderMessage("OPENAI_API_KEY"),
  ),
  OPENAI_STT_MODEL: z.string().trim().min(1).default("whisper-1"),
  OPENAI_PLANNER_MODEL: z.string().trim().min(1).default("gpt-4o"),

  // ── Microsoft Graph (Phase 7) ─────────────────────────────────────────────
  MS_CLIENT_ID: optionalString(),
  MS_CLIENT_SECRET: optionalString(),
  MS_TENANT_ID: z.string().trim().min(1).default("common"),
  MS_REDIRECT_URI: optionalString().pipe(z.url().optional()),
  MS_SCOPES: z
    .string()
    .trim()
    .min(1)
    .default("offline_access User.Read Mail.Send Calendars.ReadWrite"),

  // ── Feature flags ─────────────────────────────────────────────────────────
  FEATURE_CONFIRM_BEFORE_SEND: boolFlag(true),
  FEATURE_INVITE_ATTENDEES: boolFlag(true),
  FEATURE_TWO_WAY_CALENDAR_SYNC: boolFlag(false),
});

export type ServerEnv = z.infer<typeof serverSchema>;

function tryDecodeBytes(base64: string): number | null {
  try {
    return Buffer.from(base64, "base64").length;
  } catch {
    return null;
  }
}

let cached: ServerEnv | null = null;

/**
 * Parse and cache the server environment. Throws a single aggregated error
 * listing every missing/invalid variable. Safe to call repeatedly.
 */
export function getEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Fix the following in your .env, ` +
        `then restart:\n${problems}\n\nSee .env.example for the full list.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Read a variable that is optional at boot but required by the feature calling
 * it (e.g. a Supabase key inside a DB call). Throws a clear, named error naming
 * the variable and what to do, instead of failing deep in a client library.
 */
export function requireEnv<K extends keyof ServerEnv>(key: K): NonNullable<ServerEnv[K]> {
  const value = getEnv()[key];
  if (value == null || value === "") {
    throw new Error(
      `${String(key)} is not set. This feature needs it — add it to your .env ` +
        `(see .env.example) and restart.`,
    );
  }
  return value as NonNullable<ServerEnv[K]>;
}
