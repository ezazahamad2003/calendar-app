"use client";

import { useActionState } from "react";

import { createContact } from "@/lib/org/actions";
import type { ActionState } from "@/lib/org/actions";

const EMPTY: ActionState = {};

export function NewContactForm() {
  const [state, action, pending] = useActionState(createContact, EMPTY);

  return (
    <details className="disclosure" open>
      <summary className="disclosure-summary">Add someone</summary>
      <form action={action} className="stack-form" noValidate>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Name</span>
            <input className="field-input" name="name" required maxLength={120} placeholder="Tom Brady Jr." />
            {state.fieldErrors?.name ? <span className="field-error">{state.fieldErrors.name}</span> : null}
          </label>
          <label className="field">
            <span className="field-label">Trade</span>
            <input className="field-input" name="trade" maxLength={60} placeholder="Framing" />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Company</span>
            <input className="field-input" name="company" maxLength={120} placeholder="Northstate Framing" />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input className="field-input" name="email" type="email" maxLength={200} />
            {state.fieldErrors?.email ? <span className="field-error">{state.fieldErrors.email}</span> : null}
          </label>
          <label className="field">
            <span className="field-label">Phone</span>
            <input className="field-input" name="phone" maxLength={40} />
          </label>
        </div>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add to crew"}
        </button>
        <div aria-live="polite">
          {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
        </div>
      </form>
    </details>
  );
}
