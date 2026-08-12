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

describe("production refuses to boot without a passcode", () => {
  it("names the variable and says why", async () => {
    resetEnvCache();
    const previous = process.env.NODE_ENV as string;
    setNodeEnv("production");
    delete process.env.ADMIN_PASSCODE;

    vi.resetModules();
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/ADMIN_PASSCODE/);

    setNodeEnv(previous);
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
