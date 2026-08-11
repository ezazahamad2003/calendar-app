import { beforeAll, describe, expect, it } from "vitest";

/**
 * Token encryption round-trip. TOKEN_ENCRYPTION_KEY comes from the test env
 * below, not the developer's .env — tests must not depend on local secrets.
 */
beforeAll(() => {
  // openssl rand -base64 32 equivalent, fixed for determinism.
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret";
});

describe("refresh-token encryption", () => {
  it("round-trips a token", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/providers/crypto");
    const token = "0.AXEAsecret-refresh-token-payload~xyz";
    const stored = encryptToken(token);
    expect(stored).not.toContain(token);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decryptToken(stored)).toBe(token);
  });

  it("produces a different ciphertext every time (fresh IV)", async () => {
    const { encryptToken } = await import("@/lib/providers/crypto");
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects tampered ciphertext", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/providers/crypto");
    const stored = encryptToken("payload");
    const raw = Buffer.from(stored.slice(3), "base64");
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptToken("v1:" + raw.toString("base64"))).toThrow();
  });

  it("rejects an unversioned blob", async () => {
    const { decryptToken } = await import("@/lib/providers/crypto");
    expect(() => decryptToken("bm90LXZlcnNpb25lZA==")).toThrow(/format/i);
  });
});
