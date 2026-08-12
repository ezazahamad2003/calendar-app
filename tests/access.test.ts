import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvCache } from "@/lib/env";

/**
 * The passcode gate and the read-only link.
 *
 * `next/headers` is stubbed with a cookie jar, so these exercise the real
 * signing and comparison rather than a mock of them.
 */

const jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

const PASSCODE = "cold-slab-tuesday-rebar";

function setNodeEnv(value: string): void {
  (process.env as Record<string, string>).NODE_ENV = value;
}

beforeEach(() => {
  jar.clear();
  vi.resetModules();
  resetEnvCache();
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-1234";
  process.env.ADMIN_PASSCODE = PASSCODE;
  // `NODE_ENV` is typed read-only; these tests deliberately change it to
  // exercise the production-only refusals.
  setNodeEnv("test");
});

afterEach(() => {
  resetEnvCache();
});

async function auth() {
  return import("@/lib/auth");
}

describe("the passcode", () => {
  it("lets the right one in and remembers the device", async () => {
    const { signIn, isOwner } = await auth();

    expect(await isOwner()).toBe(false);
    const result = await signIn(PASSCODE, "1.2.3.4");
    expect(result.ok).toBe(true);
    expect(await isOwner()).toBe(true);
  });

  it("turns the wrong one away", async () => {
    const { signIn, isOwner } = await auth();
    const result = await signIn("not-the-passcode-at-all", "1.2.3.4");
    expect(result.ok).toBe(false);
    expect(await isOwner()).toBe(false);
  });

  it("is not fooled by a prefix of the real passcode", async () => {
    const { signIn } = await auth();
    expect((await signIn(PASSCODE.slice(0, -1), "1.2.3.4")).ok).toBe(false);
    expect((await signIn(`${PASSCODE}x`, "1.2.3.4")).ok).toBe(false);
  });

  it("signs out", async () => {
    const { signIn, signOut, isOwner } = await auth();
    await signIn(PASSCODE, "1.2.3.4");
    await signOut();
    expect(await isOwner()).toBe(false);
  });

  it("rejects a forged cookie", async () => {
    const { isOwner } = await auth();
    // A far-future expiry with a made-up signature: the shape is right and the
    // HMAC is not.
    jar.set("foreman_owner", `${Date.now() + 999_999_999}.not-a-real-signature`);
    expect(await isOwner()).toBe(false);
  });

  it("rejects a cookie signed with a different secret", async () => {
    const { signIn } = await auth();
    await signIn(PASSCODE, "1.2.3.4");
    const stolen = jar.get("foreman_owner");

    // Rotating the secret must sign everybody out.
    vi.resetModules();
    resetEnvCache();
    process.env.SESSION_SECRET = "a-completely-different-secret-value-9876";
    const { isOwner } = await auth();
    jar.set("foreman_owner", stolen as string);
    expect(await isOwner()).toBe(false);
  });

  it("rejects an expired cookie", async () => {
    const { isOwner } = await auth();
    const { createHmac } = await import("node:crypto");
    const payload = String(Date.now() - 1000);
    const signature = createHmac("sha256", process.env.SESSION_SECRET as string)
      .update(payload)
      .digest("base64url");
    // Correctly signed, but in the past.
    jar.set("foreman_owner", `${payload}.${signature}`);
    expect(await isOwner()).toBe(false);
  });

  it("locks out after repeated wrong guesses", async () => {
    const { signIn } = await auth();
    for (let i = 0; i < 8; i += 1) await signIn("wrong-guess-number-x", "9.9.9.9");

    const result = await signIn(PASSCODE, "9.9.9.9");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too many tries/i);
  });

  it("does not lock out a different address", async () => {
    const { signIn } = await auth();
    for (let i = 0; i < 8; i += 1) await signIn("wrong-guess-number-x", "9.9.9.9");
    expect((await signIn(PASSCODE, "5.5.5.5")).ok).toBe(true);
  });
});

