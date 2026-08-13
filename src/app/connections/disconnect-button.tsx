"use client";

import { useTransition } from "react";

import { disconnectMailbox } from "@/lib/providers/actions";

/**
 * Disconnect, with a confirm.
 *
 * Worth a confirm: once it is gone, schedule changes stop reaching anyone, and
 * the failure is silent from the contractor's side — no bounce, no error, just
 * subcontractors who were never told.
 */
export function DisconnectButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      onClick={() => {
        if (
          !window.confirm(
            `Disconnect ${label}? Schedule changes will stop being emailed until you connect a mailbox again.`,
          )
        ) {
          return;
        }
        startTransition(() => disconnectMailbox());
      }}
    >
      {pending ? "Disconnecting…" : "Disconnect"}
    </button>
  );
}
