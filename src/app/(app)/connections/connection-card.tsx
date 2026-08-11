"use client";

import { useState, useTransition } from "react";

import { disconnectProvider, setPrimaryProvider } from "@/lib/providers/actions";
import type { ConnectionState } from "@/lib/providers/factory";

/**
 * One provider's card: its status, and the actions available in that status.
 *
 * Disconnect asks first. It is not destructive to the user's mail — nothing at
 * Outlook or Google is touched beyond dropping our grant — but it does stop
 * every future send without warning, which is worth one tap to confirm.
 */
export function ConnectionCard({
  state,
  canChoosePrimary,
}: {
  state: ConnectionState;
  canChoosePrimary: boolean;
}) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ error?: string }>) => {
    setError(null);
    start(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
      else setConfirming(false);
    });
  };

  return (
    <li className="connection-card">
      <div className="connection-head">
        <div>
          <h2 className="connection-name">{state.label}</h2>
          <p className="connection-detail">{state.detail}</p>
        </div>
        {state.isPrimary && state.connected ? (
          <span className="connection-badge">Sends from here</span>
        ) : null}
      </div>

      {!state.available ? (
        <p className="connection-status connection-status-off">
          Not set up in this environment.
        </p>
      ) : state.needsReauth ? (
        <p className="connection-status connection-status-warn">
          Sign-in expired{state.email ? ` for ${state.email}` : ""} — sends are
          paused until you reconnect.
        </p>
      ) : state.connected ? (
        <p className="connection-status connection-status-ok">
          Connected{state.email ? ` as ${state.email}` : ""}.
        </p>
      ) : (
        <p className="connection-status">Not connected.</p>
      )}

      {state.available ? (
        <div className="connection-actions">
          {!state.connected || state.needsReauth ? (
            <a className="btn" href={state.connectPath}>
              {state.needsReauth ? `Reconnect ${state.label}` : `Connect ${state.label}`}
            </a>
          ) : null}

          {state.connected && canChoosePrimary ? (
            <button
              className="btn btn--ghost"
              type="button"
              disabled={pending}
              onClick={() => run(() => setPrimaryProvider({ provider: state.provider }))}
            >
              Send from {state.label}
            </button>
          ) : null}

          {state.connected || state.needsReauth ? (
            confirming ? (
              <>
                <button
                  className="btn btn--danger"
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => disconnectProvider({ provider: state.provider }))}
                >
                  {pending ? "Disconnecting…" : "Yes, disconnect"}
                </button>
                <button
                  className="btn btn--ghost"
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                className="btn btn--ghost"
                type="button"
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                Disconnect
              </button>
            )
          ) : null}
        </div>
      ) : null}

      <div aria-live="polite">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}
