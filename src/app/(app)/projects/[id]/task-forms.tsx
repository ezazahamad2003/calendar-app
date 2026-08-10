"use client";

import { useActionState } from "react";

import { addDependency, createTask } from "@/lib/org/actions";
import type { ActionState } from "@/lib/org/actions";

const EMPTY: ActionState = {};

export function NewTaskForm({
  projectId,
  contacts,
  tasks,
}: {
  projectId: string;
  contacts: { id: string; name: string }[];
  tasks: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(createTask, EMPTY);

  return (
    <details className="disclosure">
      <summary className="disclosure-summary">Add a task</summary>
      <form action={action} className="stack-form" noValidate>
        <input type="hidden" name="project_id" value={projectId} />
        <label className="field">
          <span className="field-label">Task</span>
          <input className="field-input" name="name" required maxLength={160} placeholder="Framing" />
          {state.fieldErrors?.name ? <span className="field-error">{state.fieldErrors.name}</span> : null}
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Trade</span>
            <input className="field-input" name="trade" maxLength={60} placeholder="Framing" />
          </label>
          <label className="field">
            <span className="field-label">Starts</span>
            <input className="field-input" name="start_date" type="date" />
          </label>
          <label className="field">
            <span className="field-label">Work days</span>
            <input
              className="field-input"
              name="duration_days"
              type="number"
              min={1}
              max={365}
              defaultValue={5}
            />
            {state.fieldErrors?.duration_days ? (
              <span className="field-error">{state.fieldErrors.duration_days}</span>
            ) : null}
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Assign to</span>
            <select className="field-input" name="assignee_id" defaultValue="">
              <option value="">Nobody yet</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">After (finish-to-start)</span>
            <select className="field-input" name="predecessor_id" defaultValue="">
              <option value="">No predecessor</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" name="is_milestone" /> Milestone (a date, not a duration)
        </label>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add task"}
        </button>
        <div aria-live="polite">
          {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
        </div>
      </form>
    </details>
  );
}

export function AddDependencyForm({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(addDependency, EMPTY);

  return (
    <details className="disclosure">
      <summary className="disclosure-summary">Link two tasks</summary>
      <form action={action} className="stack-form" noValidate>
        <input type="hidden" name="project_id" value={projectId} />
        <div className="field-row">
          <label className="field">
            <span className="field-label">This finishes…</span>
            <select className="field-input" name="predecessor_id" required defaultValue="">
              <option value="" disabled>
                Pick a task
              </option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">…then this starts</span>
            <select className="field-input" name="successor_id" required defaultValue="">
              <option value="" disabled>
                Pick a task
              </option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Lag (work days)</span>
            <input className="field-input" name="lag_days" type="number" min={-60} max={365} defaultValue={0} />
          </label>
        </div>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Linking…" : "Link tasks"}
        </button>
        <div aria-live="polite">
          {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
        </div>
      </form>
    </details>
  );
}
