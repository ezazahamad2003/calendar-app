import { z } from "zod";

/**
 * Environment validation.
 *
 * Every variable the app reads is declared here and nowhere else. Validation
 * runs once at boot via `src/instrumentation.ts`, and a missing or malformed
 * value aborts with one message listing every problem — you fix them all in a
 * single pass rather than one restart at a time.
 *
 * The list is short now by design. Dropping Supabase, both OAuth providers and
 * the calendar sync took nineteen variables with them; what is left is a
 * passcode, a signing secret, and two optional API keys.
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

/** The stand-in used when no secret is supplied. Public, hence refused in production. */
const DEV_SESSION_SECRET = "dev-only-insecure-session-secret-do-not-ship-abcdef";

/**
 * Whether to insist on the production-only secrets.
 *
 * `next build` runs with `NODE_ENV=production`, so a naive check makes the
 * *build* require the passcode and the session secret. That is the wrong place
 * to demand them: it stops `pnpm build` working on a clean checkout, breaks CI,
 * and blocks the very verification step DEPLOYMENT.md tells you to run. Nothing
 * is being served during a build, so nothing is exposed by their absence.
 *
 * `NEXT_PHASE` is set by Next only while building, which is what separates
 * "compiling this app" from "running it". At runtime the secrets are still
 * required — see `configProblems()`, which locks the app without taking it
 * down.
 */
const isBuilding = process.env.NEXT_PHASE === "phase-production-build";
const isProduction = process.env.NODE_ENV === "production" && !isBuilding;

/**
 * The passcode is the only thing between a public URL and a button that emails
 * subcontractors, so it has a floor. Sixteen characters of passphrase is easy
 * to say out loud and to type on a phone once a year, and far past what the
 * per-instance throttle in `auth.ts` could be relied on to protect.
 */
const passcode = optionalString().pipe(
  z
    .string()
    .min(16, "ADMIN_PASSCODE must be at least 16 characters")
    .optional(),
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

    // ── Access ────────────────────────────────────────────────────────────────
    // Optional here so a fresh clone runs `pnpm dev` with no setup; required in
    // production by the refinement below, because an ungated deployment is an
    // open Send button.
    ADMIN_PASSCODE: passcode,

    /**
     * Signs the "remember this device" cookie. Rotating it signs everyone out.
     *
     * An empty value falls back to the development default rather than failing
     * the schema. Adding the key in a hosting dashboard and leaving the box
     * blank is a two-second mistake, and treating it as *malformed* rather
     * than *absent* used to abort the whole process — the app went down
     * instead of politely telling you to fill it in.
     */
    SESSION_SECRET: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .string()
        .trim()
        .min(32, "SESSION_SECRET must be at least 32 characters (openssl rand -base64 32)")
        .default(DEV_SESSION_SECRET),
    ),

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

export type ConfigProblem = { variable: string; message: string };

/**
 * What is missing before this deployment may serve.
 *
 * Reported rather than thrown, and that distinction is the whole point of this
 * function. These used to be schema refinements, so a deployment without them
 * threw out of `getEnv()` — which runs in the instrumentation hook, which took
 * the Node process down with it. Every route returned an opaque 500 including
 * `/gate`, the one page whose entire job is to let you in and tell you what is
 * wrong. The person deploying saw a blank error page and had no way to find
 * out why.
 *
 * So the app now stays up and stays *locked*: `isOwner()` refuses while this
 * list is non-empty, so nothing is editable and nothing can be sent, and
 * `/gate` renders the list instead of a schedule. Failing closed and failing
 * legibly are not in tension; the previous version just did the first one.
 */
export function configProblems(): ConfigProblem[] {
  if (!isProduction) return [];

  let env: ServerEnv;
  try {
    env = getEnv();
  } catch (err) {
    // A malformed value is also "something wrong with this deployment", and
    // the setup screen is the right place to say so. Letting this escape would
    // 500 the only page that could have explained it.
    return [
      {
        variable: "Environment",
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  const problems: ConfigProblem[] = [];

  if (!env.ADMIN_PASSCODE) {
    problems.push({
      variable: "ADMIN_PASSCODE",
      message:
        "The passcode that lets you in. At least 16 characters. Without it the " +
        "schedule would be editable by anyone who found the URL, so the app " +
        "stays locked until it is set.",
    });
  }
  if (env.SESSION_SECRET === DEV_SESSION_SECRET) {
    problems.push({
      variable: "SESSION_SECRET",
      message:
        "Still the built-in development value, which is public — anyone could " +
        "forge a session with it. Generate one with `openssl rand -base64 32`.",
    });
  }
  if (env.RESEND_API_KEY && !env.MAIL_FROM) {
    problems.push({
      variable: "MAIL_FROM",
      message:
        "Required once RESEND_API_KEY is set: Resend rejects a send with no " +
        "verified from-address, so every notification would fail.",
    });
  }

  return problems;
}

/** True when this deployment is configured well enough to be used. */
export function isConfigured(): boolean {
  return configProblems().length === 0;
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
