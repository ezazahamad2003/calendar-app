import { describe, expect, it } from "vitest";

import { composeNotifications, idempotencyKey } from "@/lib/mail/compose";
import { applyOperations } from "@/lib/ops/apply";
import { buildPreview } from "@/lib/ops/preview";
import { doc, ID } from "./fixture";
import type { ScheduleDoc } from "@/lib/store/types";

/**
 * Who gets told, what they read, and — just as importantly — who does not.
 *
 * The client's requirement was "when it changes, email them and say why". The
 * failure mode that requirement invites is emailing the wrong people, or
 * emailing about dates that do not exist, so most of these tests are about the
 * cases that must NOT send.
 */

/** The chart arrives with no addresses at all; give some out for testing. */
function withEmails(d: ScheduleDoc, ids: string[]): ScheduleDoc {
  return {
    ...d,
    contacts: d.contacts.map((c) =>
      ids.includes(c.id) ? { ...c, email: `${c.id}@example.test` } : c,
    ),
  };
}

function contactIdFor(d: ScheduleDoc, taskId: string): string {
  const id = d.tasks.find((t) => t.id === taskId)?.contactId;
  if (!id) throw new Error(`${taskId} has no contact`);
  return id;
}

describe("composing", () => {
  it("names the reason above the dates", () => {
    const base = doc();
    const d = withEmails(base, [contactIdFor(base, ID.fireRiser)]);
    const { moves } = applyOperations(d, [
      { type: "push_activity", taskId: ID.fireRiser, byDays: 2 },
    ]);

    const { notify } = composeNotifications(d, moves, "Crew did not arrive on site");
    expect(notify).toHaveLength(1);

    const body = notify[0].text;
    expect(body).toContain("Reason: Crew did not arrive on site");
    // The reason has to come before the dates, because it is what decides
    // whether the reader is annoyed or informed.
    expect(body.indexOf("Reason:")).toBeLessThan(body.indexOf("was "));
    expect(body).toContain("Install Fire Riser sprinkler");
    expect(body).toContain("Wed 12 Aug");
    expect(body).toContain("Fri 14 Aug");
  });

  it("sends one email per trade, not one per activity", () => {
    const base = doc();
    // Harvpro carries the riser, the pump test and the consultant inspection.
    const harvpro = contactIdFor(base, ID.fireRiser);
    const d = withEmails(base, [harvpro]);

    const { moves } = applyOperations(d, [
      { type: "push_activity", taskId: ID.fireRiser, byDays: 2 },
    ]);

    const { notify } = composeNotifications(d, moves, null);
    const forHarvpro = notify.filter((n) => n.contact.id === harvpro);
    expect(forHarvpro).toHaveLength(1);
    // …and that one email lists all three.
    expect(forHarvpro[0].tasks.length).toBeGreaterThan(1);
    expect(forHarvpro[0].subject).toMatch(/dates changed/);
  });

  it("marks a cascaded move as such, so the reason still makes sense", () => {
    const base = doc();
    const d = withEmails(base, [
      contactIdFor(base, ID.fireRiser),
      contactIdFor(base, ID.hydro),
    ]);
    const { moves } = applyOperations(d, [
      { type: "push_activity", taskId: ID.fireRiser, byDays: 2 },
    ]);

    const { notify } = composeNotifications(d, moves, "Riser crew did not show");
    const hydro = notify.find((n) => n.tasks.some((t) => t.id === ID.hydro));
    expect(hydro?.text).toContain("stay in step with the work before it");
  });
});

describe("who is not told", () => {
  it("skips a trade with no email address and records why", () => {
    const d = doc(); // nobody has an address
    const { moves } = applyOperations(d, [
      { type: "push_activity", taskId: ID.fireRiser, byDays: 2 },
    ]);

    const { notify, skipped } = composeNotifications(d, moves, "Crew did not show");
    expect(notify).toHaveLength(0);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].why).toMatch(/no email address/i);
  });

  it("never emails about an activity with no date", () => {
    const base = doc();
    const d = withEmails(base, [contactIdFor(base, ID.downspouts)]);

    // Taking the dates off is a real change, but there is nothing to tell a
    // subcontractor to turn up for.
    const { moves } = applyOperations(d, [
      { type: "clear_dates", taskId: ID.downspouts },
    ]);

    const { notify, skipped } = composeNotifications(d, moves, null);
    expect(notify).toHaveLength(0);
    expect(skipped.map((s) => s.why).join(" ")).toMatch(/no date/i);
  });

  it("says nothing when the dates did not actually change", () => {
    const base = doc();
    const d = withEmails(base, [contactIdFor(base, ID.fireRiser)]);
    const { moves } = applyOperations(d, [
      { type: "set_status", taskId: ID.fireRiser, status: "confirmed" },
    ]);
    const { notify } = composeNotifications(d, moves, null);
    expect(notify).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("produces the same key for the same change and recipient", () => {
    expect(idempotencyKey("change-1", "team-harvpro")).toBe(
      idempotencyKey("change-1", "team-harvpro"),
    );
    expect(idempotencyKey("change-1", "team-harvpro")).not.toBe(
      idempotencyKey("change-2", "team-harvpro"),
    );
  });
});

describe("the confirmation screen", () => {
  it("shows the cascade indented under what caused it", () => {
    const d = doc();
    const preview = buildPreview(d, {
      summary: "Push the fire riser back two days",
      reason: "Crew did not show",
      operations: [{ type: "push_activity", taskId: ID.fireRiser, byDays: 2 }],
    });

    expect(preview.empty).toBe(false);
    const direct = preview.lines.filter((l) => !l.cascaded);
    const cascaded = preview.lines.filter((l) => l.cascaded);
    expect(direct).toHaveLength(1);
    expect(direct[0].taskName).toBe("Install Fire Riser sprinkler");
    expect(direct[0].dayShift).toBe(2);
    expect(cascaded.length).toBeGreaterThan(0);
    // Direct changes are listed before the knock-on effects.
    expect(preview.lines[0].cascaded).toBe(false);
  });

  it("shows exactly the email that would be sent, and to whom", () => {
    const base = doc();
    const d = withEmails(base, [contactIdFor(base, ID.fireRiser)]);
    const preview = buildPreview(d, {
      summary: "Push it",
      reason: "Crew did not show",
      operations: [{ type: "push_activity", taskId: ID.fireRiser, byDays: 2 }],
    });

    expect(preview.recipients.length).toBeGreaterThan(0);
    expect(preview.recipients[0].email).toMatch(/@example\.test$/);
    expect(preview.recipients[0].body).toContain("Crew did not show");
  });

  it("lists who is affected but will not be told", () => {
    const d = doc();
    const preview = buildPreview(d, {
      summary: "Push it",
      reason: null,
      operations: [{ type: "push_activity", taskId: ID.fireRiser, byDays: 2 }],
    });

    expect(preview.recipients).toHaveLength(0);
    expect(preview.notNotified.length).toBeGreaterThan(0);
    expect(preview.notNotified.join(" ")).toMatch(/no email address/i);
  });

  it("uses a contact corrected in the same plan", () => {
    const base = doc();
    const contactId = contactIdFor(base, ID.fireRiser);

    const preview = buildPreview(base, {
      summary: "Fix the address and push it",
      reason: "Crew did not show",
      operations: [
        { type: "update_contact", contactId, email: "new@example.test" },
        { type: "push_activity", taskId: ID.fireRiser, byDays: 2 },
      ],
    });

    // Composed against the resulting document, so the address typed in this
    // same breath is the one used.
    expect(preview.recipients.some((r) => r.email === "new@example.test")).toBe(true);
  });
});
