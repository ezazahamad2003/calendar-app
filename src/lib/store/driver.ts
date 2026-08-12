import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Where the document is kept.
 *
 * Two drivers, chosen by whether a Blob token is present:
 *
 *   Vercel Blob   production. Persistent, and the only option that survives —
 *                 a serverless function's filesystem is thrown away between
 *                 invocations, so writing a file on Vercel silently loses the
 *                 schedule.
 *   Local file    development and tests. No account, no token, no network;
 *                 `pnpm dev` works on a fresh clone.
 *
 * The interface is deliberately tiny. Everything above it works on whole
 * documents, so there is nothing to express beyond get and put.
 */

export type StoredDoc = {
  /** Raw JSON text. Parsing belongs to the caller, which owns the schema. */
  body: string;
} | null;

export interface StoreDriver {
  readonly name: string;
  read(): Promise<StoredDoc>;
  write(body: string): Promise<void>;
}

/** The blob's pathname, and the local file's name. */
const DOC_KEY = "schedule.json";

// ── Local file ────────────────────────────────────────────────────────────────

export class FileDriver implements StoreDriver {
  readonly name = "file";
  readonly path: string;

  constructor(path = join(process.cwd(), "data", DOC_KEY)) {
    this.path = path;
  }

  async read(): Promise<StoredDoc> {
    try {
      return { body: await readFile(this.path, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(body: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the previous document intact
    // rather than a truncated one that fails to parse on next boot.
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, body, "utf8");
    await rename(temp, this.path);
  }
}

// ── Vercel Blob ───────────────────────────────────────────────────────────────

export class BlobDriver implements StoreDriver {
  readonly name = "blob";
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async read(): Promise<StoredDoc> {
    const { head } = await import("@vercel/blob");

    let url: string;
    try {
      const meta = await head(DOC_KEY, { token: this.token });
      url = meta.url;
    } catch (err) {
      // `head` throws BlobNotFoundError before the first write. That is the
      // empty state, not a failure — the caller seeds.
      if (err instanceof Error && err.name === "BlobNotFoundError") return null;
      throw err;
    }

    // Blob URLs sit behind a CDN, and the CDN will happily hand back the
    // schedule as it was several minutes ago. For a store that is read
    // immediately after every write, that reads as changes being discarded.
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Could not read the schedule from Blob storage (${response.status}).`);
    }
    return { body: await response.text() };
  }

  async write(body: string): Promise<void> {
    const { put } = await import("@vercel/blob");
    await put(DOC_KEY, body, {
      token: this.token,
      access: "public",
      contentType: "application/json",
      // Same pathname every time — this is one mutable document, not a history
      // of uploads. Without this the SDK appends a random suffix and every
      // write lands somewhere new.
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  }
}

let cached: StoreDriver | null = null;

/**
 * The driver for this environment.
 *
 * Blob when a token is present, file otherwise. The one case worth failing
 * loudly on is production without a token: that combination silently loses
 * every change the moment the function instance is recycled, and it would look
 * to the contractor like the app forgetting what he told it.
 */
export function storeDriver(): StoreDriver {
  if (cached) return cached;

  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (token) {
    cached = new BlobDriver(token);
    return cached;
  }

  if (process.env.VERCEL === "1" && process.env.NODE_ENV === "production") {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set. On Vercel the filesystem is discarded " +
        "between requests, so the schedule would be lost. Create a Blob store in " +
        "the Vercel dashboard (Storage → Create → Blob) and redeploy.",
    );
  }

  cached = new FileDriver();
  return cached;
}

/** Tests swap the driver; nothing else should. */
export function setStoreDriver(driver: StoreDriver | null): void {
  cached = driver;
}
