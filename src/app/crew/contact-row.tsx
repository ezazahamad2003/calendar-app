"use client";

import { useState, useTransition } from "react";

import { setContactEmail } from "@/lib/schedule-actions";

/**
 * One trade, and its address.
 *
 * Saves on blur rather than behind a button. This page is a chore standing
 * between the contractor and a working app, and every extra tap is a reason to
 * leave a trade unreachable.
 */
export function ContactRow({
  id,
  name,
  email,
  jobs,
}: {
  id: string;
  name: string;
  email: string | null;
  jobs: number;
}) {
  const [value, setValue] = useState(email ?? "");
  const [saved, setSaved] = useState<string | null>(email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const commit = () => {
    const next = value.trim();
    if (next === (saved ?? "")) return;
    startTransition(async () => {
      const result = await setContactEmail(id, next);
      if (result.ok) {
        setSaved(next);
        setError(null);
      } else {
        setError(result.message);
      }
    });
  };

  return (
    <div className="contact-row">
      <div className="contact-who">
        <span className="contact-name">{name}</span>
        <span className="label">
          {jobs === 0 ? "no activities" : `${jobs} ${jobs === 1 ? "activity" : "activities"}`}
        </span>
      </div>

      <div className="contact-mail">
        <input
          className="input"
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          placeholder="nobody@yet"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          aria-label={`Email address for ${name}`}
          aria-invalid={error ? true : undefined}
        />
        <span className="contact-state" aria-live="polite">
          {pending ? "Saving…" : error ? "" : saved ? "Saved" : ""}
        </span>
      </div>

      {error && (
        <p className="note note-warn" style={{ gridColumn: "1 / -1", margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
