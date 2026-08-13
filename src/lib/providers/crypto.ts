import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { requireEnv } from "@/lib/env";

/**
 * AES-256-GCM for OAuth refresh tokens at rest. The key is the
 * 32-byte base64 TOKEN_ENCRYPTION_KEY validated at boot.
 *
 * Format: base64(iv[12] ‖ authTag[16] ‖ ciphertext), versioned with a "v1:"
 * prefix so a future key rotation can tell formats apart.
 */

const VERSION = "v1:";

function key(): Buffer {
  return Buffer.from(requireEnv("TOKEN_ENCRYPTION_KEY"), "base64");
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return VERSION + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptToken(stored: string): string {
  if (!stored.startsWith(VERSION)) {
    throw new Error("Unknown token format — was TOKEN_ENCRYPTION_KEY rotated without migrating?");
  }
  const raw = Buffer.from(stored.slice(VERSION.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
