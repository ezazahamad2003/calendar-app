import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Access.
 *
 * **There is no gate.** Whoever opens the app is treated as the contractor:
 * they can talk to it, edit it, and send email. This was his call — the
 * passcode was one more thing to do on a phone with wet hands, and the job is
 * one job for one person.
 *
 * What that means in practice, so nobody has to rediscover it:
 *
 *   · Anyone who finds the URL can change the schedule and spend OpenAI credit.
 *   · Once mail is configured, they can cause email to reach real
 *     subcontractors. Confirming still requires reading a diff and tapping a
 *     button, but the button is there for anyone.
 *
 * The read-only link is unaffected and still does its job: `/s/<token>` renders
 * the chart and nothing else, because that page does not import the assistant.
 * It remains the thing to hand to the crew.
 *
 * `requireOwner()` and `isOwner()` are kept deliberately rather than deleted.
 * They are the seam a gate would go back into — one function to change, not
 * fifteen call sites to find.
 */

/** Always true: the app is open. See the note above. */
export async function isOwner(): Promise<boolean> {
  return true;
}

/**
 * Where a write-permission check would go.
 *
 * A no-op today. Left in place at every call site that mutates, so restoring a
 * gate is a change to this function alone.
 */
export async function requireOwner(): Promise<void> {
  // Intentionally empty.
}

/** Compare without leaking how much of the value matched via timing. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which leaks only the length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Compare a URL's share token against the document's, in constant time. */
export function shareTokenMatches(given: string, expected: string): boolean {
  return equals(given, expected);
}

/** A fresh share token, for the "revoke the old link" button. */
export function newShareToken(): string {
  return randomBytes(18).toString("base64url");
}
