"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";

import { enterPasscode } from "@/lib/schedule-actions";
import type { GateState } from "@/lib/schedule-actions";

/**
 * The passcode form.
 *
 * Navigation happens on the client after the action succeeds rather than by
 * redirecting inside it: the action sets a cookie, and a redirect thrown from
 * the same call can race the browser writing it, which lands you back on this
 * screen having typed the right code.
 */
export function GateForm({ next }: { next?: string }) {
  const router = useRouter();
  const [state, action] = useActionState<GateState, FormData>(enterPasscode, {
    error: null,
    submitted: false,
  });

  useEffect(() => {
    if (state.error === null && state.submitted) {
      router.replace(next && next.startsWith("/") ? next : "/");
      router.refresh();
    }
  }, [state, next, router]);

  return (
    <form action={action} className="stack" style={{ gap: 12 }}>
      <div className="field">
        <label className="label" htmlFor="passcode">
          Passcode
        </label>
        <input
          id="passcode"
          name="passcode"
          type="password"
          className="input"
          autoComplete="current-password"
          autoFocus
          required
          aria-describedby={state.error ? "gate-error" : undefined}
        />
      </div>

      {state.error && (
        <div className="note note-warn" id="gate-error" role="alert">
          {state.error}
        </div>
      )}

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn-primary" type="submit" disabled={pending}>
      {pending ? "Checking…" : "Open the schedule"}
    </button>
  );
}
