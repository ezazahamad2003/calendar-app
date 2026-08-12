import "server-only";

import { storeDriver } from "./driver";
import { parseDoc } from "./schema";
import { seedDoc } from "./seed";
import type { ScheduleDoc } from "./types";

export * from "./types";
export { parseDoc } from "./schema";
export { seedDoc } from "./seed";
export { FileDriver, BlobDriver, setStoreDriver, storeDriver } from "./driver";
export type { StoreDriver } from "./driver";

/**
 * Reading and writing the one document.
 *
 * Everything above this layer takes a `ScheduleDoc`, returns a new one, and
 * never touches storage — which is what makes the schedule logic testable
 * without a network or a filesystem.
 */

/** Raised when two writers raced. The caller retries against fresh state. */
export class ConflictError extends Error {
  constructor() {
    super(
      "The schedule changed while you were working on it. " +
        "Your change was not saved — take another look and try again.",
    );
    this.name = "ConflictError";
  }
}

/**
 * The current document, seeding storage on first run.
 *
 * The seed is written back rather than merely returned, so the share token
 * generated with it is stable. Returning a fresh seed each time would hand out
 * a different read-only link on every request.
 */
export async function readDoc(): Promise<ScheduleDoc> {
  const driver = storeDriver();
  const stored = await driver.read();

  if (!stored) {
    const seeded = seedDoc();
    await driver.write(JSON.stringify(seeded, null, 2));
    return seeded;
  }

  let value: unknown;
  try {
    value = JSON.parse(stored.body);
  } catch {
    throw new Error(
      `The stored schedule is not valid JSON (via the ${driver.name} driver). ` +
        `It has not been overwritten — inspect it before the app can start.`,
    );
  }

  return parseDoc(value);
}

/**
 * Apply a change and store the result.
 *
 * Read-modify-write with a version check. The check is not paranoia about
 * scale — it is about the two writers this app really has: a phone in the
 * truck and a laptop in the office, both open on the same job. Last-write-wins
 * between those two silently reverts whichever change was typed first, and
 * nobody finds out until a crew turns up on the wrong day.
 *
 * `mutate` must be pure with respect to storage: it may be called again.
 */
export async function writeDoc(
  mutate: (current: ScheduleDoc) => ScheduleDoc,
  options: { retries?: number } = {},
): Promise<ScheduleDoc> {
  const driver = storeDriver();
  const retries = options.retries ?? 2;

  for (let attempt = 0; ; attempt += 1) {
    const current = await readDoc();
    const next = mutate(current);

    if (next.version !== current.version) {
      throw new Error(
        "A schedule mutation changed `version` itself. Leave it alone — " +
          "writeDoc owns it.",
      );
    }

    const stamped: ScheduleDoc = {
      ...next,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    // Validate before storing, never after. A document that fails its own
    // schema must not reach storage, or the next boot cannot read it at all.
    const validated = parseDoc(stamped);

    // Re-read and compare versions rather than trusting the copy we started
    // from. Blob has no conditional put, so this is the honest approximation:
    // it closes the window to the width of one request instead of the width of
    // a user's thinking time.
    const latest = await driver.read();
    if (latest) {
      const seen = (JSON.parse(latest.body) as { version?: number }).version;
      if (typeof seen === "number" && seen !== current.version) {
        if (attempt >= retries) throw new ConflictError();
        continue;
      }
    }

    await driver.write(JSON.stringify(validated, null, 2));
    return validated;
  }
}
