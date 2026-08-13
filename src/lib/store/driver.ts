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

/**
 * Find the Blob read-write token, whatever Vercel decided to call it.
 *
 * The classic name is `BLOB_READ_WRITE_TOKEN`, injected when a store is
 * connected through the project's old direct "Connect" button. Connecting
 * through the newer unified **Connect Database** flow — the one the Storage
 * tab defaults to now — can prefix it instead, e.g. `MYSTORE_BLOB_READ_WRITE_TOKEN`,
 * specifically to avoid colliding with a second store's token
 * (`vercel integration resource connect --prefix`, documented under the CLI
 * integration reference). A deployment can therefore have a working, connected
 * Blob store and still have no variable named exactly `BLOB_READ_WRITE_TOKEN` —
 * which looks identical to not being connected at all, and is why this exists
 * rather than a single `process.env.BLOB_READ_WRITE_TOKEN` read.
 *
 * Falls back to scanning for anything ending `_BLOB_READ_WRITE_TOKEN`. One
 * store means one match in practice; if a second store is ever connected, name
 * the classic variable explicitly rather than leave this to guess between two.
 */
export function resolveBlobToken(): string | undefined {
  const exact = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (exact) return exact;

  const prefixed = Object.entries(process.env).find(
    ([key, value]) => key.endsWith("_BLOB_READ_WRITE_TOKEN") && value?.trim(),
  );
  return prefixed?.[1]?.trim();
}

/**
 * The store must be created **Private** in the Vercel dashboard, and this must
 * agree with it.
 *
 * The document carries every subcontractor's email address. A public blob is
 * readable by anyone who ever sees its URL, and nothing needs that: the app is
 * the only reader and it reads server-side with the token. Public would buy
 * nothing and leak the crew's contact details.
 */
const BLOB_ACCESS = "private" as const;

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
    const { get } = await import("@vercel/blob");

    // By pathname, not URL: `get` resolves the store from the token, so there
    // is no need to look the URL up first.
    //
    // `useCache: false` is load-bearing. Blob reads are served through a CDN,
    // and this document is read again immediately after every write — a cached
    // copy would read as the change having been discarded. This is the SDK's
    // own way of going to origin, and more reliable than putting `no-store` on
    // a hand-rolled fetch.
    const result = await get(DOC_KEY, {
      access: BLOB_ACCESS,
      useCache: false,
      token: this.token,
    });

    // Null before the first write — the empty state, not a failure. The caller
    // seeds.
    if (!result) return null;
    if (result.statusCode !== 200) {
      throw new Error(
        `Could not read the schedule from Blob storage (HTTP ${result.statusCode}).`,
      );
    }

    return { body: await new Response(result.stream).text() };
  }

  async write(body: string): Promise<void> {
    const { put } = await import("@vercel/blob");
    await put(DOC_KEY, body, {
      token: this.token,
      access: BLOB_ACCESS,
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

  const token = resolveBlobToken();
  if (token) {
    cached = new BlobDriver(token);
    return cached;
  }

  if (process.env.VERCEL === "1" && process.env.NODE_ENV === "production") {
    throw new Error(
      "No Blob read-write token was found (checked BLOB_READ_WRITE_TOKEN and " +
        "any *_BLOB_READ_WRITE_TOKEN). On Vercel the filesystem is discarded " +
        "between requests, so the schedule would be lost. Create a Blob store in " +
        "the Vercel dashboard (Storage → Create → Blob) and connect it to this " +
        "project, then redeploy.",
    );
  }

  cached = new FileDriver();
  return cached;
}

/** Tests swap the driver; nothing else should. */
export function setStoreDriver(driver: StoreDriver | null): void {
  cached = driver;
}
