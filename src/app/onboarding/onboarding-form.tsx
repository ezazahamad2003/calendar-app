"use client";

import { useActionState, useEffect, useRef } from "react";

import { createOrg } from "./actions";
import type { FormState } from "@/app/(auth)/actions";

const EMPTY: FormState = {};

export function OnboardingForm({ timezones }: { timezones: string[] }) {
  const [state, action, pending] = useActionState(createOrg, EMPTY);

  // Preselect the browser's own zone.
  //
  // The select stays uncontrolled and this writes to the DOM node directly.
  // Holding it in state instead would mean either a setState inside an effect
  // (a cascading render, and what react-hooks/set-state-in-effect exists to
  // catch) or seeding state during render — which the server would resolve to
  // *its* timezone and hydration would then disagree with. The server renders
  // UTC selected; this nudges it once on the client.
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (selectRef.current && detected && timezones.includes(detected)) {
      selectRef.current.value = detected;
    }
  }, [timezones]);

  return (
    <div className="auth-card">
      <h1 className="auth-title">Set up your company</h1>
      <p className="auth-lede">
        This is the last step. You can change it later.
      </p>

      <form action={action} className="auth-form" noValidate>
        <label className="auth-label" htmlFor="name">
          Company name
        </label>
        <input
          className="auth-input"
          id="name"
          name="name"
          type="text"
          autoComplete="organization"
          required
          maxLength={120}
          placeholder="Northstar Builders"
          aria-describedby={state.fieldErrors?.name ? "name-error" : undefined}
        />
        {state.fieldErrors?.name ? (
          <p className="auth-field-error" id="name-error">
            {state.fieldErrors.name}
          </p>
        ) : null}

        <label className="auth-label" htmlFor="timezone">
          Timezone
        </label>
        <select
          className="auth-input"
          id="timezone"
          name="timezone"
          ref={selectRef}
          defaultValue="UTC"
          aria-describedby="timezone-hint"
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <p className="auth-hint" id="timezone-hint">
          Every schedule date is calculated in this zone. Pick where the work
          happens, not where you are.
        </p>

        <button className="auth-submit" type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create company"}
        </button>
      </form>

      <div aria-live="polite">
        {state.error ? (
          <p className="auth-error" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
