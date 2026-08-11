"use client";

import { useActionState } from "react";

import { createProject } from "@/lib/org/actions";
import type { ActionState } from "@/lib/org/actions";

const EMPTY: ActionState = {};

/** The fields themselves, so the same form works inline and on its own page. */
export function ProjectFields() {
  const [state, action, pending] = useActionState(createProject, EMPTY);

  return (
    <form action={action} className="stack-form" noValidate>
      <label className="field">
        <span className="field-label">Project name</span>
        <input
          className="field-input"
          name="name"
          required
          maxLength={160}
          placeholder="Hillcrest Residence"
          autoFocus
        />
        {state.fieldErrors?.name ? (
          <span className="field-error">{state.fieldErrors.name}</span>
        ) : null}
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Job #</span>
          <input className="field-input" name="job_number" maxLength={40} placeholder="26-014" />
        </label>
        <label className="field">
          <span className="field-label">Starts on</span>
          <input className="field-input" name="starts_on" type="date" />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Client</span>
        <input className="field-input" name="client_name" maxLength={120} />
      </label>
      <label className="field">
        <span className="field-label">Address</span>
        <input className="field-input" name="address" maxLength={200} />
      </label>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create project"}
      </button>
      <div aria-live="polite">
        {state.error ? (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Collapsed variant for the dashboard, where it is a secondary path. */
export function NewProjectForm() {
  return (
    <details className="disclosure">
      <summary className="disclosure-summary">Add a project</summary>
      <ProjectFields />
    </details>
  );
}