describe("an unconfigured production deployment", () => {
  /** Run `body` as if this were an unconfigured production deployment. */
  async function inBrokenProduction(body: () => Promise<void>) {
    const previousEnv = process.env.NODE_ENV as string;
    const previousPasscode = process.env.ADMIN_PASSCODE;
    const previousSecret = process.env.SESSION_SECRET;

    resetEnvCache();
    setNodeEnv("production");
    delete process.env.ADMIN_PASSCODE;
    process.env.SESSION_SECRET = "dev-only-insecure-session-secret-do-not-ship-abcdef";
    vi.resetModules();

    try {
      await body();
    } finally {
      setNodeEnv(previousEnv);
      if (previousPasscode === undefined) delete process.env.ADMIN_PASSCODE;
      else process.env.ADMIN_PASSCODE = previousPasscode;
      if (previousSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSecret;
      resetEnvCache();
      vi.resetModules();
    }
  }

  // The whole point of reporting rather than throwing. A throw out of getEnv()
  // runs in the instrumentation hook, which kills the Node process, which
  // 500s every route — including /gate, the one page that could have said
  // what was wrong. The app must stay up so it can explain itself.
  it("stays up, and names what is missing", async () => {
    await inBrokenProduction(async () => {
      const { getEnv, configProblems } = await import("@/lib/env");

      expect(() => getEnv()).not.toThrow();

      const problems = configProblems();
      expect(problems.map((p) => p.variable)).toEqual([
        "ADMIN_PASSCODE",
        "SESSION_SECRET",
      ]);
      expect(problems[0].message).toMatch(/at least 16 characters/i);
    });
  });

  it("is locked, not open", async () => {
    await inBrokenProduction(async () => {
      const { isOwner, requireOwner } = await import("@/lib/auth");
      expect(await isOwner()).toBe(false);
      await expect(requireOwner()).rejects.toThrow();
    });
  });

  // Without this, a dev-value SESSION_SECRET — which is public — would sign a
  // session cookie anyone could forge.
  it("will not sign anyone in, even with a passcode typed", async () => {
    await inBrokenProduction(async () => {
      const { signIn } = await import("@/lib/auth");
      const result = await signIn(PASSCODE, "1.2.3.4");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/not finished being set up/i);
        expect(result.message).toMatch(/ADMIN_PASSCODE/);
      }
    });
  });

  it("still refuses a genuinely malformed value at boot", async () => {
    const previous = process.env.NEXT_PUBLIC_APP_URL;
    resetEnvCache();
    process.env.NEXT_PUBLIC_APP_URL = "not-a-url";
    vi.resetModules();

    const { getEnv } = await import("@/lib/env");
    // A bad value is a mistake, not an unfinished setup, and still fails loudly.
    expect(() => getEnv()).toThrow(/NEXT_PUBLIC_APP_URL/);

    process.env.NEXT_PUBLIC_APP_URL = previous;
    resetEnvCache();
  });

  it("reports nothing in development, so a fresh clone just runs", async () => {
    resetEnvCache();
    vi.resetModules();
    const { configProblems } = await import("@/lib/env");
    expect(configProblems()).toEqual([]);
  });

  // `next build` runs with NODE_ENV=production. Demanding the passcode there
  // stops a clean checkout building at all — it breaks CI and the verification
  // step in DEPLOYMENT.md — while protecting nothing, because a build serves
  // no requests. The secrets stay required at runtime; see `isBuilding`.
  it("reports nothing during a build, which serves no requests", async () => {
    resetEnvCache();
    const previousEnv = process.env.NODE_ENV as string;
    const previousPhase = process.env.NEXT_PHASE;

    setNodeEnv("production");
    process.env.NEXT_PHASE = "phase-production-build";
    delete process.env.ADMIN_PASSCODE;
    process.env.SESSION_SECRET = "dev-only-insecure-session-secret-do-not-ship-abcdef";

    vi.resetModules();
    const { getEnv, configProblems } = await import("@/lib/env");
    expect(() => getEnv()).not.toThrow();
    // Demanding the secrets here would stop a clean checkout building at all,
    // and break CI, while protecting nothing.
    expect(configProblems()).toEqual([]);

    setNodeEnv(previousEnv);
    if (previousPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = previousPhase;
    resetEnvCache();
  });
});

describe("the share token", () => {
  it("matches only itself", async () => {
    const { shareTokenMatches, newShareToken } = await auth();
    const token = newShareToken();

    expect(shareTokenMatches(token, token)).toBe(true);
    expect(shareTokenMatches(`${token}x`, token)).toBe(false);
    expect(shareTokenMatches(token.slice(0, -1), token)).toBe(false);
    expect(shareTokenMatches("", token)).toBe(false);
  });

  it("issues a fresh, long, URL-safe token each time", async () => {
    const { newShareToken } = await auth();
    const a = newShareToken();
    const b = newShareToken();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
