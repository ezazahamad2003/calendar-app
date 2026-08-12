"use server";

import { revalidatePath } from "next/cache";

import { newShareToken, requireOwner } from "@/lib/auth";
import { commitPlan } from "@/lib/ops/commit";
import { buildPreview } from "@/lib/ops/preview";
import { operationSchema } from "@/lib/ops/schema";
import type { Operation } from "@/lib/ops/schema";
import type { Preview } from "@/lib/ops/preview";
import { validatePlan } from "@/lib/ops/validate";
import { readDoc, writeDoc } from "@/lib/store";
import { z } from "zod";

/**
 * Edits made by hand rather than by voice.
 *
 * Voice is the headline, but the site is loud and sometimes he just wants to
 * tap a date. These go through exactly the same path — `applyOperations`,
 * `cascade`, `commitPlan` — so a typed change cascades and notifies identically
 * to a spoken one. Two write paths that behave differently is how a schedule
 * ends up with dates nobody can explain.
 *
 * `requireOwner()` is a no-op today: there is no gate. The calls stay because
 * they mark every mutation, and restoring a gate should mean editing one
 * function rather than hunting these down.
 */

// ── Editing ───────────────────────────────────────────────────────────────────

export type EditResult = {
  ok: boolean;
  message: string;
  simulated?: boolean;
};

/**
 * Preview a hand-made edit without applying it.
 *
 * The same rule as voice: a change that cascades must be read before it is
 * accepted. Dragging one bar can move six trades, and doing that silently is
 * how the chart stops matching what the crews were told.
 */
export async function previewEdit(operations: unknown): Promise<
  { ok: true; preview: Preview } | { ok: false; message: string }
> {
  await requireOwner();

  const parsed = z.array(operationSchema).max(20).safeParse(operations);
  if (!parsed.success) return { ok: false, message: "That edit is not valid." };

  const doc = await readDoc();
  const plan = { summary: "", reason: null, operations: parsed.data };
  const check = validatePlan(doc, { ...plan, confidence: "high" as const });
  if (!check.ok) return { ok: false, message: check.problems.join("\n") };

  return { ok: true, preview: buildPreview(doc, plan) };
}

export async function applyEdit(
  operations: unknown,
  options: { summary: string; reason: string | null; notify: boolean },
): Promise<EditResult> {
  await requireOwner();

  const parsed = z.array(operationSchema).max(20).safeParse(operations);
  if (!parsed.success) return { ok: false, message: "That edit is not valid." };
  if (parsed.data.length === 0) return { ok: false, message: "There was nothing to change." };

  const doc = await readDoc();
  const check = validatePlan(doc, {
    summary: options.summary,
    operations: parsed.data,
    confidence: "high",
  });
  if (!check.ok) {
    return {
      ok: false,
      message: `The schedule has changed since then:\n${check.problems.join("\n")}`,
    };
  }

  try {
    const result = await commitPlan({
      operations: parsed.data as Operation[],
      summary: options.summary,
      reason: options.reason?.trim() || null,
      source: "ui",
      transcript: null,
      notify: options.notify,
    });

    revalidatePath("/", "layout");

    const parts: string[] = [];
    const moved = result.change.moves.length;
    parts.push(moved === 1 ? "1 activity changed" : `${moved} activities changed`);
    if (result.sent > 0) parts.push(`${result.sent} notified`);
    if (result.failed > 0) parts.push(`${result.failed} failed to send`);

    return { ok: true, message: parts.join(", ") + ".", simulated: result.simulated };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "That change could not be saved.",
    };
  }
}

// ── Contacts ──────────────────────────────────────────────────────────────────

/**
 * Set a contact's email.
 *
 * Its own action rather than an operation because it changes no dates and so
 * belongs in no diff — and because it is the single most common piece of setup
 * the app needs. Every team came off the wall chart without an address, and
 * until one is filled in that trade cannot be told anything.
 */
export async function setContactEmail(
  contactId: string,
  email: string,
): Promise<{ ok: boolean; message: string }> {
  await requireOwner();

  const trimmed = email.trim();
  if (trimmed !== "" && !z.email().safeParse(trimmed).success) {
    return { ok: false, message: "That does not look like an email address." };
  }

  let found = false;
  await writeDoc((current) => {
    const contacts = current.contacts.map((c) => {
      if (c.id !== contactId) return c;
      found = true;
      return { ...c, email: trimmed === "" ? null : trimmed };
    });
    return { ...current, contacts };
  });

  if (!found) return { ok: false, message: "That contact no longer exists." };

  revalidatePath("/", "layout");
  return {
    ok: true,
    message: trimmed === "" ? "Address removed." : "Saved.",
  };
}

// ── Sharing ───────────────────────────────────────────────────────────────────

export async function setShareEnabled(enabled: boolean): Promise<void> {
  await requireOwner();
  await writeDoc((current) => ({ ...current, share: { ...current.share, enabled } }));
  revalidatePath("/", "layout");
}

/**
 * Issue a new share token, which immediately breaks the old link.
 *
 * The button for when the link has been forwarded somewhere it should not
 * have been — the only remedy available when the whole security model of the
 * read-only view is "you have the URL".
 */
export async function rotateShareToken(): Promise<{ token: string }> {
  await requireOwner();
  const token = newShareToken();
  await writeDoc((current) => ({ ...current, share: { ...current.share, token } }));
  revalidatePath("/", "layout");
  return { token };
}
