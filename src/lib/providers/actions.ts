"use server";

import { revalidatePath } from "next/cache";

import { requireOwner } from "@/lib/auth";
import { writeDoc } from "@/lib/store";

/**
 * Disconnecting the mailbox.
 *
 * Connecting happens through the OAuth routes, not here — it is a redirect to
 * a consent screen, which a server action cannot do.
 */
export async function disconnectMailbox(): Promise<void> {
  await requireOwner();
  await writeDoc((current) => ({ ...current, connection: null }));
  revalidatePath("/", "layout");
}
