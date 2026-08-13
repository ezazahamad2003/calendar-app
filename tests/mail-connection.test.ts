import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvCache } from "@/lib/env";
import { parseDoc } from "@/lib/store/schema";
import { doc } from "./fixture";

/**
 * The connected mailbox: token encryption, the document shape, and which
 * mailer a given configuration ends up using.
 *
 * The refresh token is the one genuinely dangerous value in this app — it
 * grants send-as on a real mailbox — so most of this is about it never being
 * readable at rest and never being trusted after tampering.
 */

beforeEach(() => {
  resetEnvCache();
  vi.resetModules();
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  // Fixed key: tests must not depend on a developer's local secrets.
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  resetEnvCache();
});

describe("refresh-token encryption", () => {
  it("round-trips a token without storing it in the clear", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/providers/crypto");
    const token = "1//0eXaMpLe-refresh-token~payload";

    const stored = encryptToken(token);
    expect(stored).not.toContain(token);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decryptToken(stored)).toBe(token);
  });

  it("uses a fresh IV, so the same token encrypts differently each time", async () => {
    const { encryptToken } = await import("@/lib/providers/crypto");
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("refuses tampered ciphertext rather than returning garbage", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/providers/crypto");
    const stored = encryptToken("a-real-token");

    // Flip a byte in the payload. GCM's auth tag must catch it.
    const raw = Buffer.from(stored.slice(3), "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = `v1:${raw.toString("base64")}`;

    expect(() => decryptToken(tampered)).toThrow();
  });

  it("refuses a value written under a different key", async () => {
    const { encryptToken } = await import("@/lib/providers/crypto");
    const stored = encryptToken("a-real-token");

    resetEnvCache();
    vi.resetModules();
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const { decryptToken } = await import("@/lib/providers/crypto");

    expect(() => decryptToken(stored)).toThrow();
  });

  it("names the likely cause when the format is unrecognised", async () => {
    const { decryptToken } = await import("@/lib/providers/crypto");
    expect(() => decryptToken("not-versioned")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});

describe("the document carries the connection", () => {
  it("accepts a schedule that has one", () => {
    const d = {
      ...doc(),
      connection: {
        provider: "google" as const,
        email: "boss@example.test",
        providerUserId: "sub-123",
        refreshTokenEncrypted: "v1:abc",
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
        status: "active" as const,
        connectedAt: "2026-08-12T10:00:00.000Z",
        lastRefreshedAt: null,
      },
    };
    expect(parseDoc(d).connection?.email).toBe("boss@example.test");
  });

  // A stored schedule must never become unreadable because the app gained a
  // feature — the document on Blob predates mail connections entirely.
  it("accepts a schedule written before connections existed", () => {
    const older = { ...doc() } as Record<string, unknown>;
    delete older.connection;
    expect(parseDoc(older).connection).toBeNull();
  });

  it("rejects a connection with no token", () => {
    const d = {
      ...doc(),
      connection: {
        provider: "microsoft",
        email: null,
        providerUserId: null,
        refreshTokenEncrypted: "",
        scopes: [],
        status: "active",
        connectedAt: "2026-08-12T10:00:00.000Z",
        lastRefreshedAt: null,
      },
    };
    expect(() => parseDoc(d)).toThrow();
  });

  it("rejects an unknown provider", () => {
    const d = {
      ...doc(),
      connection: {
        provider: "yahoo",
        email: null,
        providerUserId: null,
        refreshTokenEncrypted: "v1:abc",
        scopes: [],
        status: "active",
        connectedAt: "2026-08-12T10:00:00.000Z",
        lastRefreshedAt: null,
      },
    };
    expect(() => parseDoc(d)).toThrow();
  });
});

describe("which provider is offered", () => {
  it("reports exactly what a half-configured provider is missing", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/google/callback";

    const { missingProviderEnv, providerIsConfigured } = await import(
      "@/lib/providers/catalog"
    );

    expect(missingProviderEnv("google")).toEqual(["GOOGLE_CLIENT_ID"]);
    expect(providerIsConfigured("google")).toBe(false);
  });

  it("is configured once all three are present", async () => {
    process.env.MS_CLIENT_ID = "id";
    process.env.MS_CLIENT_SECRET = "secret";
    process.env.MS_REDIRECT_URI = "http://localhost:3000/api/microsoft/callback";

    const { missingProviderEnv } = await import("@/lib/providers/catalog");
    expect(missingProviderEnv("microsoft")).toEqual([]);
  });

  it("counts a missing encryption key as missing, whichever provider", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    process.env.MS_CLIENT_ID = "id";
    process.env.MS_CLIENT_SECRET = "secret";
    process.env.MS_REDIRECT_URI = "http://localhost:3000/api/microsoft/callback";

    const { missingProviderEnv } = await import("@/lib/providers/catalog");
    // Without it the refresh token could not be stored safely at all.
    expect(missingProviderEnv("microsoft")).toContain("TOKEN_ENCRYPTION_KEY");
  });

  it("asks for the send scope and nothing more", async () => {
    const { providerConfig } = await import("@/lib/providers/catalog");

    const google = providerConfig("google").scopes;
    expect(google).toContain("gmail.send");
    // Reading the user's mail is a restricted scope and was never needed.
    expect(google).not.toContain("gmail.readonly");
    expect(google).not.toContain("calendar");

    const microsoft = providerConfig("microsoft").scopes;
    expect(microsoft).toContain("Mail.Send");
    expect(microsoft).toContain("offline_access");
    expect(microsoft).not.toContain("Calendars");
  });

  it("asks Google for offline access AND a fresh consent", async () => {
    const { providerConfig } = await import("@/lib/providers/catalog");
    const params = providerConfig("google").extraAuthParams;

    // Without both, a reconnect returns an access token and no refresh token,
    // and the connection dies silently an hour later.
    expect(params.access_type).toBe("offline");
    expect(params.prompt).toBe("consent");
  });
});
