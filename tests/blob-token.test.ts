import { afterEach, describe, expect, it } from "vitest";

import { resolveBlobToken } from "@/lib/store/driver";

/**
 * Finding the Blob token under whatever name Vercel gave it.
 *
 * This exists because of a real deployment that had a genuinely connected,
 * Private Blob store and still showed the "connect a store" screen: it was
 * connected through the Storage tab's "Connect Database" flow, which can
 * prefix the injected variable name to avoid colliding with a second store's
 * token — so the classic `BLOB_READ_WRITE_TOKEN` was never set, only something
 * like `CLAENDARAPP_BLOB_READ_WRITE_TOKEN`.
 */

const BLOB_KEYS = [
  "BLOB_READ_WRITE_TOKEN",
  "CLAENDARAPP_BLOB_READ_WRITE_TOKEN",
  "MYSTORE_BLOB_READ_WRITE_TOKEN",
];

afterEach(() => {
  for (const key of BLOB_KEYS) delete process.env[key];
});

describe("resolveBlobToken", () => {
  it("finds the classic name", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_classic";
    expect(resolveBlobToken()).toBe("vercel_blob_rw_classic");
  });

  it("finds a prefixed name when the classic one is absent", () => {
    process.env.CLAENDARAPP_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_prefixed";
    expect(resolveBlobToken()).toBe("vercel_blob_rw_prefixed");
  });

  it("prefers the classic name when both are present", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "classic";
    process.env.MYSTORE_BLOB_READ_WRITE_TOKEN = "prefixed";
    expect(resolveBlobToken()).toBe("classic");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveBlobToken()).toBeUndefined();
  });

  it("ignores an empty value the same way as an absent one", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "   ";
    expect(resolveBlobToken()).toBeUndefined();
  });

  it("does not match an unrelated variable that merely contains the words", () => {
    process.env.SOME_BLOB_READ_WRITE_TOKEN_NOTE = "not-a-token";
    expect(resolveBlobToken()).toBeUndefined();
  });
});
