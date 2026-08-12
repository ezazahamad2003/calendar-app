"use client";

import { useState, useTransition } from "react";

import { rotateShareToken, setShareEnabled } from "@/lib/schedule-actions";

/**
 * The link the crew gets.
 *
 * Read-only by construction, not by permission check: the shared page renders
 * the chart and nothing else, and every action that writes calls
 * `requireOwner()` first. Whoever holds this link can look and cannot touch,
 * and cannot use the microphone.
 *
 * Its only secret is the token in the URL, so the honest control to offer is
 * the one that admits that: a button that issues a new one and breaks the old
 * link, for when it has been forwarded somewhere it should not have been.
 */
export function ShareCard({
  origin,
  token,
  enabled,
}: {
  origin: string;
  token: string;
  enabled: boolean;
}) {
  const [current, setCurrent] = useState(token);
  const [on, setOn] = useState(enabled);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const url = `${origin}/s/${current}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked on insecure origins and in some in-app browsers.
      // The input below is selectable, so there is always a way through.
      setCopied(false);
    }
  };

  return (
    <div className="card">
      <h2>Share with the crew</h2>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
        Anyone with this link sees the chart. They cannot change it, and they
        cannot use the microphone.
      </p>

      <label className="toggle" style={{ marginTop: 0, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            startTransition(() => setShareEnabled(next));
          }}
        />
        <span>{on ? "Link is live" : "Link is switched off"}</span>
      </label>

      <div className="share-row">
        <input
          className="input num"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Read-only link"
          style={{ fontSize: 12 }}
        />
        <button type="button" className="btn" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <button
        type="button"
        className="btn btn-ghost"
        style={{ marginTop: 8 }}
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              "Issue a new link? The one you have already sent out will stop working.",
            )
          ) {
            return;
          }
          startTransition(async () => {
            const result = await rotateShareToken();
            setCurrent(result.token);
          });
        }}
      >
        Issue a new link
      </button>
    </div>
  );
}
