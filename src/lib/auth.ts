import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { getEnv } from "@/lib/env";

/**
 * Who is allowed to change the schedule.
 *
 * There are exactly two kinds of visitor, and no accounts:
 *
 *   the contractor  knows one passcode, typed once on his phone and remembered
 *                   for a year. He can talk to it, edit it, and send email.
 *   everyone else   has the read-only link. They see the wall chart and
 *                   nothing else — no voice, no edits, no addresses.
 *
 * The previous build had email sign-in with no password, an org table and row
 * level security, for a single person running a single job. This is what
 * replaced all of it.
 *
 * The passcode is a shared secret on a public URL, so it is treated like one:
 * compared in constant time, never logged, never sent to the client, and
 * throttled on failure.
 */

const COOKIE = "foreman_owner";
/** He should type it once and then never again. */
const SESSION_DAYS = 365;

function secret(): string {
  return getEnv().SESSION_SECRET;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Compare without leaking how much of the value matched via timing. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which is itself a leak — but
  // only of the length, and hashing first would cost more than it buys here.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** `<expiresAtMs>.<signature>` — stateless, so there is no session table. */
function mintToken(now: Date): string {
  const expiresAt = now.getTime() + SESSION_DAYS * 86_400_000;
  const payload = String(expiresAt);
  return `${payload}.${sign(payload)}`;
}

function tokenIsValid(token: string | undefined, now: Date): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!equals(signature, sign(payload))) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

// ── Failed-attempt throttle ───────────────────────────────────────────────────
//
// In-process and therefore per-instance, which on Vercel means an attacker with
// many connections gets more tries than this suggests. It is not the defence —
// the passcode's length is, and `env.ts` enforces that. This exists so that a
// script pointed at one instance gets slow enough to be pointless, and so a
// human typo does not lock anybody out.

const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 60_000;

function throttleKey(ip: string): string {
  return ip || "unknown";
}

export function checkThrottle(ip: string, now = Date.now()): { retryInMs: number } | null {
  const key = throttleKey(ip);
  const record = attempts.get(key);
  if (!record) return null;

  // Still locked out.
  if (record.until > now) return { retryInMs: record.until - now };

  // A lockout that has run its course is forgotten, so a typo an hour ago does
  // not count towards the next one. `until === 0` means no lockout has been
  // reached yet — the running count must survive, or it can never reach the
  // threshold and the throttle never engages at all.
  if (record.until > 0) attempts.delete(key);

  return null;
}

function recordFailure(ip: string, now = Date.now()): void {
  const key = throttleKey(ip);
  const record = attempts.get(key) ?? { count: 0, until: 0 };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.until = now + LOCKOUT_MS;
    record.count = 0;
  }
  attempts.set(key, record);
}

// ── Public API ────────────────────────────────────────────────────────────────

export type SignInResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Check a passcode and, if it is right, remember the device.
 *
 * Returns a message rather than throwing: this is a form submission, and the
 * user needs to read what went wrong.
 */
export async function signIn(passcode: string, ip: string): Promise<SignInResult> {
  const throttled = checkThrottle(ip);
  if (throttled) {
    const seconds = Math.ceil(throttled.retryInMs / 1000);
    return {
      ok: false,
      message: `Too many tries. Wait ${seconds} second${seconds === 1 ? "" : "s"} and try again.`,
    };
  }

  const expected = getEnv().ADMIN_PASSCODE;
  if (!expected) {
    return {
      ok: false,
      message:
        "No passcode is configured on the server, so there is nothing to sign in " +
        "with. Set ADMIN_PASSCODE and redeploy.",
    };
  }

  if (!equals(passcode.trim(), expected)) {
    recordFailure(ip);
    return { ok: false, message: "That passcode is not right." };
  }

  const jar = await cookies();
  jar.set(COOKIE, mintToken(new Date()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/**
 * Is this request the contractor?
 *
 * Called at the top of every server action and every owner page. The proxy
 * redirects too, but that is for the address bar — this is the check that
 * actually decides, because a server action is reachable by POST without ever
 * passing through a page.
 */
export async function isOwner(): Promise<boolean> {
  // No passcode configured in development means a fresh clone runs without
  // setup. In production `env.ts` refuses to boot without one, so this branch
  // cannot open a deployed app up.
  if (!getEnv().ADMIN_PASSCODE) return process.env.NODE_ENV !== "production";

  const jar = await cookies();
  return tokenIsValid(jar.get(COOKIE)?.value, new Date());
}

/** Guard for anything that writes. Throws rather than returning a flag so a
 *  forgotten check cannot silently become an open door. */
export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) {
    throw new Error("You need to enter the passcode before you can change the schedule.");
  }
}

/** Compare a URL's share token against the document's, in constant time. */
export function shareTokenMatches(given: string, expected: string): boolean {
  return equals(given, expected);
}

/** A fresh share token, for the "revoke the old link" button. */
export function newShareToken(): string {
  return randomBytes(18).toString("base64url");
}
