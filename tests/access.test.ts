import { describe, expect, it } from "vitest";

import { isOwner, newShareToken, requireOwner, shareTokenMatches } from "@/lib/auth";

/**
 * Access.
 *
 * There is no gate — see `src/lib/auth.ts`. What is still worth pinning down is
 * the share token, because it is now the only secret in the app, and the fact
 * that the open door is deliberate rather than an accident someone should
 * "fix" by making `isOwner()` return false.
 */

describe("the app is open", () => {
  it("treats every visitor as the contractor", async () => {
    expect(await isOwner()).toBe(true);
  });

  it("has a no-op write guard that does not throw", async () => {
    // The seam a gate goes back into. If this ever starts throwing, every
    // mutation in the app stops working, so it is worth a test.
    await expect(requireOwner()).resolves.toBeUndefined();
  });
});

describe("the share token", () => {
  it("matches only itself", () => {
    const token = newShareToken();

    expect(shareTokenMatches(token, token)).toBe(true);
    expect(shareTokenMatches(`${token}x`, token)).toBe(false);
    expect(shareTokenMatches(token.slice(0, -1), token)).toBe(false);
    expect(shareTokenMatches("", token)).toBe(false);
    expect(shareTokenMatches("nope", token)).toBe(false);
  });

  it("issues a fresh, long, URL-safe token each time", () => {
    const a = newShareToken();
    const b = newShareToken();

    expect(a).not.toBe(b);
    // 18 random bytes → 24 base64url characters. Long enough not to be walked,
    // short enough to survive being texted to a foreman.
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
