import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, readDoc, setStoreDriver, writeDoc } from "@/lib/store";
import { parseDoc } from "@/lib/store/schema";
import { doc, MemoryDriver } from "./fixture";

/**
 * The store that replaced Postgres.
 *
 * The interesting cases are the ones a database used to handle for us: a
 * malformed document, a broken reference, and two writers racing.
 */

let driver: MemoryDriver;

beforeEach(() => {
  driver = new MemoryDriver();
  setStoreDriver(driver);
});

afterEach(() => {
  setStoreDriver(null);
});

describe("reading", () => {
  it("seeds on first run and stores what it seeded", async () => {
    const first = await readDoc();
    expect(first.tasks.length).toBeGreaterThan(30);
    expect(driver.writes).toBe(1);

    // The share token must survive: returning a fresh seed each time would
    // hand out a different read-only link on every request.
    const second = await readDoc();
    expect(second.share.token).toBe(first.share.token);
    expect(driver.writes).toBe(1);
  });

  it("refuses to start on a document that is not JSON, without overwriting it", async () => {
    driver.body = "{ this is not json";
    await expect(readDoc()).rejects.toThrow(/not valid JSON/i);
    expect(driver.body).toBe("{ this is not json");
  });

  it("rejects a document whose dependency names a task that is gone", async () => {
    const d = doc();
    d.deps.push({
      predecessorId: "no-such-activity",
      successorId: d.tasks[0].id,
      depType: "FS",
      lagDays: 0,
    });
    expect(() => parseDoc(d)).toThrow(/unknown task/i);
  });

  it("rejects a document with an empty working week", async () => {
    const d = doc();
    // Nothing could ever be scheduled, and every date search would spin.
    (d.calendar as { workingDays: number[] }).workingDays = [];
    expect(() => parseDoc(d)).toThrow();
  });
});

describe("writing", () => {
  it("bumps the version and stamps the time", async () => {
    const before = await readDoc();
    const after = await writeDoc((current) => ({
      ...current,
      project: { ...current.project, address: "Suisun Valley Rd" },
    }));

    expect(after.version).toBe(before.version + 1);
    expect(after.project.address).toBe("Suisun Valley Rd");
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
  });

  it("refuses a mutation that sets its own version", async () => {
    await readDoc();
    await expect(
      writeDoc((current) => ({ ...current, version: 99 })),
    ).rejects.toThrow(/version/i);
  });

  it("never stores a document that fails its own schema", async () => {
    await readDoc();
    const good = driver.body;

    await expect(
      writeDoc((current) => ({
        ...current,
        tasks: [...current.tasks, { ...current.tasks[0], sectionId: "nowhere" }],
      })),
    ).rejects.toThrow(/unknown section/i);

    // The stored copy is untouched, so the next boot still works.
    expect(driver.body).toBe(good);
  });

  it("raises a conflict when another writer got there first", async () => {
    await readDoc();

    // Simulate the office laptop saving between our read and our write, on
    // every attempt, so the retries are exhausted.
    const original = driver.read.bind(driver);
    let calls = 0;
    driver.read = async () => {
      const result = await original();
      calls += 1;
      // The first read of each attempt is the caller's; the second is the
      // pre-write check, which is where the other writer's version shows up.
      if (result && calls % 2 === 0) {
        const parsed = JSON.parse(result.body) as { version: number };
        parsed.version += 1;
        return { body: JSON.stringify(parsed) };
      }
      return result;
    };

    await expect(
      writeDoc((current) => ({
        ...current,
        project: { ...current.project, address: "raced" },
      })),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
